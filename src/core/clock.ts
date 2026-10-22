// The only module that touches real time (01 §3.6). Everything time-dependent takes a Clock, so tests
// drive a "10-minute" wait in milliseconds with test/helpers/fake-clock.ts. architecture.test.ts bans
// setTimeout/setInterval/Date.now/performance.now/timers/promises everywhere else in src/.
import { setTimeout as sleepTimer } from 'node:timers/promises';

export interface Clock {
  /** Epoch milliseconds, for timestamps. */
  now(): number;
  /** Monotonic milliseconds, for deadlines and intervals. */
  monotonic(): number;
  /** Resolves after `ms`; rejects with `signal.reason` if the signal aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  async sleep(ms, signal) {
    if (signal?.aborted) throw signal.reason;
    if (ms <= 0) return;
    try {
      await sleepTimer(ms, undefined, signal ? { signal } : {});
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      throw e;
    }
  },
};

/** ISO-8601 timestamp of `clock.now()`. */
export function isoNow(clock: Clock): string {
  return new Date(clock.now()).toISOString();
}
