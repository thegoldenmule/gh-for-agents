// Transient retry with jittered exponential backoff, honoring Retry-After, never past the deadline (01 §4.3).
import type { Clock } from '../core/clock.ts';
import { jitter, type Random, realRandom } from '../core/random.ts';

export interface RetryPolicy {
  attempts: number;
  baseMs: number;
  maxMs: number;
  jitter: number;
  /** A write that is safe to repeat (e.g. a merge pinned with --match-head-commit) may opt in. */
  idempotent?: boolean;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseMs: 500, maxMs: 8_000, jitter: 0.25 };

/** Wait before attempt `attempt + 1` (attempt is 1-based). Retry-After wins when longer. */
export function backoffMs(attempt: number, p: RetryPolicy, random: Random, retryAfterMs?: number): number {
  const exp = Math.min(p.maxMs, p.baseMs * 2 ** (attempt - 1));
  const j = jitter(exp, p.jitter, random);
  return retryAfterMs !== undefined ? Math.max(j, retryAfterMs) : j;
}

export interface RetryDecision {
  retry: boolean;
  retryAfterMs?: number | undefined;
}

/**
 * Run `fn` up to `policy.attempts` times. After each failure `decide(error)` says whether it is
 * transient. Stops early when the next wait would cross `deadline` (clock.monotonic()). The last
 * error is rethrown; `attempts` is reported through `onAttempt`.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  o: {
    policy: RetryPolicy | 'none';
    clock: Clock;
    signal: AbortSignal;
    deadline?: number | undefined;
    /** `attempt` is the 1-based attempt that just failed. */
    decide: (e: unknown, attempt: number) => RetryDecision;
    random?: Random;
    onRetry?: (attempt: number, waitMs: number, e: unknown) => void;
  },
): Promise<T> {
  const policy = o.policy === 'none' ? { ...DEFAULT_RETRY, attempts: 1 } : o.policy;
  const random = o.random ?? realRandom;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (o.signal.aborted || attempt >= policy.attempts) throw e;
      const d = o.decide(e, attempt);
      if (!d.retry) throw e;
      const wait = backoffMs(attempt, policy, random, d.retryAfterMs);
      if (o.deadline !== undefined && o.clock.monotonic() + wait >= o.deadline) throw e;
      o.onRetry?.(attempt, wait, e);
      await o.clock.sleep(wait, o.signal);
    }
  }
}
