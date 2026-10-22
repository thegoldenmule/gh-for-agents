// The poll interval (02 §11.6; 03 M4.2). Pure: phase, ETA, session kind and rate budget in; one sleep out.
//
// Order: the table below, then ×4 when under 10% of the rate budget remains, then ±10% jitter, then
// the floors that must hold after jitter (an exhausted budget waits until its reset; an unattended
// session never polls faster than every 30 s).
import type { Random } from '../../core/random.ts';
import { jitter } from '../../core/random.ts';
import type { RateBudget } from '../../gh/ratelimit.ts';
import type { EtaEstimate } from './eta.ts';
import type { CiPhase } from './expected.ts';

export const INTERVAL = {
  registeringSec: 10,
  nearCompletionSec: 10,
  /** "Within 60 s of an expected completion". */
  nearWindowSec: 60,
  overrunSec: 30,
  /** Pending checks but no baseline to divide: the overrun cadence. */
  noEtaSec: 30,
  runningMinSec: 15,
  runningMaxSec: 60,
  /** eta / 6. */
  etaDivisor: 6,
  unattendedFloorSec: 30,
  jitterFraction: 0.1,
  rateLowFraction: 0.1,
  rateMultiplier: 4,
} as const;

export type IntervalReason = 'registering' | 'near-completion' | 'overrun' | 'eta' | 'no-eta';

/** The table row for a phase and ETA, in seconds, before rate, jitter and floors. */
export function baseIntervalSec(
  phase: CiPhase,
  estimate: Pick<EtaEstimate, 'eta' | 'soonestSec' | 'overrun'> | null,
): { sec: number; reason: IntervalReason } {
  if (phase === 'registering') return { sec: INTERVAL.registeringSec, reason: 'registering' };
  if (!estimate?.eta) return { sec: INTERVAL.noEtaSec, reason: 'no-eta' };
  if (estimate.overrun) return { sec: INTERVAL.overrunSec, reason: 'overrun' };
  if (estimate.soonestSec !== null && estimate.soonestSec <= INTERVAL.nearWindowSec) {
    return { sec: INTERVAL.nearCompletionSec, reason: 'near-completion' };
  }
  const sec = Math.min(
    INTERVAL.runningMaxSec,
    Math.max(INTERVAL.runningMinSec, estimate.eta.seconds / INTERVAL.etaDivisor),
  );
  return { sec, reason: 'eta' };
}

/** 4 when under 10% of the budget remains, else 1. */
export function rateMultiplier(budget: RateBudget | undefined): number {
  if (!budget || budget.limit <= 0) return 1;
  return budget.remaining / budget.limit < INTERVAL.rateLowFraction ? INTERVAL.rateMultiplier : 1;
}

export interface IntervalInput {
  phase: CiPhase;
  estimate: Pick<EtaEstimate, 'eta' | 'soonestSec' | 'overrun'> | null;
  /** CLAUDE_CODE_SESSION_ATTENDED === "1". */
  attended: boolean;
  /** The last observed budget of the resource being polled. */
  budget?: RateBudget | undefined;
  /** Epoch ms (for the budget's resetAt). */
  now: number;
  random: Random;
}

export interface IntervalDecision {
  /** The sleep before the next tick. */
  ms: number;
  reason: IntervalReason;
  /** Under 10% left, or exhausted: emit a `rate-limit` event. */
  rateLimited: boolean;
  /** Epoch ms the poll waits for when the budget is exhausted; null otherwise. */
  pausedUntil: number | null;
}

export function pollInterval(i: IntervalInput): IntervalDecision {
  const base = baseIntervalSec(i.phase, i.estimate);
  const mult = rateMultiplier(i.budget);
  let ms = jitter(base.sec * 1000 * mult, INTERVAL.jitterFraction, i.random);
  const exhausted = i.budget !== undefined && i.budget.remaining <= 0;
  const pausedUntil = exhausted && i.budget ? i.budget.resetAt : null;
  if (pausedUntil !== null) ms = Math.max(ms, pausedUntil - i.now);
  if (!i.attended) ms = Math.max(ms, INTERVAL.unattendedFloorSec * 1000);
  return { ms: Math.ceil(ms), reason: base.reason, rateLimited: mult > 1 || exhausted, pausedUntil };
}
