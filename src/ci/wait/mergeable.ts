// ci wait --until mergeable (02 §11.2; 03 M6.6). Once the wait's CI has settled, the merge CI gate
// (02 §8.2 rows 6–12) decides the outcome through loadPrStatus with scope 'ci-gate', so `merge.ready`
// means what pr status and pr merge mean by it. Ready implies MERGEABLE (UNKNOWN and CONFLICTING block).
// The gate judges the wait's own expected set (one check set, 04): the definitions the wait bound, not a
// set re-derived from this process's config. Keep polling (null) while mergeable or mergeStateStatus is
// UNKNOWN, while the snapshot is for another head or a closed PR (the poller reports both on its next
// tick), and while the snapshot's CI view still has pending or unregistered checks: it is read through
// GraphQL, the wait through REST, and the two can lag each other by a poll. That polling is bounded
// (gateVerdict): long after CI settled it ends `stalled`. A truncated rollup is final.
import type { StreamContext } from '../../core/command.ts';
import { rethrowControlFlow } from '../../core/control-flow.ts';
import { GhFailure } from '../../gh/index.ts';
import { loadPrStatus, type PrStatusState } from '../../pr/status/compose.ts';
import type { Outcome, StalledCheck, TargetSummary } from '../../schemas/ci.ts';
import type { SettleHook } from './driver.ts';
import { STALL_BASIS, settledAt, stallConfig } from './stall.ts';

/** Consecutive failed gate reads (gh failures) before the wait gives up (error document, exit 7). */
export const MAX_GATE_FAILURES = 5;

export interface GateResult {
  outcome: Outcome;
  reason: string;
  merge: NonNullable<TargetSummary['merge']>;
  next?: string[];
  stalled?: StalledCheck[];
}

/**
 * How long the gate may keep answering "keep polling" in this process, at least, before it can give up:
 * a few polls, so a resumed wait on long-settled CI still rides out a brief UNKNOWN or REST/GraphQL lag.
 */
export const GATE_MIN_HOLD_MS = 60_000;

/** The clocks behind the gate's own bound (all epoch ms or ms). */
export interface GateClock {
  now: number;
  /** When the wait's checks all completed (stall.ts settledAt), or null while any is pending. */
  settledAt: number | null;
  /** ci.stall.missingMinutes in ms: how long after settling an expected check may still be missing. */
  missingMs: number;
  /** How long this gate has been answering null in this process. */
  heldMs: number;
}

/**
 * The gate's verdict on one loadPrStatus read, or null to keep polling. Pure.
 * Keep-polling is bounded (02 §11.1: a wait ends when CI finishes or stalls): once the wait's CI settled
 * more than `missingMs` ago and the gate has held for GATE_MIN_HOLD_MS, a gate still at CI_PENDING (a
 * missing expected check, or checks its GraphQL view still shows pending) or MERGEABLE_UNKNOWN ends
 * `stalled` (exit 14), naming what it waited on, instead of polling forever.
 */
export function gateVerdict(
  s: Pick<PrStatusState, 'snapshot' | 'ci' | 'evaluation'>,
  headSha: string,
  clock?: GateClock,
): GateResult | null {
  const snap = s.snapshot;
  if (snap.state !== 'OPEN' || snap.head.sha !== headSha) return null;
  const plan = s.evaluation.plan;
  const status = (code: string) => plan.checks.find((c) => c.code === code)?.status;
  const merge = {
    mergeable: snap.merge.mergeable,
    ready: s.evaluation.ready,
    blockers: plan.blockers.map((b) => b.code),
    waivers: plan.waivers.map((w) => w.code),
  };
  const settledFor = clock && clock.settledAt !== null ? clock.now - clock.settledAt : null;
  const overdue =
    clock !== undefined && settledFor !== null && settledFor > clock.missingMs && clock.heldMs >= GATE_MIN_HOLD_MS;
  const stuck = (reason: string, stalled: StalledCheck[] = []): GateResult => ({
    outcome: 'stalled',
    reason,
    merge,
    stalled,
    next: [`ghx pr status ${snap.ref}`],
  });
  if (status('MERGEABLE_UNKNOWN') === 'fail') return overdue ? stuck('mergeable-unknown') : null;
  if (status('CI_PENDING') === 'fail' && !s.ci.truncated) {
    if (!overdue || !clock || settledFor === null) return null;
    const entry = (name: string, state: StalledCheck['state']): StalledCheck => ({
      name,
      state,
      forSec: Math.floor(settledFor / 1000),
      thresholdSec: Math.round(clock.missingMs / 1000),
      basis: STALL_BASIS.missing,
    });
    const missing = s.ci.expectedMissing.filter((e) => e.state === 'missing');
    const stalled = [
      ...missing.map((e) => entry(e.name, 'missing')),
      ...s.ci.pending.map((p) => entry(p.name, p.status === 'queued' ? 'queued' : 'running')),
    ];
    return stuck(missing.length > 0 ? 'expected-missing' : 'gate-pending', stalled);
  }
  if (s.evaluation.ready) {
    const shared = s.ci.failing.length > 0 && status('CI_RED') === 'waived';
    return { outcome: shared ? 'red-shared' : 'green', reason: 'mergeable', merge };
  }
  const ciRed = merge.blockers.includes('CI_RED');
  return {
    outcome: 'red',
    reason: 'merge-blocked',
    merge,
    next: [...(ciRed ? [`ghx ci why ${snap.ref}`] : []), `ghx pr status ${snap.ref}`],
  };
}

/**
 * The settle hook for `--until mergeable`. `compareMain` follows --no-compare-main; with --check the
 * wait's aged-out baselines cover only the considered checks, so the gate falls back to the grace rule.
 */
export function createMergeGate(ctx: StreamContext, o: { compareMain: boolean; useAgedOut: boolean }): SettleHook {
  let failures = 0;
  /** When this gate started answering null (epoch ms); reset by any verdict. */
  let heldSince: number | null = null;
  return async ({ target, repo, headSha, agedOut, expected, checks, warn }) => {
    if (target.kind !== 'pr') throw new Error('unreachable: --until mergeable takes PR targets only');
    let state: PrStatusState;
    let missingMs = stallConfig().missingMinutes * 60_000;
    try {
      const { config, source } = await ctx.config({ ref: repo });
      missingMs = stallConfig(config.ci.stall).missingMinutes * 60_000;
      state = await loadPrStatus({
        gh: ctx.gh,
        clock: ctx.clock,
        artifacts: ctx.artifacts,
        signal: ctx.signal,
        repo,
        number: target.number,
        config,
        compareMain: o.compareMain,
        scope: 'ci-gate',
        ...(o.useAgedOut ? { agedOut } : {}),
        expectedDefs: expected,
        configSource: source,
      });
      failures = 0;
    } catch (e) {
      rethrowControlFlow(e);
      // Like a failed tick: a gh failure is retried on the next poll, up to MAX_GATE_FAILURES in a row.
      if (!(e instanceof GhFailure) || ++failures >= MAX_GATE_FAILURES) throw e;
      warn({
        code: 'MERGE_GATE_RETRY',
        message: `The merge gate could not be read (${e.message}); retrying on the next poll.`,
      });
      return null;
    }
    for (const w of state.warnings) warn(w);
    const now = ctx.clock.now();
    const verdict = gateVerdict(state, headSha, {
      now,
      settledAt: settledAt(checks),
      missingMs,
      heldMs: heldSince === null ? 0 : now - heldSince,
    });
    heldSince = verdict === null ? (heldSince ?? now) : null;
    return verdict;
  };
}
