// FakeGh (03 §4.2): a ProcessRunner for createGh({proc}) that replays fixtures, so commands run exactly
// as in production down to the spawn. Replies come from, in order: the timeline step active at
// clock.monotonic(), then on() rules (later rules win), then the scenario's fixtures. An unmatched
// call throws FakeGhUnmatched naming the nearest fixtures; a test never silently gets an empty reply.
import { copyFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isMutating } from '../../src/gh/guard.ts';
import type { ProcessRunner, ProcRequest, ProcResult } from '../../src/proc/runner.ts';
import type { FakeClock } from './fake-clock.ts';
import {
  argvKey,
  canonicalArgv,
  FakeGhUnmatched,
  GH_FIXTURE_ROOT,
  type GhReply,
  type LoadedFixture,
  loadScenario,
  type MatchState,
  pickFixture,
  replyStdout,
} from './fixture-match.ts';

export type { GhReply } from './fixture-match.ts';
export { FakeGhUnmatched } from './fixture-match.ts';

export type ArgvMatcher = string[] | { prefix: string[] } | ((argv: string[], stdin?: string) => boolean);

export interface FakeGhCall {
  argv: string[];
  stdin?: string;
  env: Record<string, string | undefined>;
  /** clock.monotonic() at the call (0 without a clock). */
  at: number;
}

interface Rule {
  m: ArgvMatcher;
  replies: GhReply[];
  used: number;
}

interface TimelineStep {
  atMs: number;
  on: [ArgvMatcher, GhReply][];
}

export function matches(m: ArgvMatcher, argv: readonly string[], stdin?: string): boolean {
  if (typeof m === 'function') return m([...argv], stdin);
  const canon = canonicalArgv(argv);
  if (Array.isArray(m)) return argvKey(m) === argvKey(argv);
  const prefix = canonicalArgv(m.prefix);
  return prefix.every((p, i) => canon[i] === p);
}

function describe(m: ArgvMatcher): string {
  if (typeof m === 'function') return '<predicate>';
  return Array.isArray(m) ? `gh ${m.join(' ')}` : `gh ${m.prefix.join(' ')} …`;
}

export class FakeGh {
  readonly calls: FakeGhCall[] = [];
  readonly #fixtures: LoadedFixture[];
  readonly #state: MatchState = { counts: {} };
  readonly #consumed = new Set<LoadedFixture>();
  readonly #rules: Rule[] = [];
  #timeline: TimelineStep[] = [];
  #clock: FakeClock | undefined;

  constructor(o: { clock?: FakeClock; fixtures?: LoadedFixture[] } = {}) {
    this.#clock = o.clock;
    this.#fixtures = o.fixtures ?? [];
  }

  /** Replay test/fixtures/gh/<scenario>/ (or an absolute directory). */
  static fromScenario(scenario: string, o: { clock?: FakeClock } = {}): FakeGh {
    return new FakeGh({ ...o, fixtures: loadScenario(scenario) });
  }

  /** Script a reply; an array replies in order and its last element repeats. Later rules win. */
  on(m: ArgvMatcher, reply: GhReply | GhReply[]): this {
    this.#rules.unshift({ m, replies: Array.isArray(reply) ? reply : [reply], used: 0 });
    return this;
  }

  /** Replies that change over fake time: the step with the latest atMs ≤ clock.monotonic() applies. */
  timeline(clock: FakeClock, steps: TimelineStep[]): this {
    this.#clock = clock;
    this.#timeline = [...steps].sort((a, b) => a.atMs - b.atMs);
    return this;
  }

  /** The runner for createGh / the harness. Non-gh calls go to `other`, or fail. */
  runner(other?: ProcessRunner): ProcessRunner {
    return async (req) => {
      if (!(req.cmd === 'gh' || req.cmd.endsWith('/gh'))) {
        if (other) return other(req);
        throw new Error(`FakeGh: unexpected non-gh call: ${req.cmd} ${req.args.join(' ')}`);
      }
      const argv = [...req.args];
      this.calls.push({
        argv,
        ...(req.stdin !== undefined ? { stdin: req.stdin } : {}),
        env: { ...req.env },
        at: this.#clock?.monotonic() ?? 0,
      });
      return this.#reply(req, this.#select(argv, req.stdin));
    };
  }

  #select(argv: string[], stdin: string | undefined): { reply: GhReply; dir?: string } {
    const now = this.#clock?.monotonic() ?? 0;
    const step = this.#timeline.filter((s) => s.atMs <= now).at(-1);
    const timed = step?.on.find(([m]) => matches(m, argv, stdin));
    if (timed) return { reply: timed[1] };
    const rule = this.#rules.find((r) => matches(r.m, argv, stdin));
    if (rule) {
      const reply = rule.replies[Math.min(rule.used, rule.replies.length - 1)] as GhReply;
      rule.used++;
      return { reply };
    }
    try {
      const f = pickFixture(this.#fixtures, argv, stdin, this.#state);
      this.#consumed.add(f);
      return { reply: { ...f, stdout: f.stdoutFile ? '' : f.stdout }, dir: f.dir };
    } catch (e) {
      if (e instanceof FakeGhUnmatched && this.#rules.length > 0 && this.#fixtures.length === 0) {
        throw new FakeGhUnmatched(argv, this.#rules.map((r) => describe(r.m).replace(/^gh /, '')).slice(0, 3));
      }
      throw e;
    }
  }

  async #reply(req: ProcRequest, sel: { reply: GhReply; dir?: string }): Promise<ProcResult> {
    const { reply } = sel;
    const aborted = (): ProcResult => ({
      exitCode: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: true,
      durationMs: 0,
    });
    if (reply.hang) {
      await new Promise<void>((resolve) => {
        if (req.signal.aborted) resolve();
        req.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return aborted();
    }
    if (reply.delayMs) {
      if (!this.#clock) throw new Error('FakeGh: delayMs needs a FakeClock');
      try {
        await this.#clock.sleep(reply.delayMs, req.signal);
      } catch {
        return aborted();
      }
    }
    let stdout = reply.stdout;
    if (reply.stdoutFile) {
      const src = isAbsolute(reply.stdoutFile) ? reply.stdoutFile : join(sel.dir ?? GH_FIXTURE_ROOT, reply.stdoutFile);
      if (req.stdoutFile) copyFileSync(src, req.stdoutFile);
      else stdout = replyStdout({ stdoutFile: src, dir: '/' } as LoadedFixture);
    } else if (req.stdoutFile) {
      writeFileSync(req.stdoutFile, stdout);
      stdout = '';
    }
    return {
      exitCode: reply.exitCode,
      signal: null,
      stdout,
      stderr: reply.stderr,
      timedOut: false,
      aborted: false,
      durationMs: 0,
    };
  }

  /** Assert the calls made. ordered: same order; exhaustive: no other calls. */
  expectCalls(expected: ArgvMatcher[], o: { ordered?: boolean; exhaustive?: boolean } = {}): void {
    const seen = this.calls.map((c) => c.argv);
    if (o.ordered) {
      let i = 0;
      for (const m of expected) {
        while (i < this.calls.length && !matches(m, this.calls[i]?.argv ?? [], this.calls[i]?.stdin)) i++;
        if (i >= this.calls.length)
          throw new Error(`FakeGh: expected ${describe(m)} (in order); calls were:\n${fmt(seen)}`);
        i++;
      }
    } else {
      for (const m of expected) {
        if (!this.calls.some((c) => matches(m, c.argv, c.stdin))) {
          throw new Error(`FakeGh: expected ${describe(m)}; calls were:\n${fmt(seen)}`);
        }
      }
    }
    if (o.exhaustive) {
      const extra = this.calls.filter((c) => !expected.some((m) => matches(m, c.argv, c.stdin)));
      if (extra.length > 0) throw new Error(`FakeGh: unexpected calls:\n${fmt(extra.map((c) => c.argv))}`);
    }
  }

  /** No call was classified as mutating by src/gh/guard.ts. */
  expectNoMutations(): void {
    const bad = this.calls.filter((c) => isMutating(c.argv));
    if (bad.length > 0) throw new Error(`FakeGh: mutating calls were made:\n${fmt(bad.map((c) => c.argv))}`);
  }

  expectNoCall(m: ArgvMatcher): void {
    const hit = this.calls.filter((c) => matches(m, c.argv, c.stdin));
    if (hit.length > 0) throw new Error(`FakeGh: ${describe(m)} was called:\n${fmt(hit.map((c) => c.argv))}`);
  }

  /** Every scenario fixture was replayed, and every scripted reply array was used up. */
  assertAllConsumed(): void {
    const unusedFixtures = this.#fixtures.filter((f) => !this.#consumed.has(f)).map((f) => f.file);
    const unusedRules = this.#rules.filter((r) => r.used < r.replies.length).map((r) => describe(r.m));
    if (unusedFixtures.length + unusedRules.length > 0) {
      throw new Error(`FakeGh: not consumed: ${[...unusedFixtures, ...unusedRules].join(', ')}`);
    }
  }
}

function fmt(argvs: string[][]): string {
  return argvs.map((a) => `  gh ${a.join(' ')}`).join('\n') || '  (none)';
}
