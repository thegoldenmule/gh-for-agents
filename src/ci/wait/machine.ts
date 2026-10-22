// The ci wait state machine (02 §11.1–11.3; 03 M4.4). Pure. A tick is two steps, because diagnosis is
// I/O that sits between them and red vs red-shared depends on it:
//   observe(state, obs) → transitions as events, the new failures to diagnose, the next state;
//   decide(state, obs, diagnoses, stalled) → the terminal outcome, if any.
// `until: 'mergeable'` (M6.6) is not decided here: on settle, decide() returns `gate: true` and the
// driver hands the CI outcome to its settle hook.
import { SHARED_VERDICTS } from '../../policy/shared-red.ts';
import type { Bucket, Check, CiCounts, ExpectedCheck, FailingJob, Outcome, StalledCheck } from '../../schemas/ci.ts';
import { countChecks, isRed } from '../summary.ts';
import type { Eta } from './eta.ts';
import { type CiPhase, type ExpectedDef, expectedPhase, expectedState } from './expected.ts';

export const WAIT_DEFAULTS = {
  /** `registering` → `no-checks` (02 §11.3). */
  graceMs: 120_000,
  /** A missing baseline check ages to `absent` this long after everything else settled. */
  expectGraceMs: 90_000,
  /** `progress` at most this often when nothing else happens (02 §11.9). */
  progressEveryMs: 60_000,
} as const;

export type UntilMode = 'first-failure' | 'settled' | 'mergeable';

export interface MachineConfig {
  until: UntilMode;
  /** --check: the stored expected set is unfiltered (04); only the entries this predicate keeps count. */
  consider?: (c: { name: string; workflow: string | null }) => boolean;
  graceMs: number;
  expectGraceMs: number;
  progressEveryMs: number;
}

/** One target's machine state for one bound SHA. Plain JSON: the state store persists it as is. */
export interface MachineState {
  target: string;
  boundSha: string;
  /** Epoch ms the binding started; the registering grace counts from here. */
  boundAt: number;
  /** null before the first observation. */
  phase: CiPhase | null;
  /** Last observed bucket per check key. */
  buckets: Record<string, Bucket>;
  expected: ExpectedDef[];
  /** Baseline checks aged out to `absent`. */
  agedOut: string[];
  /** Epoch ms everything except missing baseline checks had settled (CI completion time); null otherwise. */
  othersSettledAt: number | null;
  /** Failure keys observed in this binding (each is diagnosed at most once). */
  seenFailures: string[];
  /** Failure keys a caller has already received in a red summary (first-failure continuation). */
  reported: string[];
  /** Epoch ms of the last event, for the progress cadence. */
  lastEventAt: number;
  /** Epoch ms each check (by checkKey) was first observed: stall.ts's clock when startedAt is null. */
  firstSeen?: Record<string, number>;
}

export interface Observation {
  /** Considered checks for the bound SHA (ignore and --check applied). */
  checks: readonly Check[];
  ignored: number;
  eta: Eta | null;
  /** Epoch ms. */
  now: number;
}

/** Events as yielded by the handler (the runner adds seq and at). */
export type MachineEvent =
  | { type: 'phase'; target: string; headSha: string; from: CiPhase; to: CiPhase }
  | {
      type: 'check';
      target: string;
      headSha: string;
      name: string;
      workflow: string | null;
      from: Bucket | 'absent';
      to: Bucket;
      conclusion: string | null;
      required: boolean;
      runId: number | null;
      jobId: number | null;
      url: string;
    }
  | { type: 'expected-absent'; target: string; name: string; source: 'baseline' }
  | { type: 'progress'; target: string; headSha: string; counts: CiCounts; eta: Eta | null };

export function initialState(o: {
  target: string;
  boundSha: string;
  boundAt: number;
  expected: readonly ExpectedDef[];
}): MachineState {
  return {
    target: o.target,
    boundSha: o.boundSha,
    boundAt: o.boundAt,
    phase: null,
    buckets: {},
    expected: [...o.expected],
    agedOut: [],
    othersSettledAt: null,
    seenFailures: [],
    reported: [],
    lastEventAt: o.boundAt,
  };
}

export const checkKey = (c: Pick<Check, 'kind' | 'workflow' | 'name'>): string =>
  `${c.kind}\u0000${c.workflow ?? ''}\u0000${c.name}`;

/** A failure's identity: its job (a re-run is a new job, so a new failure), else the check and its completion. */
export const failureKey = (c: Pick<Check, 'kind' | 'workflow' | 'name' | 'jobId' | 'completedAt'>): string =>
  c.jobId !== null ? `job:${c.jobId}` : `check:${checkKey(c)}@${c.completedAt ?? ''}`;

/** The stored (unfiltered) expected set narrowed to the considered checks. */
export function consideredDefs(state: Pick<MachineState, 'expected'>, cfg?: Pick<MachineConfig, 'consider'>) {
  const keep = cfg?.consider;
  return keep ? state.expected.filter((e) => keep(e)) : state.expected;
}

/** The expected set with this state's aged-out baseline checks. */
export function currentExpected(
  state: MachineState,
  checks: readonly Check[],
  cfg?: Pick<MachineConfig, 'consider'>,
): ExpectedCheck[] {
  return expectedState(consideredDefs(state, cfg), checks, state.agedOut);
}

export interface ObserveResult {
  state: MachineState;
  events: MachineEvent[];
  /** Red checks not seen before in this binding, in check order. */
  newFailures: Check[];
  phase: CiPhase;
  expected: ExpectedCheck[];
}

export function observe(prev: MachineState, obs: Observation, cfg: MachineConfig): ObserveResult {
  const { now, checks } = obs;
  const t = { target: prev.target };
  const headSha = prev.boundSha;
  const events: MachineEvent[] = [];
  const buckets: Record<string, Bucket> = { ...prev.buckets };
  const firstSeen: Record<string, number> = { ...prev.firstSeen };
  for (const c of checks) {
    const k = checkKey(c);
    firstSeen[k] ??= now;
    const from = prev.buckets[k] ?? 'absent';
    buckets[k] = c.bucket;
    // A check first seen pending is not a transition worth a line; `start` and `progress` carry counts.
    if (from === c.bucket || (from === 'absent' && c.bucket === 'pending')) continue;
    events.push({
      type: 'check',
      ...t,
      headSha,
      name: c.name,
      workflow: c.workflow,
      from,
      to: c.bucket,
      conclusion: c.conclusion,
      required: c.required,
      runId: c.runId,
      jobId: c.jobId,
      url: c.url,
    });
  }

  // Baseline aging (02 §11.3): once everything else has settled, a missing baseline check gets
  // --expect-grace to register, then counts as `absent`.
  let agedOut = prev.agedOut;
  const defs = consideredDefs(prev, cfg);
  const before = expectedState(defs, checks, agedOut);
  const othersSettled =
    checks.length > 0 &&
    !checks.some((c) => c.bucket === 'pending') &&
    !before.some((e) => e.state === 'missing' && e.source !== 'baseline');
  // From CI time, never first observation (04, final review), as stall.ts measures `missing`: CI that
  // settled long ago does not grant a missing baseline check another grace on every fresh wait.
  const othersSettledAt = othersSettled ? (prev.othersSettledAt ?? Math.min(lastCompletion(checks) ?? now, now)) : null;
  if (othersSettledAt !== null && now - othersSettledAt >= cfg.expectGraceMs) {
    const aging = before.filter((e) => e.state === 'missing' && e.source === 'baseline').map((e) => e.name);
    if (aging.length > 0) {
      agedOut = [...agedOut, ...aging];
      for (const name of aging) events.push({ type: 'expected-absent', ...t, name, source: 'baseline' });
    }
  }
  const expected = expectedState(defs, checks, agedOut);
  const phase = expectedPhase([...checks], expected);
  if (prev.phase !== null && prev.phase !== phase) {
    events.push({ type: 'phase', ...t, headSha, from: prev.phase, to: phase });
  }

  const seen = new Set(prev.seenFailures);
  const newFailures = checks.filter((c) => isRed(c) && !seen.has(failureKey(c)));
  for (const c of newFailures) seen.add(failureKey(c));

  let lastEventAt = prev.lastEventAt;
  if (events.length > 0) lastEventAt = now;
  else if (now - prev.lastEventAt >= cfg.progressEveryMs && prev.phase !== null) {
    events.push({ type: 'progress', ...t, headSha, counts: countChecks([...checks], obs.ignored), eta: obs.eta });
    lastEventAt = now;
  }

  return {
    state: {
      ...prev,
      phase,
      buckets,
      agedOut,
      othersSettledAt,
      seenFailures: [...seen],
      lastEventAt,
      firstSeen,
    },
    events,
    newFailures,
    phase,
    expected,
  };
}

/** The latest completedAt among the checks (epoch ms), or null when none carries one. */
function lastCompletion(checks: readonly Check[]): number | null {
  const times = checks.map((c) => (c.completedAt ? Date.parse(c.completedAt) : Number.NaN)).filter(Number.isFinite);
  return times.length > 0 ? Math.max(...times) : null;
}

export interface Decision {
  outcome: Outcome;
  /** Why, in a word or two (`first-failure`, `settled`, `grace`, `stalled`). */
  reason: string;
  /** Every considered check had completed: the outcome cannot change unless CI is re-run. */
  settled: boolean;
  /** The red checks the outcome is about. */
  failing: Check[];
  stalled: StalledCheck[];
  /** until=mergeable and CI settled: the driver's settle hook decides the final outcome (M6.6). */
  gate: boolean;
}

/** Every red check diagnosed with a shared-with-main verdict (02 §1.5): red-shared; otherwise red. */
export function redOutcome(
  red: readonly Check[],
  diagnosis: (c: Check) => FailingJob | undefined,
): 'red' | 'red-shared' {
  const shared = red.every((c) => {
    const d = diagnosis(c);
    return d !== undefined && SHARED_VERDICTS.includes(d.sameOnMain.verdict);
  });
  return red.length > 0 && shared ? 'red-shared' : 'red';
}

/**
 * The terminal outcome for this tick, or null to keep waiting. Order:
 * 1. first-failure: a red check not yet reported ends the wait early;
 * 2. settled (all complete, expected checks reported or aged out): green, red-shared or red;
 * 3. a stall (from stall.ts): stalled;
 * 4. nothing reported within the grace: no-checks (never green, never stalled).
 */
export function decide(
  state: MachineState,
  obs: Pick<Observation, 'checks' | 'now'>,
  o: {
    cfg: MachineConfig;
    diagnosis: (c: Check) => FailingJob | undefined;
    stalled: readonly StalledCheck[];
  },
): Decision | null {
  const { checks, now } = obs;
  const none = { failing: [] as Check[], stalled: [] as StalledCheck[], gate: false };
  if (checks.length === 0) {
    return now - state.boundAt >= o.cfg.graceMs
      ? { outcome: 'no-checks', reason: 'grace', settled: false, ...none }
      : null;
  }
  const red = checks.filter(isRed);
  const phase = expectedPhase([...checks], currentExpected(state, checks, o.cfg));
  const settled = phase === 'settled';
  if (o.cfg.until === 'first-failure' && !settled) {
    const reported = new Set(state.reported);
    if (red.some((c) => !reported.has(failureKey(c)))) {
      return { outcome: redOutcome(red, o.diagnosis), reason: 'first-failure', settled: false, ...none, failing: red };
    }
  }
  if (settled) {
    const outcome = red.length === 0 ? 'green' : redOutcome(red, o.diagnosis);
    return { outcome, reason: 'settled', settled: true, ...none, failing: red, gate: o.cfg.until === 'mergeable' };
  }
  if (o.stalled.length > 0) {
    return { outcome: 'stalled', reason: 'stalled', settled: false, ...none, failing: red, stalled: [...o.stalled] };
  }
  return null;
}

/** Record that a caller received these failures in a red summary (first-failure continuation). */
export function markReported(state: MachineState, failing: readonly Check[]): MachineState {
  return { ...state, reported: [...new Set([...state.reported, ...failing.map(failureKey)])] };
}
