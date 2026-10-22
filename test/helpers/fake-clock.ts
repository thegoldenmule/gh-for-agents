// FakeClock (01 §3.6): time moves only when a test advances it, so a 45-minute wait runs in milliseconds.
import type { Clock } from '../../src/core/clock.ts';

interface Timer {
  id: number;
  at: number;
  resolve: () => void;
}

/** Let pending promise chains settle: microtasks plus a few macrotask turns. */
export async function flush(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

export class FakeClock implements Clock {
  #mono = 0;
  readonly #epoch: number;
  #timers: Timer[] = [];
  #nextId = 1;

  constructor(startEpochMs = Date.UTC(2026, 9, 22, 12, 0, 0)) {
    this.#epoch = startEpochMs;
  }

  now(): number {
    return this.#epoch + this.#mono;
  }

  monotonic(): number {
    return this.#mono;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const id = this.#nextId++;
      const onAbort = (): void => {
        this.#timers = this.#timers.filter((t) => t.id !== id);
        reject(signal?.reason);
      };
      this.#timers.push({
        id,
        at: this.#mono + ms,
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Move time forward by `ms`, firing due timers in order and letting their continuations run. */
  async advance(ms: number): Promise<void> {
    const target = this.#mono + ms;
    await flush();
    for (;;) {
      const due = this.#timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.#timers = this.#timers.filter((t) => t !== due);
      this.#mono = Math.max(this.#mono, due.at);
      due.resolve();
      await flush();
    }
    this.#mono = target;
    await flush();
  }

  /** Advance in `stepMs` steps until `pred()` holds; throws after `maxMs` of fake time. */
  async runUntil(pred: () => boolean, o: { stepMs?: number; maxMs?: number } = {}): Promise<void> {
    const step = o.stepMs ?? 1_000;
    const limit = this.#mono + (o.maxMs ?? 3_600_000);
    await flush();
    while (!pred()) {
      if (this.#mono >= limit)
        throw new Error(`FakeClock.runUntil: condition not met within ${o.maxMs ?? 3_600_000} ms`);
      await this.advance(step);
    }
  }

  pendingTimers(): number {
    return this.#timers.length;
  }
}
