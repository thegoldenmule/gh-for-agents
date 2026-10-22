// FakeProcessRunner (01 §1): scripted replies keyed by a request matcher; records every call. For gh
// specifically, prefer test/helpers/fake-gh.ts, which matches canonical gh argv against fixtures.
import type { ProcessRunner, ProcRequest, ProcResult } from '../../src/proc/runner.ts';
import type { FakeClock } from './fake-clock.ts';

export interface ProcReply {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** errno code for a spawn failure, e.g. 'ENOENT'. */
  spawnError?: string;
  /** Resolved on the FakeClock given to the constructor. */
  delayMs?: number;
  /** Never resolves until req.signal aborts. */
  hang?: true;
}

export type ProcMatcher = ((req: ProcRequest) => boolean) | { cmd: string; args?: readonly string[] };
type ReplySource = ProcReply | ProcReply[] | ((req: ProcRequest) => ProcReply);

export class FakeProcUnmatched extends Error {
  constructor(req: ProcRequest) {
    super(`FakeProc: no reply scripted for ${req.cmd} ${req.args.join(' ')}`);
    this.name = 'FakeProcUnmatched';
  }
}

function matches(m: ProcMatcher, req: ProcRequest): boolean {
  if (typeof m === 'function') return m(req);
  if (m.cmd !== req.cmd && !req.cmd.endsWith(`/${m.cmd}`)) return false;
  return (m.args ?? []).every((a, i) => req.args[i] === a);
}

export class FakeProc {
  readonly calls: ProcRequest[] = [];
  readonly #rules: { m: ProcMatcher; src: ReplySource; n: number }[] = [];
  readonly #clock: FakeClock | undefined;

  constructor(o: { clock?: FakeClock } = {}) {
    this.#clock = o.clock;
  }

  /** Later rules win over earlier ones. An array replies in order; its last element repeats. */
  on(m: ProcMatcher, src: ReplySource): this {
    this.#rules.unshift({ m, src, n: 0 });
    return this;
  }

  runner(): ProcessRunner {
    return async (req) => {
      this.calls.push(req);
      const rule = this.#rules.find((r) => matches(r.m, req));
      if (!rule) throw new FakeProcUnmatched(req);
      const reply: ProcReply =
        typeof rule.src === 'function'
          ? rule.src(req)
          : Array.isArray(rule.src)
            ? (rule.src[Math.min(rule.n, rule.src.length - 1)] ?? {})
            : rule.src;
      rule.n++;
      return this.#reply(req, reply);
    };
  }

  async #reply(req: ProcRequest, reply: ProcReply): Promise<ProcResult> {
    const base: ProcResult = {
      exitCode: reply.exitCode ?? 0,
      signal: null,
      stdout: reply.stdout ?? '',
      stderr: reply.stderr ?? '',
      timedOut: false,
      aborted: false,
      durationMs: 0,
    };
    if (reply.spawnError) {
      const e = Object.assign(new Error(`spawn ${req.cmd} ${reply.spawnError}`), {
        code: reply.spawnError,
      }) as NodeJS.ErrnoException;
      return { ...base, exitCode: null, spawnError: e };
    }
    if (reply.hang) {
      await new Promise<void>((resolve) => {
        if (req.signal.aborted) resolve();
        req.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { ...base, exitCode: null, signal: 'SIGTERM', aborted: true };
    }
    if (reply.delayMs && this.#clock) {
      try {
        await this.#clock.sleep(reply.delayMs, req.signal);
      } catch {
        return { ...base, exitCode: null, signal: 'SIGTERM', aborted: true };
      }
    }
    return base;
  }
}
