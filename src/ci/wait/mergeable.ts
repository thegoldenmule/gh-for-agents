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
import { repoSlug } from '../../gh/types.ts';
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
 * a few polls, so a short UNKNOWN or REST/GraphQL lag is always ridden out.
 */
export const GATE_MIN_HOLD_MS = 60_000;

/** The clocks behind the gate's own bound, all local (epoch ms, or ms). */
export interface GateClock {
  now: number;
  /**
   * When this gate first saw its own (GraphQL, unfiltered) CI view with every check complete, by the local
   * clock; null while any is pending. Local, not GitHub's completedAt, so clock skew cannot shorten or
   * remove the bound, and `--check` cannot make unselected running checks look settled.
   */
  settledSince: number | null;
  /** ci.stall.missingMinutes in ms: how long after that an expected check may still be missing. */
  missingMs: number;
  /** How long this gate has been answering null in this process. */
  heldMs: number;
}

/**
 * The gate's verdict on one loadPrStatus read, or null to keep polling. Pure.
 * Keep-polling is bounded (02 §11.1: a wait ends when CI finishes or stalls): once the gate's own CI view
 * has had nothing pending for more than `missingMs` and the gate has held for GATE_MIN_HOLD_MS, a gate
 * still at CI_PENDING for a missing expected check (`expected-missing`) or at MERGEABLE_UNKNOWN
 * (`mergeable-unknown`) ends `stalled` (exit 14) instead of polling forever. A check still pending in that
 * view keeps it polling: running checks end on their own (GitHub's job timeouts, the wait's stall rules).
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
  const settledFor = clock && clock.settledSince !== null ? clock.now - clock.settledSince : null;
  const overdue =
    clock !== undefined &&
    settledFor !== null &&
    s.ci.pending.length === 0 &&
    settledFor > clock.missingMs &&
    clock.heldMs >= GATE_MIN_HOLD_MS;
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
    const missing = s.ci.expectedMissing.filter((e) => e.state === 'missing');
    if (missing.length === 0) return null;
    return stuck(
      'expected-missing',
      missing.map((e) => ({
        name: e.name,
        state: 'missing' as const,
        forSec: Math.floor(settledFor / 1000),
        thresholdSec: Math.round(clock.missingMs / 1000),
        basis: STALL_BASIS.missing,
      })),
    );
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

/** One target's gate state: consecutive read failures and the local clocks behind its bound. */
interface TargetGate {
  failures: number;
  heldSince: number | null;
  settledSince: number | null;
}

/**
 * The gate's per-target state (`ci wait 12 13 --until mergeable` shares one gate), keyed by repo, PR and
 * head, so one PR's hold or settle time never counts for another. Exported for tests.
 */
export function createGateClocks() {
  const byTarget = new Map<string, TargetGate>();
  const get = (key: string): TargetGate => {
    let g = byTarget.get(key);
    if (!g) {
      g = { failures: 0, heldSince: null, settledSince: null };
      byTarget.set(key, g);
    }
    return g;
  };
  return {
    get,
    /** The GateClock for this read: `settled` is the gate's own view with nothing pending. */
    clock(key: string, now: number, settled: boolean, missingMs: number): GateClock {
      const g = get(key);
      g.settledSince = settled ? (g.settledSince ?? now) : null;
      return { now, settledSince: g.settledSince, missingMs, heldMs: g.heldSince === null ? 0 : now - g.heldSince };
    },
    /** After a verdict: null keeps the hold running, an answer resets it. */
    answered(key: string, now: number, verdict: GateResult | null): void {
      const g = get(key);
      g.heldSince = verdict === null ? (g.heldSince ?? now) : null;
    },
  };
}

/**
 * The settle hook for `--until mergeable`. `compareMain` follows --no-compare-main; with --check the
 * wait's aged-out baselines cover only the considered checks, so the gate falls back to the grace rule.
 */
export function createMergeGate(ctx: StreamContext, o: { compareMain: boolean; useAgedOut: boolean }): SettleHook {
  const clocks = createGateClocks();
  return async ({ target, repo, headSha, agedOut, expected, warn }) => {
    if (target.kind !== 'pr') throw new Error('unreachable: --until mergeable takes PR targets only');
    const key = `${repoSlug(repo)}#${target.number}@${headSha}`;
    const g = clocks.get(key);
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
      g.failures = 0;
    } catch (e) {
      rethrowControlFlow(e);
      // Like a failed tick: a gh failure is retried on the next poll, up to MAX_GATE_FAILURES in a row.
      if (!(e instanceof GhFailure) || ++g.failures >= MAX_GATE_FAILURES) throw e;
      warn({
        code: 'MERGE_GATE_RETRY',
        message: `The merge gate could not be read (${e.message}); retrying on the next poll.`,
      });
      return null;
    }
    for (const w of state.warnings) warn(w);
    const now = ctx.clock.now();
    // Settled as the gate sees it: its own unfiltered view (the wait's checks may be --check-filtered).
    const settled = settledAt(state.snapshot.ci.checks) !== null;
    const verdict = gateVerdict(state, headSha, clocks.clock(key, now, settled, missingMs));
    clocks.answered(key, now, verdict);
    return verdict;
  };
}
