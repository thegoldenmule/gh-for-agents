// The one process seam for gh and git (01 §4.1). Tests replace it (test/helpers/fake-proc.ts,
// test/helpers/fake-gh.ts). stdin is never inherited, so nothing can wait on a TTY.
//
// On POSIX the child leads its own process group, and timeouts and aborts signal the whole group, so a
// grandchild (gh's pager, a credential helper, `sh -c 'x &'`) cannot outlive the deadline. The result
// settles on the child's `exit` plus a bounded wait for its pipes to drain: a surviving grandchild
// holding stdout open cannot hold the call open.
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
/** After the child exits, how long to wait for its stdio to close before settling anyway. */
export const DRAIN_MS = 250;

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

      const posix = process.platform !== 'win32';
      const child = spawn(req.cmd, [...req.args], {
        env: cleanEnv(req.env),
        ...(req.cwd ? { cwd: req.cwd } : {}),
        stdio: [req.stdin === undefined ? 'ignore' : 'pipe', fd ?? 'pipe', 'pipe'],
        windowsHide: true,
        detached: posix,
      });

      /** Signal the child's whole process group (POSIX), falling back to the child alone. */
      const signalTree = (sig: NodeJS.Signals): void => {
        if (posix && child.pid !== undefined) {
          try {
            process.kill(-child.pid, sig);
            return;
          } catch {
            // ESRCH: the group is already gone.
          }
        }
        child.kill(sig);
      };

      let killing = false;
      const kill = (): void => {
        if (killing) return;
        killing = true;
        signalTree('SIGTERM');
        clock.sleep(KILL_GRACE_MS, finished.signal).then(
          () => signalTree('SIGKILL'),
          () => {},
        );
      };

      const collect = (bucket: Buffer[], which: 'out' | 'err') => (chunk: Buffer) => {
        if (which === 'out') outBytes += chunk.length;
        else errBytes += chunk.length;
        if ((which === 'out' ? outBytes : errBytes) > maxBuffer) {
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
        // Group members that ignored SIGTERM are orphans now; don't leave them running.
        if (killing) signalTree('SIGKILL');
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (fd !== undefined) closeSync(fd);
        resolve(r);
      };
      child.on('error', (e: NodeJS.ErrnoException) => {
        spawnError = e;
        settle(result(null, null));
      });
      child.on('exit', (code, sig) => {
        clock.sleep(DRAIN_MS, finished.signal).then(
          () => settle(result(code, sig)),
          () => {},
        );
      });
      child.on('close', (code, sig) => settle(result(code, sig)));
    });
}
