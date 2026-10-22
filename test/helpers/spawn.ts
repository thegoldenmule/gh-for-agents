// Spawn bin/ghx.js the way an agent does: through pipes, with an environment built from scratch
// (never process.env: agent sessions set CLAUDE_CODE_SESSION_ATTENDED, 03 §3.6).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from './harness.ts';

export const BIN = join(import.meta.dirname, '..', '..', 'bin', 'ghx.js');
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
    const child = spawn(process.execPath, [BIN, ...args], {
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
