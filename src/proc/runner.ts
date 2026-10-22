// The one process seam for gh and git (01 §4.1). Tests replace it (test/helpers/fake-proc.ts,
// test/helpers/fake-gh.ts). stdin is never inherited, so nothing can wait on a TTY.
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import type { Clock } from '../core/clock.ts';

export interface ProcRequest {
  cmd: string;
  args: readonly string[];
  /** The child's complete environment. Nothing is inherited implicitly. */
  env: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  stdin?: string;
  signal: AbortSignal;
  timeoutMs?: number;
  /** Stream stdout to this file instead of buffering it (logs). */
  stdoutFile?: string;
  /** Default 32 MiB per stream; overflow kills the child and sets `outputTooLarge`. */
  maxBuffer?: number;
}

export interface ProcResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  /** ENOENT here means the binary is not installed. */
  spawnError?: NodeJS.ErrnoException;
  outputTooLarge?: boolean;
}

export type ProcessRunner = (req: ProcRequest) => Promise<ProcResult>;

export const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;
export const KILL_GRACE_MS = 2_000;

function cleanEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

export function createSpawnRunner(deps: { clock: Clock }): ProcessRunner {
  const { clock } = deps;
  return (req) =>
    new Promise<ProcResult>((resolve) => {
      const started = clock.monotonic();
      const maxBuffer = req.maxBuffer ?? DEFAULT_MAX_BUFFER;
      const finished = new AbortController();
      let timedOut = false;
      let aborted = false;
      let outputTooLarge = false;
      let spawnError: NodeJS.ErrnoException | undefined;
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let fd: number | undefined;

      const result = (exitCode: number | null, signal: NodeJS.Signals | null): ProcResult => {
        const r: ProcResult = {
          exitCode,
          signal,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          timedOut,
          aborted,
          durationMs: clock.monotonic() - started,
        };
        if (spawnError) r.spawnError = spawnError;
        if (outputTooLarge) r.outputTooLarge = true;
        return r;
      };

      if (req.signal.aborted) {
        aborted = true;
        resolve(result(null, null));
        return;
      }

      try {
        if (req.stdoutFile) fd = openSync(req.stdoutFile, 'w');
      } catch (e) {
        spawnError = e as NodeJS.ErrnoException;
        resolve(result(null, null));
        return;
      }

      const child = spawn(req.cmd, [...req.args], {
        env: cleanEnv(req.env),
        ...(req.cwd ? { cwd: req.cwd } : {}),
        stdio: [req.stdin === undefined ? 'ignore' : 'pipe', fd ?? 'pipe', 'pipe'],
        windowsHide: true,
      });

      let killing = false;
      const kill = (): void => {
        if (killing) return;
        killing = true;
        child.kill('SIGTERM');
        clock.sleep(KILL_GRACE_MS, finished.signal).then(
          () => child.kill('SIGKILL'),
          () => {},
        );
      };

      const collect = (bucket: Buffer[], which: 'out' | 'err') => (chunk: Buffer) => {
        const n = which === 'out' ? (outBytes += chunk.length) : (errBytes += chunk.length);
        if (n > maxBuffer) {
          outputTooLarge = true;
          kill();
          return;
        }
        bucket.push(chunk);
      };
      child.stdout?.on('data', collect(out, 'out'));
      child.stderr?.on('data', collect(err, 'err'));

      const onAbort = (): void => {
        aborted = true;
        kill();
      };
      req.signal.addEventListener('abort', onAbort, { once: true });

      if (req.timeoutMs !== undefined) {
        clock.sleep(req.timeoutMs, finished.signal).then(
          () => {
            timedOut = true;
            kill();
          },
          () => {},
        );
      }

      if (req.stdin !== undefined && child.stdin) {
        child.stdin.on('error', () => {});
        child.stdin.end(req.stdin);
      }

      let settled = false;
      const settle = (r: ProcResult): void => {
        if (settled) return;
        settled = true;
        finished.abort();
        req.signal.removeEventListener('abort', onAbort);
        if (fd !== undefined) closeSync(fd);
        resolve(r);
      };
      child.on('error', (e: NodeJS.ErrnoException) => {
        spawnError = e;
        settle(result(null, null));
      });
      child.on('close', (code, sig) => settle(result(code, sig)));
    });
}
