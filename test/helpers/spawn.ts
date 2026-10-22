// Spawn bin/ghx.js the way an agent does: through pipes, with an environment built from scratch
// (never process.env: agent sessions set CLAUDE_CODE_SESSION_ATTENDED, 03 §3.6).
import { spawn } from 'node:child_process';
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

export function baseEnv(o: SpawnOptions = {}): Record<string, string> {
  const path = o.fakeGh ? `${FAKE_BIN_DIR}:/usr/bin:/bin` : '/usr/bin:/bin';
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
