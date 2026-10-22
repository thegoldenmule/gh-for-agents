// The gh client (01 §4.3): the only importer of the process runner for `gh`. Read-mode clients refuse
// any mutating call (INTERNAL_READ_MUTATION), which makes "reads never mutate" mechanical. In write
// mode with dry-run, the first mutating call throws DryRunHalt, which the runner turns into the
// dry-run result.
import type { z } from 'zod';
import type { Clock } from '../core/clock.ts';
import { type ErrorCode, type ErrorDetails, GhxError, mapZodIssues, publicCodeFor } from '../core/errors.ts';
import { type Logger, nullLogger } from '../core/log.ts';
import type { Random } from '../core/random.ts';
import type { ProcessRunner, ProcResult } from '../proc/runner.ts';
import { parseJsonWithPosition } from '../util/json.ts';
import { classify, type GhFailureInfo } from './classify.ts';
import { buildGhEnv } from './env.ts';
import { isMutating } from './guard.ts';
import { DEFAULT_RETRY, type RetryPolicy, withRetry } from './retry.ts';
import { type RepoRef, repoArg } from './types.ts';
import { type GhVersion, parseGhVersion } from './version.ts';

export type GhMode = 'read' | 'write';

type NotFoundCode = 'PR_NOT_FOUND' | 'RUN_NOT_FOUND' | 'REPO_NOT_FOUND' | 'REF_NOT_FOUND' | 'ID_NOT_FOUND';

export interface GhCall {
  /** Arguments without the leading 'gh'. */
  args: readonly string[];
  /** Always sent explicitly as -R host/owner/name; gh's cwd inference is never relied on. */
  repo?: RepoRef;
  stdin?: string;
  /** Must equal guard.isMutating(args); a mismatch is INTERNAL (it forces the caller to state intent). */
  mutates?: boolean;
  /** Non-zero exits that are data (e.g. `pr checks` 8 = pending). */
  allowExit?: readonly number[];
  /** Per attempt; default min(30 s, time left before the command deadline). */
  timeoutMs?: number;
  /** Default: transient retry for reads, 'none' for mutating calls. */
  retry?: RetryPolicy | 'none';
  stdoutFile?: string;
  /** Memoize identical read calls within one invocation. */
  cache?: boolean;
  /** Public code for a GH_NOT_FOUND failure at this call site (03 §1 row 9). Default REPO_NOT_FOUND. */
  notFound?: NotFoundCode;
}

export interface GhResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  attempts: number;
  durationMs: number;
}

/** Thrown by a dry-run write client at the first mutating call (01 §3.5). Not a GhxError: the runner catches it. */
export class DryRunHalt extends Error {
  readonly argv: string[];
  readonly stdin: string | undefined;
  constructor(argv: string[], stdin: string | undefined) {
    super('dry run: halted before the first mutating gh call');
    this.name = 'DryRunHalt';
    this.argv = argv;
    this.stdin = stdin;
  }
}

/** A classified gh failure. `failure.code` is internal (01 §4.3) and is never printed; `code` is public. */
export class GhFailure extends GhxError {
  readonly failure: GhFailureInfo;
  readonly result: ProcResult | undefined;
  constructor(
    failure: GhFailureInfo,
    code: ErrorCode,
    message: string,
    details: ErrorDetails,
    result?: ProcResult,
    hint?: string,
  ) {
    super(code, message, { details, hint });
    this.name = 'GhFailure';
    this.failure = failure;
    this.result = result;
  }
}

export interface GhDeps {
  proc: ProcessRunner;
  clock: Clock;
  signal: AbortSignal;
  mode: GhMode;
  dryRun?: boolean;
  /** Base environment (main.ts passes process.env); sanitized by env.ts. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Command deadline (clock.monotonic()), bounding per-attempt timeouts and retries. */
  deadline?: number | undefined;
  maxConcurrency?: number;
  log?: Logger;
  verbose?: boolean;
  /** GHX_GH_PATH override. */
  ghPath?: string;
  random?: Random;
}

export interface Gh {
  readonly mode: GhMode;
  readonly dryRun: boolean;
  exec(call: GhCall): Promise<GhResult>;
  /** exec, then parse and validate gh's JSON; drift is GH_OUTPUT_UNEXPECTED (§9.9). */
  json<S extends z.ZodType>(call: GhCall, schema: S): Promise<z.output<S>>;
  version(): Promise<GhVersion>;
}

const DEFAULT_ATTEMPT_MS = 30_000;

function tail(s: string, max = 2_000): string {
  return s.length > max ? s.slice(-max) : s;
}

/** First non-empty stderr line, trimmed of gh's "gh: " prefix, for messages. */
function headline(stderr: string): string {
  const line = stderr.split('\n').find((l) => l.trim() !== '') ?? '';
  return line.replace(/^gh: /, '').trim();
}

export function describeFailure(argv: readonly string[], info: GhFailureInfo, stderr: string): string {
  const what = `gh ${argv.slice(0, 3).join(' ')}`;
  const why = headline(stderr) || (info.status ? `HTTP ${info.status}` : 'failed');
  return `${what} failed: ${why}`;
}

function semaphore(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];
  return async (fn) => {
    if (active >= max) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

export function createGh(deps: GhDeps): Gh {
  const cmd = deps.ghPath ?? 'gh';
  const env = buildGhEnv(deps.env ?? {}, { verbose: deps.verbose === true });
  const log = deps.log ?? nullLogger;
  const limit = semaphore(deps.maxConcurrency ?? 4);
  const cache = new Map<string, Promise<GhResult>>();
  let versionP: Promise<GhVersion> | undefined;

  const fullArgs = (call: GhCall): string[] => (call.repo ? [...call.args, '-R', repoArg(call.repo)] : [...call.args]);

  const attemptTimeout = (call: GhCall): number => {
    const want = call.timeoutMs ?? DEFAULT_ATTEMPT_MS;
    if (deps.deadline === undefined) return want;
    return Math.max(1, Math.min(want, deps.deadline - deps.clock.monotonic()));
  };

  async function runOnce(call: GhCall, argv: string[]): Promise<{ res: ProcResult; argv: string[] }> {
    const res = await limit(() =>
      deps.proc({
        cmd,
        args: argv,
        env,
        signal: deps.signal,
        timeoutMs: attemptTimeout(call),
        ...(call.stdin !== undefined ? { stdin: call.stdin } : {}),
        ...(call.stdoutFile !== undefined ? { stdoutFile: call.stdoutFile } : {}),
      }),
    );
    log.debug('gh', { argv, exitCode: res.exitCode, ms: Math.round(res.durationMs) });
    if (res.aborted && deps.signal.aborted) throw deps.signal.reason;
    return { res, argv };
  }

  function failureFrom(call: GhCall, argv: string[], res: ProcResult): GhFailure {
    const info = classify({
      exitCode: res.exitCode,
      stderr: res.stderr,
      stdout: res.stdout,
      timedOut: res.timedOut,
      spawnErrorCode: res.spawnError?.code,
      now: deps.clock.now(),
    });
    const code = publicCodeFor(info.code, call.notFound);
    const details: ErrorDetails = { argv: ['gh', ...argv], exitCode: res.exitCode, stderrTail: tail(res.stderr) };
    if (info.status !== undefined) details.status = info.status;
    if (info.retryAfterMs !== undefined) details.retryAfterMs = info.retryAfterMs;
    if (res.outputTooLarge) details.outputTooLarge = true;
    if (info.code === 'GH_NOT_INSTALLED') {
      return new GhFailure(info, code, `${cmd === 'gh' ? 'gh' : cmd} not found on PATH.`, {}, res);
    }
    return new GhFailure(info, code, describeFailure(argv, info, res.stderr), details, res);
  }

  async function exec(call: GhCall): Promise<GhResult> {
    const mutating = isMutating(call.args);
    if (call.mutates !== undefined && call.mutates !== mutating) {
      throw new GhxError(
        'INTERNAL',
        `gh call intent mismatch: mutates=${call.mutates} but the guard says ${mutating}.`,
        {
          details: { argv: ['gh', ...call.args] },
        },
      );
    }
    const argv = fullArgs(call);
    if (mutating && deps.mode === 'read') {
      throw new GhxError(
        'INTERNAL_READ_MUTATION',
        `A read command attempted a mutating gh call: gh ${argv.join(' ')}`,
        {
          details: { argv: ['gh', ...argv] },
        },
      );
    }
    if (mutating && deps.dryRun) throw new DryRunHalt(['gh', ...argv], call.stdin);

    const key =
      call.cache && !mutating ? JSON.stringify([argv, call.stdin ?? null, call.stdoutFile ?? null]) : undefined;
    if (key !== undefined) {
      const hit = cache.get(key);
      if (hit) return hit;
    }
    const policy = call.retry ?? (mutating ? 'none' : DEFAULT_RETRY);
    const started = deps.clock.monotonic();
    let attempts = 0;
    const p = withRetry(
      async () => {
        attempts++;
        const { res } = await runOnce(call, argv);
        const exitCode = res.exitCode ?? -1;
        if (
          res.spawnError ||
          res.timedOut ||
          res.outputTooLarge ||
          (exitCode !== 0 && !call.allowExit?.includes(exitCode))
        ) {
          throw failureFrom(call, argv, res);
        }
        return {
          exitCode,
          stdout: res.stdout,
          stderr: res.stderr,
          attempts,
          durationMs: deps.clock.monotonic() - started,
        };
      },
      {
        policy,
        clock: deps.clock,
        signal: deps.signal,
        deadline: deps.deadline,
        ...(deps.random ? { random: deps.random } : {}),
        decide: (e) =>
          e instanceof GhFailure && e.failure.transient
            ? { retry: true, retryAfterMs: e.failure.retryAfterMs }
            : { retry: false },
        onRetry: (attempt, waitMs) => log.debug('gh.retry', { argv, attempt, waitMs: Math.round(waitMs) }),
      },
    );
    if (key !== undefined) {
      cache.set(key, p);
      p.catch(() => cache.delete(key));
    }
    return p;
  }

  async function json<S extends z.ZodType>(call: GhCall, schema: S): Promise<z.output<S>> {
    const r = await exec(call);
    const parsed = parseJsonWithPosition(r.stdout);
    if (!parsed.ok) {
      throw new GhxError(
        'GH_OUTPUT_UNEXPECTED',
        `gh ${call.args.slice(0, 2).join(' ')} did not return JSON: ${parsed.message}`,
        {
          details: { argv: ['gh', ...fullArgs(call)], line: parsed.line, column: parsed.column },
        },
      );
    }
    const v = schema.safeParse(parsed.value);
    if (!v.success) {
      throw new GhxError(
        'GH_OUTPUT_UNEXPECTED',
        `gh ${call.args.slice(0, 2).join(' ')} returned an unexpected shape.`,
        {
          details: { argv: ['gh', ...fullArgs(call)], issues: mapZodIssues(v.error, { input: parsed.value }) },
        },
      );
    }
    return v.data;
  }

  function version(): Promise<GhVersion> {
    versionP ??= exec({ args: ['--version'], retry: 'none', timeoutMs: 10_000 }).then((r) => {
      const v = parseGhVersion(r.stdout);
      if (!v) {
        throw new GhxError('GH_OUTPUT_UNEXPECTED', 'Could not parse `gh --version`.', {
          details: { stdout: r.stdout.slice(0, 200) },
        });
      }
      return v;
    });
    return versionP;
  }

  return { mode: deps.mode, dryRun: deps.dryRun === true, exec, json, version };
}
