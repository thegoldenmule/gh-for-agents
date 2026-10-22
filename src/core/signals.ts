// Graceful shutdown (01 §3.6). The first SIGINT/SIGTERM/SIGHUP (or EPIPE on stdout) aborts the
// shutdown signal with GhxError('INTERRUPTED'); handlers that catch it may return a summary. A grace
// window (3 s on the Clock) bounds how long the runner waits; a second signal skips it.
// This is the only module allowed to call process.exit (architecture.test.ts).
import type { Clock } from './clock.ts';
import { formatDuration } from './duration.ts';
import { GhxError, isGhxError } from './errors.ts';

export const GRACE_MS = 3_000;

export type ShutdownCause = 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'EPIPE';

export interface Shutdown {
  /** Aborts on the first trigger, with a GhxError('INTERRUPTED', {details:{signal}}) reason. */
  readonly signal: AbortSignal;
  /** The cause of the first trigger, if any. */
  readonly cause: ShutdownCause | undefined;
  /** How many triggers have been seen. */
  readonly count: number;
  /** Resolves on the second trigger (force). */
  readonly forced: Promise<void>;
  trigger(cause: ShutdownCause): void;
}

export function createShutdown(): Shutdown {
  const controller = new AbortController();
  let cause: ShutdownCause | undefined;
  let count = 0;
  let force!: () => void;
  const forced = new Promise<void>((r) => {
    force = r;
  });
  return {
    signal: controller.signal,
    get cause() {
      return cause;
    },
    get count() {
      return count;
    },
    forced,
    trigger(c) {
      count++;
      if (count === 1) {
        cause = c;
        controller.abort(
          new GhxError('INTERRUPTED', c === 'EPIPE' ? 'stdout reader went away.' : `Interrupted by ${c}.`, {
            details: { signal: c },
          }),
        );
      } else if (count === 2) {
        force();
      }
    },
  };
}

interface SignalSource {
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
}

/** Route process signals into `shutdown`. Returns an uninstaller. */
export function installSignalHandlers(shutdown: Shutdown, source: SignalSource): () => void {
  const handlers: [string, () => void][] = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((s) => [
    s,
    () => shutdown.trigger(s),
  ]);
  for (const [s, h] of handlers) source.on(s, h);
  return () => {
    for (const [s, h] of handlers) source.off(s, h);
  };
}

/** The forced-shutdown path: called only after the terminal line has been awaited. */
export function forceExit(code: number): never {
  process.exit(code);
}

export interface Deadline {
  readonly signal: AbortSignal;
  /** clock.monotonic() at which the signal fires; undefined for no deadline. */
  readonly at: number | undefined;
  cancel(): void;
}

/**
 * A deadline composed with a parent signal (the shutdown). `ms: null` means no deadline: only the
 * parent can abort. On expiry the reason is GhxError('TIMEOUT', {details:{deadlineMs}}).
 */
export function createDeadline(clock: Clock, ms: number | null, parent: AbortSignal, what = 'command'): Deadline {
  const own = new AbortController();
  const stop = new AbortController();
  if (ms !== null) {
    clock.sleep(ms, AbortSignal.any([stop.signal, parent])).then(
      () =>
        own.abort(
          new GhxError('TIMEOUT', `${what} exceeded its ${formatDuration(ms)} deadline.`, {
            details: { deadlineMs: ms },
          }),
        ),
      () => {},
    );
  }
  return {
    signal: AbortSignal.any([parent, own.signal]),
    at: ms === null ? undefined : clock.monotonic() + ms,
    cancel: () => stop.abort(),
  };
}

/** True for the aborts the runner turns into INTERRUPTED/TIMEOUT. Handlers use it for the graceful-summary pattern. */
export function isAbort(e: unknown): boolean {
  return isGhxError(e, 'INTERRUPTED') || isGhxError(e, 'TIMEOUT') || (e instanceof Error && e.name === 'AbortError');
}

export type GraceResult<T> = { settled: true; value: T } | { settled: true; error: unknown } | { settled: false };

/**
 * After shutdown, wait for `work` up to the grace window, or until a second signal. `settled: false`
 * means the runner must abandon the work and emit INTERRUPTED itself.
 */
export async function withinGrace<T>(
  work: Promise<T>,
  o: { clock: Clock; shutdown: Shutdown; graceMs?: number },
): Promise<GraceResult<T>> {
  const stop = new AbortController();
  const timeout = o.clock.sleep(o.graceMs ?? GRACE_MS, stop.signal).then(
    () => ({ settled: false }) as const,
    () => ({ settled: false }) as const,
  );
  const forced = o.shutdown.forced.then(() => ({ settled: false }) as const);
  const done = work.then(
    (value) => ({ settled: true, value }) as const,
    (error: unknown) => ({ settled: true, error }) as const,
  );
  try {
    return await Promise.race([done, timeout, forced]);
  } finally {
    stop.abort();
  }
}
