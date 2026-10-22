// gh fixtures (03 §4.2, §6): canonical argv, matching, scenario loading. Shared by the in-process
// FakeGh (test/helpers/fake-gh.ts) and the fake `gh` binary (test/fixtures/bin/gh), so both replay
// recorded output the same way.
//
// Extension point: a scenario is a directory test/fixtures/gh/<scenario>/ of NNN-<slug>.json files in
// the GhFixture shape (src/proc/recording.ts writes exactly this). File order is reply order for
// fixtures with the same canonical argv; the last one repeats. No central file is edited.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { editDistance } from '../../src/core/suggest.ts';

export const GH_FIXTURE_ROOT = join(import.meta.dirname, '..', 'fixtures', 'gh');

export type FixtureSource = 'live:sandbox' | 'live:public' | 'synthetic' | 'corpus-shape';

export interface GhReply {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Fixture-relative file whose bytes become stdout (logs). */
  stdoutFile?: string;
  /** Resolved on the FakeClock in-process; real milliseconds in the bin. */
  delayMs?: number;
  /** Never replies until the caller aborts (in-process) or the process is signalled (bin). */
  hang?: true;
}

export interface GhFixture extends GhReply {
  /** Without the leading 'gh'. */
  argv: string[];
  /** Matched for writes. */
  stdin?: { json: unknown } | { text: string };
  meta: { source: FixtureSource; recordedAt?: string; ghVersion?: string; note?: string };
}

export interface LoadedFixture extends GhFixture {
  /** File name within the scenario, for messages. */
  file: string;
  /** Absolute scenario directory (stdoutFile is relative to it). */
  dir: string;
}

const REPO_FLAGS = new Set(['-R', '--repo']);
const HEADER_FLAGS = new Set(['-H', '--header']);
const FIELD_FLAGS = new Set(['-f', '-F', '--field', '--raw-field']);

function normaliseRepo(v: string): string {
  const parts = v.replace(/\.git$/, '').split('/');
  return parts.length === 2 ? `github.com/${v}` : v;
}

/**
 * Canonical argv: -R/--repo values become host/owner/name; -H and -f/-F pairs are sorted and moved
 * after the other tokens (their relative order never matters to gh). Everything else keeps its order.
 */
export function canonicalArgv(argv: readonly string[]): string[] {
  const rest: string[] = [];
  const headers: string[] = [];
  const fields: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    if (REPO_FLAGS.has(flag)) {
      rest.push('-R', normaliseRepo(inline ?? argv[++i] ?? ''));
    } else if (HEADER_FLAGS.has(flag)) {
      headers.push(inline ?? argv[++i] ?? '');
    } else if (FIELD_FLAGS.has(flag)) {
      const short = flag === '--raw-field' ? '-f' : flag === '--field' ? '-F' : flag;
      fields.push(`${short} ${inline ?? argv[++i] ?? ''}`);
    } else {
      rest.push(a);
    }
  }
  return [
    ...rest,
    ...headers.sort().flatMap((h) => ['-H', h]),
    ...fields.sort().flatMap((f) => {
      const sp = f.indexOf(' ');
      return [f.slice(0, sp), f.slice(sp + 1)];
    }),
  ];
}

export function argvKey(argv: readonly string[]): string {
  return JSON.stringify(canonicalArgv(argv));
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

export function stdinMatches(fixture: GhFixture, stdin: string | undefined): boolean {
  if (!fixture.stdin) return true;
  if (stdin === undefined) return false;
  if ('text' in fixture.stdin) return fixture.stdin.text === stdin;
  try {
    return deepEqual(fixture.stdin.json, JSON.parse(stdin));
  } catch {
    return false;
  }
}

export function resolveScenarioDir(nameOrPath: string): string {
  return isAbsolute(nameOrPath) ? nameOrPath : join(GH_FIXTURE_ROOT, nameOrPath);
}

/** Load test/fixtures/gh/<scenario>/*.json in file order (files starting with `_` are metadata). */
export function loadScenario(nameOrPath: string): LoadedFixture[] {
  const dir = resolveScenarioDir(nameOrPath);
  if (!existsSync(dir)) throw new Error(`fake gh: scenario '${nameOrPath}' not found at ${dir}`);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort()
    .map((file) => {
      const raw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Partial<GhFixture>;
      if (!Array.isArray(raw.argv)) throw new Error(`fake gh: ${dir}/${file} has no argv`);
      return {
        argv: raw.argv,
        exitCode: raw.exitCode ?? 0,
        stdout: raw.stdout ?? '',
        stderr: raw.stderr ?? '',
        ...(raw.stdin ? { stdin: raw.stdin } : {}),
        ...(raw.stdoutFile ? { stdoutFile: raw.stdoutFile } : {}),
        ...(raw.delayMs !== undefined ? { delayMs: raw.delayMs } : {}),
        ...(raw.hang ? { hang: true as const } : {}),
        meta: raw.meta ?? { source: 'synthetic' },
        file,
        dir,
      };
    });
}

/** Bytes of a fixture's stdout: its stdoutFile when present, else `stdout`. */
export function replyStdout(f: LoadedFixture): string {
  return f.stdoutFile ? readFileSync(join(f.dir, f.stdoutFile), 'utf8') : f.stdout;
}

export class FakeGhUnmatched extends Error {
  readonly argv: string[];
  readonly nearest: string[];
  constructor(argv: readonly string[], nearest: string[]) {
    super(
      `fake gh: no fixture matches 'gh ${argv.join(' ')}'.${nearest.length ? ` Nearest: ${nearest.map((n) => `'gh ${n}'`).join(', ')}` : ''}`,
    );
    this.name = 'FakeGhUnmatched';
    this.argv = [...argv];
    this.nearest = nearest;
  }
}

export interface MatchState {
  /** How many times each canonical argv has been answered. */
  counts: Record<string, number>;
}

/**
 * Pick the reply for a call: the fixtures whose canonical argv (and stdin, if they pin it) match, in
 * file order; the Nth call gets the Nth such fixture, and the last one repeats. Throws FakeGhUnmatched
 * naming the three nearest fixtures by edit distance.
 */
export function pickFixture(
  fixtures: readonly LoadedFixture[],
  argv: readonly string[],
  stdin: string | undefined,
  state: MatchState,
): LoadedFixture {
  const key = argvKey(argv);
  const candidates = fixtures.filter((f) => argvKey(f.argv) === key && stdinMatches(f, stdin));
  if (candidates.length === 0) {
    const want = canonicalArgv(argv).join(' ');
    const nearest = [...new Set(fixtures.map((f) => canonicalArgv(f.argv).join(' ')))]
      .map((s) => ({ s, d: editDistance(want, s) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3)
      .map((x) => x.s);
    throw new FakeGhUnmatched(argv, nearest);
  }
  const n = state.counts[key] ?? 0;
  state.counts[key] = n + 1;
  return candidates[Math.min(n, candidates.length - 1)] as LoadedFixture;
}

/**
 * A minimal ProcessRunner replaying a scenario for `gh` calls; anything else goes to `other` (or
 * fails). test/helpers/fake-gh.ts builds the full double (timelines, assertions) on the same matcher.
 */
export function replayGh(
  nameOrPath: string,
  other?: import('../../src/proc/runner.ts').ProcessRunner,
): import('../../src/proc/runner.ts').ProcessRunner {
  const fixtures = loadScenario(nameOrPath);
  const state: MatchState = { counts: {} };
  return async (req) => {
    const isGh = req.cmd === 'gh' || req.cmd.endsWith('/gh');
    if (!isGh) {
      if (other) return other(req);
      throw new Error(`replayGh: unexpected ${req.cmd} ${req.args.join(' ')}`);
    }
    const f = pickFixture(fixtures, req.args, req.stdin, state);
    return {
      exitCode: f.exitCode,
      signal: null,
      stdout: replyStdout(f),
      stderr: f.stderr,
      timedOut: false,
      aborted: false,
      durationMs: 0,
    };
  };
}
