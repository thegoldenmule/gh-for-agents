// ghx ci why <pr|run:<id>|branch:<name>[@sha]> | --run <id|url> (02 §12; 03 M3.1, M3.2): why is CI red,
// in one call. A PR is read through the rollup for its head SHA [G-SHA]; a run through actions/runs/{id}
// and its jobs; a branch as every workflow's newest run on its head commit (src/ci/subject.ts). Each
// failing Actions job is diagnosed through the jobs API [G-LOGS] by src/ci/diagnose.ts (never
// `gh run view --log`). Red checks with no job log go to nonActionsFailing: commit statuses, other apps,
// and runs GitHub rejected before any job ran (src/ci/invalid-runs.ts). Green jobs whose ci.keySteps step
// was skipped go to suspicious.
import { z } from 'zod';
import { createDiagnoser, DIAGNOSIS_BUDGET_MS, DIAGNOSIS_MAX_JOBS, isDiagnosable } from '../../ci/diagnose.ts';
import { wildcard } from '../../ci/flake.ts';
import { invalidRunNext, isInvalidRunCheck } from '../../ci/invalid-runs.ts';
import { findSuspicious, Suspicious } from '../../ci/key-steps.ts';
import { readSubject } from '../../ci/subject.ts';
import { isRed } from '../../ci/summary.ts';
import { type CiTarget, type CiTargetKind, parseCiTarget, targetRepo } from '../../ci/wait/targets.ts';
import { defineCommand } from '../../core/command.ts';
import { GhxError } from '../../core/errors.ts';
import { repoSlug, sameRepo } from '../../gh/types.ts';
import { Check, CI_CAPS, CiSummary, FailingJob } from '../../schemas/ci.ts';
import { PrRef, Sha } from '../../schemas/common.ts';

/** Time kept back from the command deadline for the output, so a slow diagnosis ends partial, not in TIMEOUT. */
const OUTPUT_MARGIN_MS = 10_000;

const Output = z.object({
  /** owner/repo#N for a PR; null for a run or branch target. */
  ref: PrRef.nullable(),
  /** What was diagnosed: owner/repo#N, run:<id> or branch:<name>@<sha7>. */
  target: z.string(),
  headSha: Sha,
  ci: CiSummary,
  failing: z.array(FailingJob),
  nonActionsFailing: z.array(Check),
  suspicious: z.array(Suspicious),
  omitted: z.number().int().min(0),
  next: z.array(z.string()),
});

const Input = z.strictObject({
  target: z
    .string()
    .min(1)
    .optional()
    .describe('A PR (3198, owner/repo#3198, a PR URL), run:<id> (or a run URL), branch:<name> or branch:<name>@<sha>'),
  run: z.string().min(1).optional().describe('A workflow run id or URL (the same as run:<id>)'),
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

const USAGE_HINT = 'ghx ci why <pr|run:<id>|branch:<name>>, or ghx ci why --run <run-id|run-url> -R owner/repo.';
const TARGETS: readonly CiTargetKind[] = ['pr', 'run', 'branch'];

/** The target, from the positional or --run (an alias of run:<id>). */
function targetOf(input: z.output<typeof Input>): CiTarget {
  if (input.target !== undefined && input.run !== undefined) {
    throw new GhxError('VALIDATION', 'Pass a target or --run, not both.', {
      hint: USAGE_HINT,
      details: { issues: [{ path: 'run', code: 'exclusive', message: 'a target and --run were both given' }] },
    });
  }
  if (input.run !== undefined) {
    const raw = /^\d+$/.test(input.run) ? `run:${input.run}` : input.run;
    const t = tryParse(raw);
    if (t?.kind === 'run') return t;
    throw new GhxError('USAGE_BAD_SELECTOR', `'${input.run}' is not a workflow run.`, {
      hint: 'Use a run id (37948190914) or a run URL (https://github.com/o/r/actions/runs/37948190914).',
    });
  }
  if (input.target === undefined) {
    throw new GhxError('VALIDATION', 'ghx ci why needs a target: a PR, run:<id> or branch:<name>.', {
      hint: USAGE_HINT,
      details: { issues: [{ path: 'target', code: 'required', message: 'a target or --run is required' }] },
    });
  }
  return parseCiTarget(input.target, 'ci why', TARGETS);
}

function tryParse(raw: string): CiTarget | undefined {
  try {
    return parseCiTarget(raw, 'ci why', TARGETS);
  } catch {
    return undefined;
  }
}

export default defineCommand({
  name: ['ci', 'why'],
  summary: 'Why CI is red: failing jobs, step, tests, errors, log path, shared-with-main and flake',
  description:
    'Diagnoses the failing checks on a PR head, one workflow run (run:<id>; --run is the same), or a branch head ' +
    "(branch:<name>: every workflow's newest run on the branch's head commit) in one call. Logs come from the jobs " +
    'API, so a finished job is diagnosed while the rest of its run is still going. Full logs are written to files ' +
    '(logPath). Green jobs whose ci.keySteps step was skipped are listed in suspicious.',
  kind: 'read',
  input: Input,
  positionals: ['target'],
  output: Output,
  needs: { repo: 'inferred', config: 'optional' },
  timeout: { defaultMs: 120_000, maxMs: 300_000 },
  replaces: [
    'gh run view <run-id> --log',
    'gh run view <run-id> --log-failed',
    'gh api repos/{o}/{r}/actions/jobs/{id}/logs',
  ],
  examples: [
    { argv: 'ghx ci why 3301 -R powerhouse-inc/powerhouse', note: 'Diagnose the failing checks on PR #3301' },
    { argv: "ghx ci why owner/repo#12 --job 'Test*'", note: 'Only jobs whose name starts with Test' },
    { argv: 'ghx ci why run:37948190914 -R owner/repo', note: 'One workflow run, without a PR' },
    { argv: 'ghx ci why branch:main -R owner/repo', note: 'Is main red, and why: every workflow on its head' },
    { argv: 'ghx ci why 12 --no-compare-main', note: 'Skip the comparison with the default branch' },
  ],
  async run(input, ctx) {
    const target = targetOf(input);
    const resolved = await ctx.repo({ ref: targetRepo(target) });
    const { repo } = resolved;
    if (resolved.source !== 'cwd' && resolved.cwdRepo && !sameRepo(resolved.cwdRepo, repo)) {
      ctx.warn({
        code: 'CWD_REPO_MISMATCH',
        message: `Reading ${repoSlug(repo)}; the cwd checkout is ${repoSlug(resolved.cwdRepo)}.`,
      });
    }
    const ci = (await ctx.config({ ref: repo })).config.ci;
    const s = await readSubject(ctx, resolved, target, ci.ignore);

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
    // A rejected run has no job, so no key step to check.
    const runIds = new Set(
      s.checks.flatMap((c) => (c.kind === 'actions' && c.runId !== null && !isInvalidRunCheck(c) ? [c.runId] : [])),
    );
    const { suspicious } = await findSuspicious({
      gh: ctx.gh,
      repo,
      runIds: [...runIds],
      keySteps: ci.keySteps ?? [],
      jobsByRun: s.jobsByRun,
      warn: ctx.warn,
    });

    const next: string[] = invalidRunNext(red.filter(isInvalidRunCheck));
    if (s.summary.state === 'pending') next.push(`ghx ci wait ${s.arg}`);
    // A branch spans several runs, and ci rerun takes a PR or one run: one suggestion per run.
    const flakyRuns = [...new Set(d.jobs.filter((j) => j.flake.candidate).map((j) => j.runId))];
    if (target.kind === 'branch') {
      for (const runId of flakyRuns) next.push(`ghx ci rerun run:${runId} -R ${repoSlug(repo)} --flaky`);
    } else if (flakyRuns.length > 0) next.push(`ghx ci rerun ${s.arg} --flaky`);
    if (d.omitted > 0) next.push(`ghx ci why ${s.arg} --job '<name>'`);
    return {
      ref: s.ref,
      target: s.target,
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
