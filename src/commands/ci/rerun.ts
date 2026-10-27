// ghx ci rerun <pr|run:<id>> (02 §13.1; 03 M5.1): rerun the failed jobs of completed runs, within
// ci.maxRerunAttempts. A PR: the runs on its head H, read through the rollup [G-SHA], then GET
// actions/runs/{id} per failing run. A run (run:<id>, a run or job URL): that run alone, read once with its
// jobs; the run id is the pin (one run, one commit), so there is no head to move and --expect-head checks
// the run's commit. Then (--flaky) the diagnosis engine's flake signals → POST rerun-failed-jobs or
// jobs/{id}/rerun (--dry-run halts at the first). The selection rules and the error precedence live in
// src/ci/rerun/plan.ts.
import { z } from 'zod';
import { createDiagnoser, DIAGNOSIS_BUDGET_MS, DIAGNOSIS_MAX_JOBS } from '../../ci/diagnose.ts';
import { wildcard } from '../../ci/flake.ts';
import { type ActionsRun, fetchRun } from '../../ci/github.ts';
import { assertExpectHead, parseCommandOverrides } from '../../ci/rerun/overrides.ts';
import {
  classifyRuns,
  DEFAULT_MAX_RERUN_ATTEMPTS,
  failingRunIds,
  nothingRerunnable,
  type RerunAction,
  type Skipped,
  selectJobs,
} from '../../ci/rerun/plan.ts';
import { readSubject } from '../../ci/subject.ts';
import { parseCiTarget, targetRepo } from '../../ci/wait/targets.ts';
import { defineCommand } from '../../core/command.ts';
import { rethrowControlFlow } from '../../core/control-flow.ts';
import { GhxError } from '../../core/errors.ts';
import { GhFailure } from '../../gh/index.ts';
import { githubMessage } from '../../pr/feedback-writes/post.ts';
import { Flake } from '../../schemas/ci.ts';
import { PrRef, Sha, ShaInput } from '../../schemas/common.ts';

/** Time kept back from the command deadline for the POSTs and the output. */
const OUTPUT_MARGIN_MS = 15_000;

const Input = z.strictObject({
  target: z
    .string()
    .min(1)
    .describe('A PR (3198, owner/repo#3198, a PR URL), or run:<id> (or a run or job URL) for one workflow run'),
  job: z.array(z.string().min(1)).optional().describe('Only failed jobs whose name matches (repeatable; * and ?)'),
  flaky: z.boolean().default(false).describe('Only jobs whose flake score is medium or higher'),
  expectHead: ShaInput.optional().describe(
    "Refuse with HEAD_MOVED unless the head (for run:<id>, the run's commit) is this SHA",
  ),
  override: z.array(z.string().min(1)).optional().describe('RERUN_LIMIT: rerun past ci.maxRerunAttempts'),
  reason: z.string().optional().describe('Why the override is allowed (who asked); required with --override'),
});

const SkipReason = z.enum(['RUN_IN_PROGRESS', 'RERUN_LIMIT', 'NOT_FLAKY', 'DEFERRED', 'REFUSED']);

const Output = z.object({
  /** owner/repo#N for a PR; null for run:<id>. */
  ref: PrRef.nullable(),
  /** What was rerun: owner/repo#N or run:<id>. */
  target: z.string(),
  headSha: Sha,
  rerun: z.array(
    z.object({
      runId: z.number().int(),
      workflow: z.string(),
      method: z.enum(['failed-jobs', 'job']),
      jobs: z.array(z.string()),
      previousAttempt: z.number().int(),
      url: z.string(),
      flake: z.array(Flake.extend({ job: z.string(), jobId: z.number().int() })).nullable(),
    }),
  ),
  skipped: z.array(
    z.object({
      runId: z.number().int(),
      workflow: z.string(),
      reason: SkipReason,
      attempt: z.number().int().nullable(),
      message: z.string().optional(),
      jobs: z.array(z.string()).optional(),
    }),
  ),
  overrides: z.array(z.object({ code: z.literal('RERUN_LIMIT'), reason: z.string() })),
  next: z.array(z.string()),
});

const ALREADY_RUNNING = /already running/i;

export default defineCommand({
  name: ['ci', 'rerun'],
  summary: 'Rerun failed jobs of completed runs on the PR head, or of one run (--flaky: only likely-flaky jobs)',
  description:
    'Reruns the failed jobs of completed Actions runs for the current PR head, or of one run (run:<id>, for CI ' +
    'without a PR, such as main). The run id pins a run target to its commit; --expect-head checks it. Runs still in progress are skipped ' +
    '(RUN_IN_PROGRESS) and runs at ci.maxRerunAttempts (RERUN_LIMIT, default 3). --job reruns matching jobs; ' +
    '--flaky only jobs with flake evidence (NO_FLAKY_CANDIDATES if none), never widening to a real failure: ' +
    'one job per run at a time, the rest DEFERRED until that run completes. A rerun reuses the original merge ' +
    'ref: after a base change, use ghx ci retrigger.',
  kind: 'write',
  input: Input,
  positionals: ['target'],
  output: Output,
  needs: { repo: 'inferred', config: 'optional' },
  timeout: { defaultMs: 120_000, maxMs: 300_000 },
  replaces: ['gh run rerun <run-id>', 'gh run rerun <run-id> --failed', 'gh run rerun <run-id> --job'],
  examples: [
    { argv: 'ghx ci rerun powerhouse-inc/powerhouse#3301 --flaky', note: 'Rerun only the jobs that look flaky' },
    { argv: 'ghx ci rerun 3301', note: 'Rerun every failed job of the completed runs on the head' },
    { argv: "ghx ci rerun 3301 --job 'Test Reactor*'", note: 'Rerun matching failed jobs' },
    { argv: 'ghx ci rerun run:40345582950 -R owner/repo', note: 'Rerun the failed jobs of one run (main, no PR)' },
    {
      argv: 'ghx ci rerun 3301 --override RERUN_LIMIT --reason "user asked in chat"',
      note: 'Past ci.maxRerunAttempts',
    },
  ],
  async run(input, ctx) {
    const target = parseCiTarget(input.target, 'ci rerun', ['pr', 'run']);
    const overrides = parseCommandOverrides(input.override, input.reason, ['RERUN_LIMIT'] as const);
    const resolved = await ctx.repo({ ref: targetRepo(target) });
    const { repo } = resolved;
    const ci = (await ctx.config({ ref: repo })).config.ci;
    const subject = await readSubject(ctx, resolved, target, ci.ignore);
    // `ref` in hints and `next`: owner/repo#N, or `run:<id> -R owner/repo`.
    const ref = subject.arg;
    const headSha = subject.headSha;
    if (target.kind === 'pr') assertExpectHead(ref, headSha, input.expectHead);
    else if (target.kind === 'run') assertRunCommit(target.runId, headSha, input.expectHead);

    const classifyInput = {
      repo,
      ref,
      headSha,
      ciState: subject.summary.state,
      checks: subject.checks,
      jobPatterns: (input.job ?? []).map(wildcard),
      maxAttempts: ci.maxRerunAttempts ?? DEFAULT_MAX_RERUN_ATTEMPTS,
      overrideLimit: overrides !== null,
    };
    const rows = new Map<number, ActionsRun>();
    for (const runId of failingRunIds(classifyInput)) {
      rows.set(runId, subject.runRows.get(runId) ?? (await fetchRun({ gh: ctx.gh, repo, runId })));
    }
    const { rerunnable, skipped } = classifyRuns(classifyInput, rows);

    let flake: Map<number, Flake> | null = null;
    if (input.flaky) {
      const diagnoser = createDiagnoser({
        gh: ctx.gh,
        artifacts: ctx.artifacts,
        clock: ctx.clock,
        repo,
        headSha,
        defaultBranch: subject.defaultBranch,
        runs: subject.runs,
        config: ci,
        warn: ctx.warn,
      });
      const remaining = ctx.deadline === undefined ? Infinity : ctx.deadline - ctx.clock.monotonic() - OUTPUT_MARGIN_MS;
      const d = await diagnoser.diagnose(
        rerunnable.flatMap((g) => g.matched),
        { maxJobs: DIAGNOSIS_MAX_JOBS, budgetMs: Math.max(0, Math.min(DIAGNOSIS_BUDGET_MS, remaining)) },
      );
      if (d.omitted > 0) {
        ctx.warn({
          code: 'FLAKE_UNCHECKED',
          message: `${d.omitted} failed job(s) beyond the first ${DIAGNOSIS_MAX_JOBS} were not checked for flakiness and are not rerun; narrow with --job.`,
        });
      }
      flake = new Map(d.jobs.map((j) => [j.jobId, j.flake]));
    }
    const selection = selectJobs(rerunnable, { ref, headSha, byJob: (input.job ?? []).length > 0, flake });
    for (const w of selection.widened) {
      ctx.warn({
        code: 'RERUN_WIDENED',
        message: `Run ${w.runId}: GitHub reruns one job per run at a time, so all its failed jobs are rerun (also ${w.extra.join(', ')}).`,
        details: { runId: w.runId, selected: w.selected, extra: w.extra },
      });
    }
    ctx.preview({ rerun: selection.actions, skipped: [...skipped, ...selection.skipped] });

    const done: RerunAction[] = [];
    const refused: Skipped[] = [];
    for (const a of selection.actions) {
      const path =
        a.method === 'job'
          ? `repos/{owner}/{repo}/actions/jobs/${a.jobId}/rerun`
          : `repos/{owner}/{repo}/actions/runs/${a.runId}/rerun-failed-jobs`;
      try {
        await ctx.gh.apiText({ method: 'POST', path, repo }, { notFound: 'RUN_NOT_FOUND' });
        done.push(a);
      } catch (e) {
        rethrowControlFlow(e);
        if (!(e instanceof GhFailure)) throw e;
        const message = githubMessage(e);
        const status = e.failure.status;
        const base = { runId: a.runId, workflow: a.workflow, attempt: a.previousAttempt, message };
        if (ALREADY_RUNNING.test(message)) {
          // The run restarted between the read and the POST (§3.1 "This workflow is already running").
          refused.push({ ...base, reason: 'RUN_IN_PROGRESS' });
        } else if (status === 403 || status === 422) {
          refused.push({ ...base, reason: 'REFUSED' });
        } else if (done.length > 0) {
          throw new GhxError('PARTIAL_FAILURE', `Reran ${done.length} run(s); run ${a.runId} failed: ${message}.`, {
            hint: `Re-run the same command; runs already rerun are in progress and are skipped. Then ghx ci wait ${ref}.`,
            details: { rerun: done.map((d) => d.runId), failed: { runId: a.runId, message } },
          });
        } else {
          throw e;
        }
      }
    }
    const allSkipped = [...skipped, ...selection.skipped, ...refused];
    if (done.length === 0) throw nothingRerunnable(classifyInput, allSkipped);
    const rerunIds = new Set(done.map((a) => a.runId));
    const deferred = selection.skipped.filter((s) => s.reason === 'DEFERRED' && rerunIds.has(s.runId));
    return {
      ref: subject.ref,
      target: subject.target,
      headSha,
      rerun: done.map((a) => ({
        runId: a.runId,
        workflow: a.workflow,
        method: a.method,
        jobs: a.jobs,
        previousAttempt: a.previousAttempt,
        url: a.url,
        flake: a.flake,
      })),
      skipped: allSkipped,
      overrides: overrides ? [{ code: 'RERUN_LIMIT' as const, reason: overrides.reason }] : [],
      next: [
        `ghx ci wait ${ref}`,
        ...deferred.map((s) => `ghx ci rerun ${ref} --flaky (after run ${s.runId} completes)`),
      ],
    };
  },
});

/** --expect-head for a run target: the run's commit is fixed, so a mismatch names another commit's run. */
function assertRunCommit(runId: number, head: string, expected: string | undefined): void {
  if (expected === undefined || head.startsWith(expected)) return;
  throw new GhxError(
    'HEAD_MOVED',
    `Run ${runId} is for commit ${head.slice(0, 7)}, expected ${expected.slice(0, 7)}.`,
    {
      hint: `That run belongs to another commit. Find the run for ${expected.slice(0, 7)}: ghx ci why branch:<name>@${expected.slice(0, 7)}.`,
      details: { expected, actual: head, runId },
    },
  );
}
