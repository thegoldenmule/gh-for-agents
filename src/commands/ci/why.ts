// ghx ci why <pr> | --run <id|url> (02 §12; 03 M3.1, M3.2): why is CI red, in one call. A PR is read
// through the rollup for its head SHA [G-SHA]; a run through actions/runs/{id} and its jobs. Each
// failing Actions job is diagnosed through the jobs API [G-LOGS] by src/ci/diagnose.ts (never
// `gh run view --log`). Red checks outside Actions go to nonActionsFailing; green jobs whose
// ci.keySteps step was skipped go to suspicious.
import { z } from 'zod';
import { checkRunBucket, checkRunStatus, ignoreRuleFor, type WorkflowRunInfo } from '../../ci/checks.ts';
import { createDiagnoser, DIAGNOSIS_BUDGET_MS, DIAGNOSIS_MAX_JOBS, isDiagnosable } from '../../ci/diagnose.ts';
import { wildcard } from '../../ci/flake.ts';
import { type ActionsJob, fetchRun, listRunJobs } from '../../ci/github.ts';
import { findSuspicious, Suspicious } from '../../ci/key-steps.ts';
import { fetchCiSnapshot, snapshotSummary } from '../../ci/snapshot.ts';
import { isRed, summariseCi } from '../../ci/summary.ts';
import { type Context, defineCommand } from '../../core/command.ts';
import { GhxError } from '../../core/errors.ts';
import type { Gh } from '../../gh/index.ts';
import { formatPrRef, parseTargetRef, type TargetRef, tryParseTargetRef } from '../../gh/refs.ts';
import { enrichNotFound, type ResolvedRepo } from '../../gh/repo.ts';
import { type RepoRef, repoSlug, sameRepo } from '../../gh/types.ts';
import { Check, CI_CAPS, CiSummary, FailingJob } from '../../schemas/ci.ts';
import { PrRef, Sha } from '../../schemas/common.ts';

/** Time kept back from the command deadline for the output, so a slow diagnosis ends partial, not in TIMEOUT. */
const OUTPUT_MARGIN_MS = 10_000;

const Output = z.object({
  /** null for --run. */
  ref: PrRef.nullable(),
  headSha: Sha,
  ci: CiSummary,
  failing: z.array(FailingJob),
  nonActionsFailing: z.array(Check),
  suspicious: z.array(Suspicious),
  omitted: z.number().int().min(0),
  next: z.array(z.string()),
});

const Input = z.strictObject({
  pr: z.string().min(1).optional().describe('PR: 3198, #3198, owner/repo#3198 or a PR URL'),
  run: z.string().min(1).optional().describe('A workflow run id or URL, instead of a PR'),
  job: z.array(z.string().min(1)).optional().describe('Only failing jobs whose name matches (repeatable; * and ?)'),
  compareMain: z
    .boolean()
    .default(true)
    .describe('Compare failures with the default branch; --no-compare-main skips it'),
  maxJobs: z
    .number()
    .int()
    .min(1)
    .max(DIAGNOSIS_MAX_JOBS)
    .default(DIAGNOSIS_MAX_JOBS)
    .describe('Failing jobs to diagnose'),
  excerptLines: z
    .number()
    .int()
    .min(1)
    .max(CI_CAPS.excerptLinesMax)
    .default(CI_CAPS.excerptLinesDefault)
    .describe('Log excerpt lines per job'),
});

type IgnoreRules = Parameters<typeof ignoreRuleFor>[1];
type Selector = { kind: 'pr'; target: TargetRef } | { kind: 'run'; runId: number; repo?: RepoRef | undefined };

const USAGE_HINT = 'ghx ci why <pr>, or ghx ci why --run <run-id|run-url> -R owner/repo.';

function selectorOf(input: z.output<typeof Input>): Selector {
  if (input.pr !== undefined && input.run !== undefined) {
    throw new GhxError('VALIDATION', 'Pass a PR or --run, not both.', {
      hint: USAGE_HINT,
      details: { issues: [{ path: 'run', code: 'exclusive', message: 'a PR and --run were both given' }] },
    });
  }
  if (input.run !== undefined) {
    if (/^\d+$/.test(input.run)) return { kind: 'run', runId: Number(input.run) };
    const t = tryParseTargetRef(input.run);
    if (t?.kind === 'run') return { kind: 'run', runId: t.number, repo: t.repo };
    if (t?.kind === 'job' && t.runId !== undefined) return { kind: 'run', runId: t.runId, repo: t.repo };
    throw new GhxError('USAGE_BAD_SELECTOR', `'${input.run}' is not a workflow run.`, {
      hint: 'Use a run id (37948190914) or a run URL (https://github.com/o/r/actions/runs/37948190914).',
    });
  }
  if (input.pr === undefined) {
    throw new GhxError('VALIDATION', 'ghx ci why needs a PR or --run.', {
      hint: USAGE_HINT,
      details: { issues: [{ path: 'pr', code: 'required', message: 'a PR or --run is required' }] },
    });
  }
  const target = parseTargetRef(input.pr);
  // A run or job URL in the PR slot means that run.
  if (target.kind === 'run') return { kind: 'run', runId: target.number, repo: target.repo };
  if (target.kind === 'job' && target.runId !== undefined)
    return { kind: 'run', runId: target.runId, repo: target.repo };
  return { kind: 'pr', target };
}

/** What the diagnosis needs, from either a PR rollup or one run. */
interface Subject {
  ref: string | null;
  headSha: string;
  defaultBranch: string;
  summary: CiSummary;
  checks: Check[];
  runs: Record<string, Pick<WorkflowRunInfo, 'workflowId'>>;
  /** Job lists already read (--run), so key steps need no second call. */
  jobsByRun: Map<number, ActionsJob[]>;
}

async function prSubject(ctx: Context, resolved: ResolvedRepo, number: number, ignore: IgnoreRules): Promise<Subject> {
  let snapshot: Awaited<ReturnType<typeof fetchCiSnapshot>>;
  try {
    snapshot = await fetchCiSnapshot({ gh: ctx.gh, repo: resolved.repo, number, ignore, warn: ctx.warn });
  } catch (e) {
    throw enrichNotFound(e, resolved, `PR #${number}`);
  }
  return {
    ref: formatPrRef(resolved.repo, snapshot.number),
    headSha: snapshot.headSha,
    defaultBranch: snapshot.defaultBranch,
    summary: snapshotSummary(snapshot),
    checks: snapshot.checks,
    runs: snapshot.runs,
    jobsByRun: new Map(),
  };
}

const RepoInfo = z.object({ default_branch: z.string() });

async function defaultBranchOf(gh: Gh, repo: RepoRef): Promise<string> {
  const r = await gh.api({ path: 'repos/{owner}/{repo}', repo }, RepoInfo, { notFound: 'REPO_NOT_FOUND' });
  if (r.notModified) throw new Error('unreachable: unconditional request returned 304');
  return r.data.default_branch;
}

/** A jobs-API row as a Check (the shape the rollup gives a PR). */
export function jobCheck(j: ActionsJob, repo: RepoRef): Check {
  return {
    name: j.name,
    workflow: j.workflow_name ?? null,
    kind: 'actions',
    bucket: checkRunBucket(j.status, j.conclusion),
    status: checkRunStatus(j.status),
    conclusion: j.conclusion,
    required: false,
    runId: j.run_id,
    jobId: j.id,
    attempt: j.run_attempt ?? null,
    url: j.html_url ?? `https://${repo.host}/${repo.owner}/${repo.name}/actions/runs/${j.run_id}/job/${j.id}`,
    startedAt: j.started_at ?? null,
    completedAt: j.completed_at ?? null,
  };
}

async function runSubject(ctx: Context, resolved: ResolvedRepo, runId: number, ignore: IgnoreRules): Promise<Subject> {
  const { repo } = resolved;
  let run: Awaited<ReturnType<typeof fetchRun>>;
  let jobs: ActionsJob[];
  try {
    run = await fetchRun({ gh: ctx.gh, repo, runId });
    jobs = await listRunJobs({ gh: ctx.gh, repo, runId });
  } catch (e) {
    throw enrichNotFound(e, resolved, `Run ${runId}`);
  }
  const all = jobs.map((j) => jobCheck(j, repo));
  return {
    ref: null,
    headSha: run.head_sha,
    defaultBranch: await defaultBranchOf(ctx.gh, repo),
    summary: summariseCi({
      headSha: run.head_sha,
      checks: all.filter((c) => !ignoreRuleFor(c, ignore)),
      ignored: all.filter((c) => ignoreRuleFor(c, ignore)).map((c) => c.name),
    }),
    checks: all.filter((c) => !ignoreRuleFor(c, ignore)),
    runs: { [String(runId)]: { workflowId: run.workflow_id } },
    jobsByRun: new Map([[runId, jobs]]),
  };
}

export default defineCommand({
  name: ['ci', 'why'],
  summary: 'Why CI is red: failing jobs, step, tests, errors, log path, shared-with-main and flake',
  description:
    'Diagnoses the failing checks on a PR head (or one workflow run, --run) in one call. Logs come from the jobs ' +
    'API, so a finished job is diagnosed while the rest of its run is still going. Full logs are written to files ' +
    '(logPath). Green jobs whose ci.keySteps step was skipped are listed in suspicious.',
  kind: 'read',
  input: Input,
  positionals: ['pr'],
  output: Output,
  needs: { repo: 'inferred', config: 'optional' },
  timeout: { defaultMs: 120_000, maxMs: 300_000 },
  replaces: ['gh run view --log', 'gh run view --log-failed', 'gh api repos/{o}/{r}/actions/jobs/{id}/logs'],
  examples: [
    { argv: 'ghx ci why 3301 -R powerhouse-inc/powerhouse', note: 'Diagnose the failing checks on PR #3301' },
    { argv: "ghx ci why owner/repo#12 --job 'Test*'", note: 'Only jobs whose name starts with Test' },
    { argv: 'ghx ci why --run 37948190914 -R owner/repo', note: 'One workflow run, without a PR' },
    { argv: 'ghx ci why 12 --no-compare-main', note: 'Skip the comparison with the default branch' },
  ],
  async run(input, ctx) {
    const sel = selectorOf(input);
    const resolved = await ctx.repo({ ref: sel.kind === 'pr' ? sel.target.repo : sel.repo });
    const { repo } = resolved;
    if (resolved.source !== 'cwd' && resolved.cwdRepo && !sameRepo(resolved.cwdRepo, repo)) {
      ctx.warn({
        code: 'CWD_REPO_MISMATCH',
        message: `Reading ${repoSlug(repo)}; the cwd checkout is ${repoSlug(resolved.cwdRepo)}.`,
      });
    }
    const ci = (await ctx.config({ ref: repo })).config.ci;
    const s =
      sel.kind === 'pr'
        ? await prSubject(ctx, resolved, sel.target.number, ci.ignore)
        : await runSubject(ctx, resolved, sel.runId, ci.ignore);

    const red = s.checks.filter(isRed);
    const patterns = (input.job ?? []).map(wildcard);
    const candidates = red
      .filter(isDiagnosable)
      .filter((c) => patterns.length === 0 || patterns.some((p) => p.test(c.name)));
    const diagnoser = createDiagnoser({
      gh: ctx.gh,
      artifacts: ctx.artifacts,
      clock: ctx.clock,
      repo,
      headSha: s.headSha,
      defaultBranch: s.defaultBranch,
      runs: s.runs,
      config: ci,
      compareMain: input.compareMain,
      excerptLines: input.excerptLines,
      warn: ctx.warn,
    });
    const remaining = ctx.deadline === undefined ? Infinity : ctx.deadline - ctx.clock.monotonic() - OUTPUT_MARGIN_MS;
    const d = await diagnoser.diagnose(candidates, {
      maxJobs: input.maxJobs,
      budgetMs: Math.max(0, Math.min(DIAGNOSIS_BUDGET_MS, remaining)),
    });
    const runIds = new Set(s.checks.flatMap((c) => (c.kind === 'actions' && c.runId !== null ? [c.runId] : [])));
    const { suspicious } = await findSuspicious({
      gh: ctx.gh,
      repo,
      runIds: [...runIds],
      keySteps: ci.keySteps ?? [],
      jobsByRun: s.jobsByRun,
      warn: ctx.warn,
    });

    const self = s.ref ?? `--run ${sel.kind === 'run' ? sel.runId : ''} -R ${repoSlug(repo)}`;
    const next: string[] = [];
    if (s.ref && s.summary.state === 'pending') next.push(`ghx ci wait ${s.ref}`);
    if (s.ref && d.jobs.some((j) => j.flake.candidate)) next.push(`ghx ci rerun ${s.ref} --flaky`);
    if (d.omitted > 0) next.push(`ghx ci why ${self} --job '<name>'`);
    return {
      ref: s.ref,
      headSha: s.headSha,
      ci: s.summary,
      failing: d.jobs,
      nonActionsFailing: red.filter((c) => !isDiagnosable(c)),
      suspicious,
      omitted: d.omitted,
      next,
    };
  },
});
