// Stall detection (02 §11.1, §11.3; 03 M4.5, Q1). Pure: every clock it needs is read from the snapshot
// (job created_at/started_at, check completedAt) or, for a check with no startedAt, from the first-seen
// time the wait state keeps, so a resumed wait judges the same snapshot the same way. A check is stalled when it is
// - running longer than max(3×p90, p90+15m) of its baseline; with no baseline, longer than the job's
//   literal `timeout-minutes`, else 360 min;
// - queued (no runner) longer than `ci.stall.queuedMinutes` (30), measured from created_at, while no
//   other job in its run has started;
// - a required or config check still missing `ci.stall.missingMinutes` (10) after everything else settled.
// Thresholds are strict: exactly at the threshold is not stalled.
import type { Check, ExpectedCheck, StalledCheck } from '../../schemas/ci.ts';
import type { ActionsJob } from '../github.ts';
import type { BaselineStats } from './eta.ts';
import { jobTimeoutFor, type WorkflowTimeouts } from './job-timeouts.ts';
import { checkKey } from './machine.ts';

export const STALL_DEFAULTS = { queuedMinutes: 30, missingMinutes: 10 } as const;

export interface StallConfig {
  queuedMinutes: number;
  missingMinutes: number;
}

/** `ci.stall` from config, defaults filled in. */
export function stallConfig(c?: {
  queuedMinutes?: number | undefined;
  missingMinutes?: number | undefined;
}): StallConfig {
  return {
    queuedMinutes: c?.queuedMinutes ?? STALL_DEFAULTS.queuedMinutes,
    missingMinutes: c?.missingMinutes ?? STALL_DEFAULTS.missingMinutes,
  };
}

export const STALL_BASIS = {
  threeP90: '3×p90',
  p90Plus15: 'p90+15m',
  timeout: 'timeout-minutes',
  default360: 'default-360',
  queued: 'ci.stall.queuedMinutes',
  missing: 'ci.stall.missingMinutes',
} as const;

const P90_PAD_SEC = 15 * 60;

/** The running threshold: from the baseline p90 when there is one, else the job's limit. */
export function runningThreshold(
  p90Sec: number | undefined,
  limit: { minutes: number; basis: 'timeout-minutes' | 'default-360' },
): { thresholdSec: number; basis: string } {
  if (p90Sec === undefined) return { thresholdSec: limit.minutes * 60, basis: limit.basis };
  const triple = 3 * p90Sec;
  const padded = p90Sec + P90_PAD_SEC;
  return triple >= padded
    ? { thresholdSec: Math.ceil(triple), basis: STALL_BASIS.threeP90 }
    : { thresholdSec: Math.ceil(padded), basis: STALL_BASIS.p90Plus15 };
}

export interface StallInput {
  /** Considered checks for the bound SHA. */
  checks: readonly Check[];
  /** Jobs of the runs behind the pending checks (runner, created_at, siblings). May be empty. */
  jobs: readonly ActionsJob[];
  /** Baseline stats by job name (eta.ts). */
  baselines: BaselineStats;
  /** Scanned workflow files by run id (String(runId)); null or absent = unknown. */
  timeouts: Readonly<Record<string, WorkflowTimeouts | null>>;
  /** The expected set (expected.ts). */
  expected: readonly ExpectedCheck[];
  /** Epoch ms. */
  now: number;
  config: StallConfig;
  /** Epoch ms the wait first saw each check (by checkKey): the clock for a check with no startedAt. */
  firstSeen?: Readonly<Record<string, number>>;
}

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : Number.NaN);

/** A sibling counts as started once it has a runner, is running, or completed without being skipped. */
const jobStarted = (j: ActionsJob): boolean =>
  (j.runner_id ?? 0) > 0 || j.status === 'in_progress' || (j.status === 'completed' && j.conclusion !== 'skipped');

/** The same rule from a check alone (no job row): running, or completed without being skipped (04). */
const checkStarted = (c: Check): boolean =>
  c.status === 'in_progress' || (c.status === 'completed' && c.bucket !== 'skipped' && c.conclusion !== 'skipped');

type Activity = { kind: 'running' | 'queued'; since: number; runIdle: boolean } | null;

/** Whether a pending check is running or queued, since when, and (if queued) whether its run is idle. */
function activity(c: Check, i: StallInput): Activity {
  const job = c.jobId === null ? undefined : i.jobs.find((j) => j.id === c.jobId);
  if (job) {
    if (job.status === 'queued' && !((job.runner_id ?? 0) > 0)) {
      const siblings = i.jobs.filter((j) => j.run_id === job.run_id && j.id !== job.id);
      return { kind: 'queued', since: ms(job.created_at), runIdle: !siblings.some(jobStarted) };
    }
    if (job.status === 'in_progress' || (job.runner_id ?? 0) > 0) {
      return { kind: 'running', since: ms(job.started_at), runIdle: false };
    }
    return null;
  }
  const since = Number.isFinite(ms(c.startedAt)) ? ms(c.startedAt) : (i.firstSeen?.[checkKey(c)] ?? Number.NaN);
  if (c.status === 'in_progress') return { kind: 'running', since, runIdle: false };
  if (c.status === 'queued') {
    const siblings = c.runId === null ? [] : i.checks.filter((s) => s !== c && s.runId === c.runId);
    // The rollup has no created_at; a queued check run's startedAt is its creation time (spike §3.5:
    // started_at == created_at while queued), so this measures from created_at as the jobs rule does.
    return { kind: 'queued', since, runIdle: !siblings.some(checkStarted) };
  }
  return null;
}

function entry(name: string, state: StalledCheck['state'], forMs: number, thresholdSec: number, basis: string) {
  return forMs > thresholdSec * 1000
    ? [{ name, state, forSec: Math.floor(forMs / 1000), thresholdSec, basis } satisfies StalledCheck]
    : [];
}

/** When every reported check completed (the latest completedAt), or null while anything is pending. */
export function settledAt(checks: readonly Check[]): number | null {
  if (checks.length === 0 || checks.some((c) => c.bucket === 'pending')) return null;
  const times = checks.map((c) => ms(c.completedAt)).filter(Number.isFinite);
  return times.length > 0 ? Math.max(...times) : null;
}

/** Every stalled check, in check order, then missing expected checks in expected order. */
export function detectStalls(i: StallInput): StalledCheck[] {
  const out: StalledCheck[] = [];
  for (const c of i.checks) {
    if (c.bucket !== 'pending') continue;
    const a = activity(c, i);
    if (!a || !Number.isFinite(a.since)) continue;
    const forMs = Math.max(0, i.now - a.since);
    if (a.kind === 'queued') {
      if (a.runIdle) out.push(...entry(c.name, 'queued', forMs, i.config.queuedMinutes * 60, STALL_BASIS.queued));
      continue;
    }
    const limit = jobTimeoutFor(c.runId === null ? null : i.timeouts[String(c.runId)], c.name);
    const t = runningThreshold(i.baselines[c.name]?.p90Sec, limit);
    out.push(...entry(c.name, 'running', forMs, t.thresholdSec, t.basis));
  }
  const settled = settledAt(i.checks);
  if (settled !== null) {
    const forMs = Math.max(0, i.now - settled);
    for (const e of i.expected) {
      if (e.state !== 'missing' || e.source === 'baseline') continue;
      out.push(...entry(e.name, 'missing', forMs, i.config.missingMinutes * 60, STALL_BASIS.missing));
    }
  }
  return out;
}
