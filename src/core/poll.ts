// Generic poll/backoff loop on the Clock (01 §3.6). Used by watchers and bounded retries such as
// `mergeable: UNKNOWN` (§5.2, §9.3).
import type { Clock } from './clock.ts';
import { jitter, type Random, realRandom } from './random.ts';

export interface PollInterval {
  initialMs: number;
  maxMs: number;
  factor: number;
  /** Fractional jitter, e.g. 0.1 for ±10%. */
  jitter: number;
}

export interface PollOptions<T> {
  probe(signal: AbortSignal): Promise<T>;
  done(value: T): boolean;
  interval: PollInterval;
  /**
   * Stretch hook for rate budgets (01 §4.4): given the backoff interval, return the interval to use.
   * Wire it to gh/ratelimit.ts `suggestInterval` with the gh client's last observed budget.
   */
  stretch?: (intervalMs: number) => number;
  onValue?(value: T, prev: T | undefined): void;
  clock: Clock;
  signal: AbortSignal;
  maxAttempts?: number;
  random?: Random;
}

/**
 * Yields each probed value that is not yet done. Returns the last value when `done(value)` holds or `maxAttempts` is
 * reached. An abort of `signal` rejects with its reason (from the probe or the sleep).
 */
export async function* poll<T>(o: PollOptions<T>): AsyncGenerator<T, T, void> {
  let prev: T | undefined;
  let interval = o.interval.initialMs;
  const random = o.random ?? realRandom;
  for (let attempt = 1; ; attempt++) {
    if (o.signal.aborted) throw o.signal.reason;
    const value = await o.probe(o.signal);
    o.onValue?.(value, prev);
    prev = value;
    if (o.done(value) || (o.maxAttempts !== undefined && attempt >= o.maxAttempts)) return value;
    yield value;
    const base = o.stretch ? o.stretch(interval) : interval;
    await o.clock.sleep(jitter(base, o.interval.jitter, random), o.signal);
    interval = Math.min(o.interval.maxMs, interval * o.interval.factor);
  }
}
