// ghx ci rerun <pr> (02 §13.1; 03 M5.1): rerun the failed jobs of completed runs on the head, within
// ci.maxRerunAttempts. Flow: rollup for H [G-SHA] → GET actions/runs/{id} per failing run → (--flaky) the
// diagnosis engine's flake signals → POST rerun-failed-jobs or jobs/{id}/rerun (--dry-run halts at the
// first). The selection rules and the error precedence live in src/ci/rerun/plan.ts.
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
import { fetchCiSnapshot, snapshotSummary } from '../../ci/snapshot.ts';
import { defineCommand } from '../../core/command.ts';
import { rethrowControlFlow } from '../../core/control-flow.ts';
import { GhxError } from '../../core/errors.ts';
import { GhFailure } from '../../gh/index.ts';
import { formatPrRef, parseTargetRef } from '../../gh/refs.ts';
import { enrichNotFound } from '../../gh/repo.ts';
import { githubMessage } from '../../pr/feedback-writes/post.ts';
import { Flake } from '../../schemas/ci.ts';
import { PrRef, Sha, ShaInput } from '../../schemas/common.ts';

/** Time kept back from the command deadline for the POSTs and the output. */
const OUTPUT_MARGIN_MS = 15_000;

const Input = z.strictObject({
  pr: z.string().min(1).describe('PR: 3198, #3198, owner/repo#3198 or a PR URL'),
  job: z.array(z.string().min(1)).optional().describe('Only failed jobs whose name matches (repeatable; * and ?)'),
  flaky: z.boolean().default(false).describe('Only jobs whose flake score is medium or higher (02 §11.8)'),
  expectHead: ShaInput.optional().describe('Refuse with HEAD_MOVED unless the head is this SHA'),
  override: z.array(z.string().min(1)).optional().describe('RERUN_LIMIT: rerun past ci.maxRerunAttempts'),
  reason: z.string().optional().describe('Why the override is allowed (who asked); required with --override'),
});

const SkipReason = z.enum(['RUN_IN_PROGRESS', 'RERUN_LIMIT', 'NOT_FLAKY', 'REFUSED']);

const Output = z.object({
  ref: PrRef,
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
    }),
  ),
  overrides: z.array(z.object({ code: z.literal('RERUN_LIMIT'), reason: z.string() })),
  next: z.array(z.string()),
});

const ALREADY_RUNNING = /already running/i;

export default defineCommand({
  name: ['ci', 'rerun'],
  summary: 'Rerun failed jobs of completed runs on the PR head (--flaky: only likely-flaky jobs)',
  description:
    'Reruns the failed jobs of completed Actions runs for the current head, skipping runs still in progress ' +
    '(RUN_IN_PROGRESS) and runs at ci.maxRerunAttempts (RERUN_LIMIT, default 3). --job reruns matching jobs; ' +
    '--flaky only jobs with flake evidence (NO_FLAKY_CANDIDATES if none). A rerun reuses the original merge ' +
    'ref: after a base change, use ghx ci retrigger.',
  kind: 'write',
  input: Input,
  positionals: ['pr'],
  output: Output,
  needs: { repo: 'inferred', config: 'optional' },
  timeout: { defaultMs: 120_000, maxMs: 300_000 },
  replaces: ['gh run rerun', 'gh run rerun --failed', 'gh run rerun --job'],
  examples: [
    { argv: 'ghx ci rerun powerhouse-inc/powerhouse#3301 --flaky', note: 'Rerun only the jobs that look flaky' },
    { argv: 'ghx ci rerun 3301', note: 'Rerun every failed job of the completed runs on the head' },
    { argv: "ghx ci rerun 3301 --job 'Test Reactor*'", note: 'Rerun matching failed jobs' },
    {
      argv: 'ghx ci rerun 3301 --override RERUN_LIMIT --reason "user asked in chat"',
      note: 'Past ci.maxRerunAttempts',
    },
  ],
  async run(input, ctx) {
    const target = parseTargetRef(input.pr);
    if (target.kind !== 'pr') {
      throw new GhxError('USAGE_BAD_SELECTOR', `'${input.pr}' is not a PR selector.`, {
        hint: 'Use 3198, #3198, owner/repo#3198 or a PR URL.',
      });
    }
    const overrides = parseCommandOverrides(input.override, input.reason, ['RERUN_LIMIT'] as const);
    const resolved = await ctx.repo({ ref: target.repo });
    const { repo } = resolved;
    const ci = (await ctx.config({ ref: repo })).config.ci;
    let snapshot: Awaited<ReturnType<typeof fetchCiSnapshot>>;
    try {
      snapshot = await fetchCiSnapshot({ gh: ctx.gh, repo, number: target.number, ignore: ci.ignore, warn: ctx.warn });
    } catch (e) {
      throw enrichNotFound(e, resolved, `PR #${target.number}`);
    }
    const ref = formatPrRef(repo, snapshot.number);
    const headSha = snapshot.headSha;
    assertExpectHead(ref, headSha, input.expectHead);

    const classifyInput = {
      repo,
      ref,
      headSha,
      ciState: snapshotSummary(snapshot).state,
      checks: snapshot.checks,
      jobPatterns: (input.job ?? []).map(wildcard),
      maxAttempts: ci.maxRerunAttempts ?? DEFAULT_MAX_RERUN_ATTEMPTS,
      overrideLimit: overrides !== null,
    };
    const rows = new Map<number, ActionsRun>();
    for (const runId of failingRunIds(classifyInput)) {
      rows.set(runId, await fetchRun({ gh: ctx.gh, repo, runId }));
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
        defaultBranch: snapshot.defaultBranch,
        runs: snapshot.runs,
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
    return {
      ref,
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
      next: [`ghx ci wait ${ref}`],
    };
  },
});
