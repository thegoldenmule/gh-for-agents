// ci wait --until mergeable (02 §11.2; 03 M6.6). Once the wait's CI has settled, the merge CI gate
// (02 §8.2 rows 6–12) decides the outcome through loadPrStatus with scope 'ci-gate', so `merge.ready`
// means what pr status and pr merge mean by it. Ready implies MERGEABLE (UNKNOWN and CONFLICTING block).
// Keep polling (null) while mergeable or mergeStateStatus is UNKNOWN, while the snapshot is for another
// head or a closed PR (the poller reports both on its next tick), and while the snapshot's CI view still
// has pending or unregistered checks: it is read through GraphQL, the wait through REST, and the two can
// lag each other by a poll. A truncated rollup is final.
import type { StreamContext } from '../../core/command.ts';
import { rethrowControlFlow } from '../../core/control-flow.ts';
import { GhFailure } from '../../gh/index.ts';
import { loadPrStatus, type PrStatusState } from '../../pr/status/compose.ts';
import type { Outcome, TargetSummary } from '../../schemas/ci.ts';
import type { SettleHook } from './driver.ts';

/** Consecutive failed gate reads (gh failures) before the wait gives up (error document, exit 7). */
export const MAX_GATE_FAILURES = 5;

export interface GateResult {
  outcome: Outcome;
  reason: string;
  merge: NonNullable<TargetSummary['merge']>;
  next?: string[];
}

/** The gate's verdict on one loadPrStatus read, or null to keep polling. Pure. */
export function gateVerdict(
  s: Pick<PrStatusState, 'snapshot' | 'ci' | 'evaluation'>,
  headSha: string,
): GateResult | null {
  const snap = s.snapshot;
  if (snap.state !== 'OPEN' || snap.head.sha !== headSha) return null;
  const plan = s.evaluation.plan;
  const status = (code: string) => plan.checks.find((c) => c.code === code)?.status;
  if (status('MERGEABLE_UNKNOWN') === 'fail') return null;
  if (status('CI_PENDING') === 'fail' && !s.ci.truncated) return null;
  const merge = {
    mergeable: snap.merge.mergeable,
    ready: s.evaluation.ready,
    blockers: plan.blockers.map((b) => b.code),
    waivers: plan.waivers.map((w) => w.code),
  };
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
  return async ({ target, repo, headSha, agedOut, warn }) => {
    if (target.kind !== 'pr') throw new Error('unreachable: --until mergeable takes PR targets only');
    let state: PrStatusState;
    try {
      const { config } = await ctx.config({ ref: repo });
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
    return gateVerdict(state, headSha);
  };
}
