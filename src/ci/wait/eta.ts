// ETA from base-branch baselines (02 §11.6; 03 M4.2). Pure: samples come from ./fetch.ts.
//
// Per job name: the median and p90 duration of its successful runs, preferring base-branch `push` runs
// and falling back to `pull_request` runs into the base when the push runs have no job of that name.
// `eta` is the max over pending checks of (median − elapsed), clipped at 0; queued checks add the
// median queue time still to come. Stats are plain JSON so the wait state store (M4.6) can persist them.
import type { Check, CiSummary } from '../../schemas/ci.ts';
import type { ActionsJob } from '../github.ts';

export type Eta = NonNullable<CiSummary['eta']>;
export type SampleSource = 'push' | 'pull_request';

export interface DurationSample {
  durationSec: number;
  /** started_at − created_at of the completed job; null when unknown. */
  queueSec: number | null;
}

/** Samples per job name. */
export type JobSamples = Record<string, DurationSample[]>;

export interface JobStats {
  samples: number;
  medianSec: number;
  p90Sec: number;
  queueMedianSec: number;
  source: SampleSource;
}

/** Stats per job name. */
export type BaselineStats = Record<string, JobStats>;

/** Linear-interpolated quantile (q in [0, 1]) of a non-empty list. */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) throw new RangeError('quantile of an empty list');
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = s[lo] as number;
  const b = s[hi] as number;
  return a + (b - a) * (pos - lo);
}

/** Successful, completed jobs only: duration from started_at, queue time from created_at. */
export function samplesFromJobs(jobs: readonly ActionsJob[]): JobSamples {
  const out: JobSamples = {};
  for (const j of jobs) {
    if (j.conclusion !== 'success' || !j.started_at || !j.completed_at) continue;
    const start = Date.parse(j.started_at);
    const end = Date.parse(j.completed_at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    const created = j.created_at ? Date.parse(j.created_at) : Number.NaN;
    const queueSec = Number.isFinite(created) && start >= created ? (start - created) / 1000 : null;
    out[j.name] = [...(out[j.name] ?? []), { durationSec: (end - start) / 1000, queueSec }];
  }
  return out;
}

export function jobStats(samples: readonly DurationSample[], source: SampleSource): JobStats | null {
  if (samples.length === 0) return null;
  const d = samples.map((s) => s.durationSec);
  const q = samples.flatMap((s) => (s.queueSec === null ? [] : [s.queueSec]));
  return {
    samples: samples.length,
    medianSec: quantile(d, 0.5),
    p90Sec: quantile(d, 0.9),
    queueMedianSec: q.length > 0 ? quantile(q, 0.5) : 0,
    source,
  };
}

/**
 * Stats for each job name: from push samples when that name appears there, else from pull_request
 * samples. Names with neither are left out (no baseline: the stall rules fall back to timeout-minutes).
 */
export function baselineStats(names: readonly string[], push: JobSamples, pullRequest: JobSamples = {}): BaselineStats {
  const out: BaselineStats = {};
  for (const n of names) {
    const s = jobStats(push[n] ?? [], 'push') ?? jobStats(pullRequest[n] ?? [], 'pull_request');
    if (s) out[n] = s;
  }
  return out;
}

/** True when some name has no push samples, so the pull_request fallback is worth fetching. */
export const needsPullRequestSamples = (names: readonly string[], push: JobSamples): boolean =>
  names.some((n) => (push[n]?.length ?? 0) === 0);

export interface CheckRemaining {
  name: string;
  remainingSec: number;
  p90RemainingSec: number;
}

export interface EtaEstimate {
  /** null when no pending check has a baseline. */
  eta: Eta | null;
  /** The soonest expected completion still ahead (median), for the 10 s near-completion poll. */
  soonestSec: number | null;
  /** Every pending check with a baseline has passed its median. */
  overrun: boolean;
  perCheck: CheckRemaining[];
}

const QUEUED = new Set<Check['status']>(['queued', 'expected', 'waiting']);

/** The ETA over pending checks at `now` (epoch ms). Checks without stats are skipped. */
export function computeEta(
  pending: readonly Pick<Check, 'name' | 'status' | 'startedAt'>[],
  stats: BaselineStats,
  now: number,
): EtaEstimate {
  const perCheck: CheckRemaining[] = [];
  for (const c of pending) {
    const s = stats[c.name];
    if (!s) continue;
    const since = c.startedAt ? Date.parse(c.startedAt) : Number.NaN;
    const elapsed = Number.isFinite(since) ? Math.max(0, (now - since) / 1000) : 0;
    if (QUEUED.has(c.status)) {
      // A queued job's started_at equals created_at (spike §3.5), so `elapsed` is time spent queued.
      const queueLeft = Math.max(0, s.queueMedianSec - elapsed);
      perCheck.push({ name: c.name, remainingSec: s.medianSec + queueLeft, p90RemainingSec: s.p90Sec + queueLeft });
    } else {
      perCheck.push({
        name: c.name,
        remainingSec: Math.max(0, s.medianSec - elapsed),
        p90RemainingSec: Math.max(0, s.p90Sec - elapsed),
      });
    }
  }
  if (perCheck.length === 0) return { eta: null, soonestSec: null, overrun: false, perCheck };
  const seconds = Math.round(Math.max(...perCheck.map((p) => p.remainingSec)));
  const p90Seconds = Math.round(Math.max(...perCheck.map((p) => p.p90RemainingSec)));
  const ahead = perCheck.map((p) => p.remainingSec).filter((r) => r > 0);
  return {
    eta: { seconds, p90Seconds, basis: perCheck.length === pending.length ? 'baseline' : 'partial-baseline' },
    soonestSec: ahead.length > 0 ? Math.min(...ahead) : null,
    overrun: ahead.length === 0,
    perCheck,
  };
}
