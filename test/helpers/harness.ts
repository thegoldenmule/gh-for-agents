// runInProcess (01 §1, 03 §4.2): drive runCli exactly as main.ts does, with fakes for process,
// clock, git and stdin. The environment is built from scratch, never inherited (03 §9 risk).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { combineRegistries, fsRegistry, type Registry, staticRegistry } from '../../src/cli/registry.ts';
import { type CliDeps, runCli } from '../../src/cli/run.ts';
import type { Clock } from '../../src/core/clock.ts';
import type { AnyCommandSpec } from '../../src/core/command.ts';
import { createMemorySink } from '../../src/core/output.ts';
import { type Random, seededRandom } from '../../src/core/random.ts';
import { createShutdown, type Shutdown } from '../../src/core/signals.ts';
import type { Gh } from '../../src/gh/index.ts';
import type { Git } from '../../src/git/index.ts';
import type { ProcessRunner, ProcRequest } from '../../src/proc/runner.ts';
import { VERSION } from '../../src/version.ts';
import { FakeClock } from './fake-clock.ts';
import { FakeProc } from './fake-proc.ts';

const ROOT = join(import.meta.dirname, '..', '..');
export const SRC_COMMANDS = join(ROOT, 'src', 'commands');
export const TEST_COMMANDS = join(ROOT, 'test', 'helpers', 'commands');

let scratch: string | undefined;
/** One temp dir per test process, removed at exit. */
export function scratchDir(): string {
  if (!scratch) {
    scratch = mkdtempSync(join(tmpdir(), 'ghx-harness-'));
    const dir = scratch;
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  }
  return scratch;
}

export interface HarnessOptions {
  /** Default: src/commands plus the test-only commands. */
  registry?: Registry;
  /** Extra in-memory specs (combined with the registry). */
  commands?: AnyCommandSpec[];
  proc?: ProcessRunner;
  /** Replace the gh client entirely (rarely needed; prefer `proc`). */
  gh?: (mode: 'read' | 'write', dryRun: boolean) => Gh;
  clock?: Clock;
  random?: Random;
  /** Merged over a minimal scratch env; nothing is inherited from process.env. */
  env?: Record<string, string | undefined>;
  cwd?: string;
  git?: Git;
  stdin?: string;
  files?: Record<string, string>;
  shutdown?: Shutdown;
  stdoutIsTTY?: boolean;
}

export interface HarnessResult {
  stdout: string;
  lines: string[];
  /** stdout parsed as one JSON document (undefined if it is not one). */
  json: any;
  exitCode: number;
  forced: boolean;
  calls: ProcRequest[];
  stderr: string[];
}

export function defaultRegistry(): Registry {
  return fsRegistry([SRC_COMMANDS, TEST_COMMANDS]);
}

export async function runInProcess(argv: string[], o: HarnessOptions = {}): Promise<HarnessResult> {
  const sink = createMemorySink();
  const calls: ProcRequest[] = [];
  const inner = o.proc ?? new FakeProc().runner();
  const proc: ProcessRunner = (req) => {
    calls.push(req);
    return inner(req);
  };
  const base = o.registry ?? defaultRegistry();
  const registry = o.commands ? combineRegistries(base, staticRegistry(o.commands)) : base;
  const stderr: string[] = [];
  const env = { PATH: '/usr/bin:/bin', GHX_ARTIFACT_DIR: join(scratchDir(), 'artifacts'), ...o.env };
  const deps: CliDeps = {
    registry,
    version: VERSION,
    cwd: o.cwd ?? scratchDir(),
    env,
    clock: o.clock ?? new FakeClock(),
    random: o.random ?? seededRandom(1),
    proc,
    stdout: sink,
    stderrLine: (l) => stderr.push(l),
    shutdown: o.shutdown ?? createShutdown(),
    stdoutIsTTY: o.stdoutIsTTY ?? false,
    readFile: async (p) => {
      const v = o.files?.[p];
      if (v === undefined) throw new Error(`ENOENT: no such file '${p}'`);
      return v;
    },
    readStdin: async () => o.stdin ?? '',
    ...(o.git ? { git: o.git } : {}),
    ...(o.gh ? { gh: o.gh } : {}),
  };
  const outcome = await runCli(argv, deps);
  const stdout = sink.text();
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = undefined;
  }
  return { stdout, lines: [...sink.lines], json, exitCode: outcome.exitCode, forced: outcome.forced, calls, stderr };
}
