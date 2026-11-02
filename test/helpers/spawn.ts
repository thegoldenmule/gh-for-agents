// Spawn bin/ghx.js the way an agent does: through pipes, with an environment built from scratch
// (never process.env: agent sessions set CLAUDE_CODE_SESSION_ATTENDED, 03 §3.6).
//
// GHX_TEST_BIN=<path> runs that executable instead (a standalone binary, pnpm build:bin):
//   GHX_TEST_BIN=dist-bin/ghx-darwin-arm64 pnpm test:contract
// Tests that need the test-only commands (`ghx test …`) skip unless the binary serves them, which is
// probed once (a binary built with pnpm build:bin --test-hooks does). Tests that run node on bin/ghx.js
// itself skip under GHX_TEST_BIN.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scratchDir } from './harness.ts';

export const BIN = join(import.meta.dirname, '..', '..', 'bin', 'ghx.js');
/** The standalone binary under test (GHX_TEST_BIN, relative to the repo root), or undefined for node bin/ghx.js. */
export const TEST_BIN: string | undefined = process.env.GHX_TEST_BIN
  ? resolve(join(import.meta.dirname, '..', '..'), process.env.GHX_TEST_BIN)
  : undefined;

/** Whether `ghx test …` exists (always for bin/ghx.js; for a binary, only a --test-hooks build). */
export const TEST_HOOKS: boolean =
  TEST_BIN === undefined ||
  spawnSync(TEST_BIN, ['test', 'echo'], { env: { GHX_TEST_HOOKS: '1', PATH: '/usr/bin:/bin' }, stdio: 'ignore' })
    .status === 0;
/** `{ skip }` for a test that needs the test-only commands. */
export const needsTestHooks: { skip: string | false } = {
  skip: TEST_HOOKS ? false : 'needs the test-only commands: GHX_TEST_BIN was not built with --test-hooks',
};
/** `{ skip }` for a test that runs node on bin/ghx.js itself, not the program under test. */
export const needsNodeBin: { skip: string | false } = {
  skip: TEST_BIN === undefined ? false : 'runs node bin/ghx.js itself, not GHX_TEST_BIN',
};
export const FAKE_BIN_DIR = join(import.meta.dirname, '..', 'fixtures', 'bin');

export interface SpawnOptions {
  env?: Record<string, string | undefined>;
  /** Prepend test/fixtures/bin (the fake gh) to PATH. */
  fakeGh?: boolean;
  /** Keep stdin as an open pipe that is never written or closed. */
  openStdin?: boolean;
  stdin?: string;
  cwd?: string;
  timeoutMs?: number;
  /** Called with the child once spawned (signal tests). */
  onSpawn?: (child: import('node:child_process').ChildProcess) => void;
}

export interface SpawnResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** A directory holding only a `node` symlink, so scripts with `#!/usr/bin/env node` run without the rest of PATH. */
export function nodeBinDir(): string {
  const dir = join(scratchDir(), 'nodebin');
  if (!existsSync(join(dir, 'node'))) {
    mkdirSync(dir, { recursive: true });
    symlinkSync(process.execPath, join(dir, 'node'));
  }
  return dir;
}

/** Poll until `path` exists (a child's readiness signal); real time, bounded. */
export async function waitForFile(path: string, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

let readySeq = 0;
/** A fresh readiness-file path under the scratch dir. */
export function readyPath(): string {
  return join(scratchDir(), `ready-${process.pid}-${++readySeq}`);
}

export function baseEnv(o: SpawnOptions = {}): Record<string, string> {
  const path = [...(o.fakeGh ? [FAKE_BIN_DIR] : []), nodeBinDir(), '/usr/bin', '/bin'].join(':');
  const env: Record<string, string | undefined> = {
    PATH: path,
    HOME: scratchDir(),
    GHX_ARTIFACT_DIR: join(scratchDir(), 'spawn-artifacts'),
    ...o.env,
  };
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
}

export function spawnGhx(args: string[], o: SpawnOptions = {}): Promise<SpawnResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const [cmd, argv] = TEST_BIN === undefined ? [process.execPath, [BIN, ...args]] : [TEST_BIN, args];
    const child = spawn(cmd, argv, {
      env: baseEnv(o),
      cwd: o.cwd ?? scratchDir(),
      stdio: [o.openStdin || o.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => err.push(c));
    child.stdin?.on('error', () => {});
    if (o.stdin !== undefined) child.stdin?.end(o.stdin);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ghx ${args.join(' ')} did not exit within ${o.timeoutMs ?? 20_000} ms`));
    }, o.timeoutMs ?? 20_000);
    o.onSpawn?.(child);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        ms: Date.now() - started,
      });
    });
  });
}
