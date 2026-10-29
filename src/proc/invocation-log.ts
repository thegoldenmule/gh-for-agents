// GHX_LOG (07 "ghx instrumentation"): an opt-in, local, append-only NDJSON record of each ghx
// invocation, one line written when it finishes, with the gh (and git) processes behind it. Modelled on
// recording.ts: a ProcessRunner decorator collects the calls; wrappers around stdout and stderrLine
// count the bytes ghx printed, without changing a byte of it. Enabled by main.ts when GHX_LOG is set.
// A failed write is swallowed: the log never changes ghx's output or exit code.
//
// Joining to transcripts: Claude Code exports CLAUDE_CODE_SESSION_ID to the Bash tool (the root
// session's id, in subagents too), so `session_id` is recorded when present. No env var carries the
// tool_use_id; that comes from GHX_HOOK_LOG, and src/hook/join.ts has the join rule.
import { appendFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { type Clock, isoNow } from '../core/clock.ts';
import { byteLength, type Sink } from '../core/output.ts';
import type { ProcessRunner } from './runner.ts';

/** One child process behind a ghx invocation, in completion order. */
export interface InvocationCall {
  /** Basename of the binary: 'gh' or 'git'. GitHub API calls are the 'gh' entries. */
  cmd: string;
  argv: string[];
  exitCode: number | null;
  /** From ProcResult.durationMs, rounded. */
  durationMs: number;
  /** For a call streamed to a file (job logs), the file's size. */
  stdoutBytes: number;
  stderrBytes: number;
  stdoutFile?: true;
  timedOut?: true;
  aborted?: true;
  /** The spawn error code; ENOENT means the binary is missing. */
  spawnError?: string;
}

export interface InvocationLogLine {
  v: 1;
  /** When the invocation started (ISO-8601), so the hook line for its tool_use is never later. */
  ts: string;
  /** CLAUDE_CODE_SESSION_ID from ghx's environment, or null outside Claude Code. */
  session_id: string | null;
  cwd: string;
  /** ghx's own argv, without `node` and the script: ['pr', 'status', '12']. */
  argv: string[];
  exitCode: number;
  durationMs: number;
  /** Bytes ghx wrote to stdout and stderr (newlines included). */
  stdoutBytes: number;
  stderrBytes: number;
  version: string;
  calls: InvocationCall[];
}

export interface InvocationLogOptions {
  path: string;
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  clock: Clock;
  version: string;
}

interface Wrappable {
  proc: ProcessRunner;
  stdout: Sink;
  stderrLine?: (line: string) => void;
}

/** `ghx hook claude-pretooluse` runs once per Bash call on Claude Code's behalf, never as an agent's tool
 * call, so it is not logged (it has GHX_HOOK_LOG for itself). */
function isHookProtocol(argv: readonly string[]): boolean {
  return (
    argv[0] === 'hook' &&
    argv[1] === 'claude-pretooluse' &&
    !argv.some((t) => t === '--help' || t === '-h' || t === '--schema')
  );
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Wrap `deps` (proc, stdout, stderrLine) to observe one invocation. Call `finish(exitCode)` once runCli
 * returns; it appends the line and never throws.
 */
export function withInvocationLog<D extends Wrappable>(
  deps: D,
  o: InvocationLogOptions,
): { deps: D; finish(exitCode: number): void } {
  if (isHookProtocol(o.argv)) return { deps, finish: () => {} };
  const ts = isoNow(o.clock);
  const started = o.clock.monotonic();
  const calls: InvocationCall[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;

  const inner = deps.proc;
  const proc: ProcessRunner = async (req) => {
    const res = await inner(req);
    const call: InvocationCall = {
      cmd: basename(req.cmd),
      argv: [...req.args],
      exitCode: res.exitCode,
      durationMs: Math.round(res.durationMs),
      stdoutBytes: req.stdoutFile ? fileSize(req.stdoutFile) : byteLength(res.stdout),
      stderrBytes: byteLength(res.stderr),
    };
    if (req.stdoutFile) call.stdoutFile = true;
    if (res.timedOut) call.timedOut = true;
    if (res.aborted) call.aborted = true;
    if (res.spawnError) call.spawnError = res.spawnError.code ?? res.spawnError.message;
    calls.push(call);
    return res;
  };
  const sink = deps.stdout;
  const stdout: Sink = {
    get closed() {
      return sink.closed;
    },
    writeLine(s) {
      if (!sink.closed) stdoutBytes += byteLength(s) + 1;
      return sink.writeLine(s);
    },
  };
  const wrapped: D = { ...deps, proc, stdout };
  const err = deps.stderrLine;
  if (err) {
    wrapped.stderrLine = (line) => {
      stderrBytes += byteLength(line) + 1;
      err(line);
    };
  }

  let done = false;
  return {
    deps: wrapped,
    finish(exitCode) {
      if (done) return;
      done = true;
      try {
        const line: InvocationLogLine = {
          v: 1,
          ts,
          session_id: o.env.CLAUDE_CODE_SESSION_ID || null,
          cwd: o.cwd,
          argv: [...o.argv],
          exitCode,
          durationMs: Math.round(o.clock.monotonic() - started),
          stdoutBytes,
          stderrBytes,
          version: o.version,
          calls,
        };
        appendFileSync(o.path, `${JSON.stringify(line)}\n`);
      } catch {
        // Instrumentation is best effort: ghx's output and exit code never depend on it.
      }
    },
  };
}
