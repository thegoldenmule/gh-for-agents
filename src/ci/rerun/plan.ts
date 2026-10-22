// The pure half of `ghx ci rerun` (02 §13.1; 03 M5.1). Only red Actions checks on the head H count, grouped
// by run. A run is skipped while still going (RUN_IN_PROGRESS, §3.1) or at ci.maxRerunAttempts
// (RERUN_LIMIT, overridable). With nothing left: NO_FAILED_RUNS > RUN_IN_PROGRESS > RERUN_LIMIT.
//
// Targeting: a run is rerun with `rerun-failed-jobs`, except that one selected job (--job/--flaky) out of
// several red ones goes through `jobs/{id}/rerun`. GitHub refuses a second job rerun while the run is going
// again ("This workflow is already running"), so a selection of two or more jobs widens to the run's
// failed jobs (RERUN_WIDENED).
import { GhxError } from '../../core/errors.ts';
import type { RepoRef } from '../../gh/types.ts';
import type { Check, CiSummary, Flake } from '../../schemas/ci.ts';
import type { ActionsRun } from '../github.ts';
import { isRed } from '../summary.ts';

/** 02 §13.1: runs at this attempt or later are not rerun without an override. */
export const DEFAULT_MAX_RERUN_ATTEMPTS = 3;

export type SkipReason = 'RUN_IN_PROGRESS' | 'RERUN_LIMIT' | 'NOT_FLAKY' | 'REFUSED';

export interface Skipped {
  runId: number;
  workflow: string;
  reason: SkipReason;
  /** run_attempt when known. */
  attempt: number | null;
  /** GitHub's refusal message (REFUSED, or a RUN_IN_PROGRESS race on the POST). */
  message?: string;
}

export type RedJob = Check & { runId: number; jobId: number };

export interface RunGroup {
  runId: number;
  workflow: string;
  attempt: number;
  url: string;
  /** Every red job of the run on H. */
  red: RedJob[];
  /** The red jobs --job selects (all of them without --job). */
  matched: RedJob[];
}

export interface RunClassification {
  rerunnable: RunGroup[];
  skipped: Skipped[];
}

export interface ClassifyInput {
  repo: RepoRef;
  /** owner/repo#N, for hints. */
  ref: string;
  headSha: string;
  ciState: CiSummary['state'];
  /** Considered checks (ci.ignore applied). */
  checks: readonly Check[];
  /** --job globs, compiled; empty means every red job. */
  jobPatterns: readonly RegExp[];
  maxAttempts: number;
  /** --override RERUN_LIMIT. */
  overrideLimit: boolean;
}

export const isRedJob = (c: Check): c is RedJob =>
  c.kind === 'actions' && c.runId !== null && c.jobId !== null && isRed(c);

export function runUrl(repo: RepoRef, runId: number): string {
  return `https://${repo.host}/${repo.owner}/${repo.name}/actions/runs/${runId}`;
}

/** The runs to read (`GET actions/runs/{id}`): runs with a red job --job selects. NO_FAILED_RUNS without any. */
export function failingRunIds(i: Pick<ClassifyInput, 'checks' | 'jobPatterns' | 'headSha' | 'ciState'>): number[] {
  const red = i.checks.filter(isRedJob);
  const matched = red.filter((c) => matchesJob(c, i.jobPatterns));
  if (matched.length === 0) throw noFailedRuns(i, red);
  return [...new Set(matched.map((c) => c.runId))];
}

function matchesJob(c: Check, patterns: readonly RegExp[]): boolean {
  return patterns.length === 0 || patterns.some((p) => p.test(c.name));
}

function noFailedRuns(i: Pick<ClassifyInput, 'headSha' | 'ciState' | 'jobPatterns'>, red: readonly RedJob[]): GhxError {
  const short = i.headSha.slice(0, 7);
  if (red.length > 0 && i.jobPatterns.length > 0) {
    return new GhxError('NO_FAILED_RUNS', `No failed Actions job on ${short} matches --job.`, {
      hint: 'Pick a name from details.failing, or drop --job to rerun every failed job.',
      details: { ciState: i.ciState, failing: [...new Set(red.map((c) => c.name))] },
    });
  }
  return new GhxError('NO_FAILED_RUNS', `No failed Actions runs for head ${short}.`, {
    hint: 'Nothing to rerun. If CI never started after a base change, use ghx ci retrigger.',
    details: { ciState: i.ciState },
  });
}

/** Split the failing runs into rerunnable and skipped, from their `actions/runs/{id}` rows. */
export function classifyRuns(i: ClassifyInput, runs: ReadonlyMap<number, ActionsRun>): RunClassification {
  const red = i.checks.filter(isRedJob);
  const rerunnable: RunGroup[] = [];
  const skipped: Skipped[] = [];
  for (const runId of new Set(red.filter((c) => matchesJob(c, i.jobPatterns)).map((c) => c.runId))) {
    const row = runs.get(runId);
    // Only runs on the head count [G-SHA]; a row for another commit is not this PR's CI.
    if (!row || row.head_sha !== i.headSha) continue;
    const jobs = red.filter((c) => c.runId === runId);
    const workflow = jobs[0]?.workflow ?? '';
    const attempt = row.run_attempt ?? 1;
    if (row.status !== 'completed') {
      skipped.push({ runId, workflow, reason: 'RUN_IN_PROGRESS', attempt });
    } else if (attempt >= i.maxAttempts && !i.overrideLimit) {
      skipped.push({ runId, workflow, reason: 'RERUN_LIMIT', attempt });
    } else {
      rerunnable.push({
        runId,
        workflow,
        attempt,
        url: runUrl(i.repo, runId),
        red: jobs,
        matched: jobs.filter((c) => matchesJob(c, i.jobPatterns)),
      });
    }
  }
  if (rerunnable.length === 0) throw nothingRerunnable(i, skipped, red);
  return { rerunnable, skipped };
}

/** The error when no run is left: NO_FAILED_RUNS > RUN_IN_PROGRESS > RERUN_LIMIT > GitHub's refusal. */
export function nothingRerunnable(
  i: Pick<ClassifyInput, 'ref' | 'headSha' | 'ciState' | 'jobPatterns' | 'maxAttempts'>,
  skipped: readonly Skipped[],
  red: readonly RedJob[] = [],
): GhxError {
  const short = i.headSha.slice(0, 7);
  const { ref } = i;
  const of = (r: SkipReason) => skipped.filter((s) => s.reason === r);
  if (skipped.length === 0) return noFailedRuns(i, red);
  const running = of('RUN_IN_PROGRESS');
  if (running.length > 0) {
    return new GhxError(
      'RUN_IN_PROGRESS',
      `All failed runs for ${short} are still running; GitHub rejects reruns until a run completes.`,
      {
        hint: `ghx ci wait ${ref} --until settled, then ghx ci rerun ${ref}.`,
        details: { runs: running.map((s) => s.runId) },
      },
    );
  }
  const limited = of('RERUN_LIMIT');
  if (limited.length > 0) {
    const first = limited[0] as Skipped;
    const msg =
      limited.length === 1
        ? `Run ${first.runId} is on attempt ${first.attempt} (limit ${i.maxAttempts}).`
        : `Runs ${limited.map((s) => s.runId).join(', ')} are at the rerun limit (${i.maxAttempts}).`;
    return new GhxError('RERUN_LIMIT', msg, {
      hint: `Diagnose instead: ghx ci why ${ref}. Override with --override RERUN_LIMIT --reason only if the user approved.`,
      details: {
        runId: first.runId,
        attempt: first.attempt,
        limit: i.maxAttempts,
        runs: limited.map((s) => ({ runId: s.runId, attempt: s.attempt })),
      },
    });
  }
  const refused = of('REFUSED');
  const first = refused[0] ?? (skipped[0] as Skipped);
  return new GhxError('GH_FAILED', `GitHub refused to rerun run ${first.runId}: ${first.message ?? 'refused'}.`, {
    hint: `Read the failure instead: ghx ci why ${ref}.`,
    details: { runs: refused.map((s) => ({ runId: s.runId, message: s.message ?? null })) },
  });
}

export interface JobFlake extends Flake {
  job: string;
  jobId: number;
}

export interface RerunAction {
  runId: number;
  workflow: string;
  /** `failed-jobs`: POST runs/{id}/rerun-failed-jobs; `job`: POST jobs/{jobId}/rerun. */
  method: 'failed-jobs' | 'job';
  jobId: number | null;
  /** The jobs GitHub reruns. */
  jobs: string[];
  previousAttempt: number;
  url: string;
  /** --flaky evidence for the selected jobs; null without --flaky. */
  flake: JobFlake[] | null;
}

export interface SelectInput {
  ref: string;
  headSha: string;
  /** --job given. */
  byJob: boolean;
  /** --flaky: flake per job id (a job missing here was not assessed and is not a candidate). */
  flake: ReadonlyMap<number, Flake> | null;
}

export interface Selection {
  actions: RerunAction[];
  skipped: Skipped[];
  /** Runs where rerun-failed-jobs reruns more than was selected. */
  widened: { runId: number; selected: string[]; extra: string[] }[];
}

/** Choose what to POST per rerunnable run. --flaky with no candidate anywhere is NO_FLAKY_CANDIDATES. */
export function selectJobs(groups: readonly RunGroup[], i: SelectInput): Selection {
  const actions: RerunAction[] = [];
  const skipped: Skipped[] = [];
  const widened: Selection['widened'] = [];
  for (const g of groups) {
    const flake = i.flake;
    const selected = flake ? g.matched.filter((c) => flake.get(c.jobId)?.candidate === true) : g.matched;
    if (selected.length === 0) {
      skipped.push({ runId: g.runId, workflow: g.workflow, reason: 'NOT_FLAKY', attempt: g.attempt });
      continue;
    }
    const evidence = flake
      ? selected.map((c) => ({ job: c.name, jobId: c.jobId, ...(flake.get(c.jobId) as Flake) }))
      : null;
    const base = { runId: g.runId, workflow: g.workflow, previousAttempt: g.attempt, url: g.url, flake: evidence };
    const filtered = i.byJob || flake !== null;
    const all = selected.length === g.red.length;
    if (filtered && !all && selected.length === 1) {
      const job = selected[0] as RedJob;
      actions.push({ ...base, method: 'job', jobId: job.jobId, jobs: [job.name] });
      continue;
    }
    if (filtered && !all) {
      const names = new Set(selected.map((c) => c.jobId));
      widened.push({
        runId: g.runId,
        selected: selected.map((c) => c.name),
        extra: g.red.filter((c) => !names.has(c.jobId)).map((c) => c.name),
      });
    }
    actions.push({ ...base, method: 'failed-jobs', jobId: null, jobs: g.red.map((c) => c.name) });
  }
  if (actions.length === 0 && i.flake) {
    const failing = [...new Set(groups.flatMap((g) => g.matched.map((c) => c.name)))];
    throw new GhxError('NO_FLAKY_CANDIDATES', `No failed job on ${i.headSha.slice(0, 7)} looks flaky.`, {
      hint: `Treat it as a real failure: ghx ci why ${i.ref}`,
      details: { failing },
    });
  }
  return { actions, skipped, widened };
}
