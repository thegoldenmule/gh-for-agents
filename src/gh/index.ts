// The gh client (01 §4.3): the only importer of the process runner for `gh`. Read-mode clients refuse
// any mutating call (INTERNAL_READ_MUTATION), which makes "reads never mutate" mechanical. In write
// mode with dry-run, the first mutating call throws DryRunHalt, which the runner turns into the
// dry-run result.

import { rmSync } from 'node:fs';
import type { z } from 'zod';
import type { Clock } from '../core/clock.ts';
import { type ErrorCode, type ErrorDetails, GhxError, mapZodIssues, publicCodeFor } from '../core/errors.ts';
import { type Logger, nullLogger } from '../core/log.ts';
import type { Random } from '../core/random.ts';
import type { ProcessRunner, ProcResult } from '../proc/runner.ts';
import { parseJsonWithPosition } from '../util/json.ts';
import {
  type ApiRequest,
  type ApiResponse,
  buildApiArgs,
  mergePages,
  nextLink,
  parseIncludeOutput,
  splitHeadersFromFile,
  stripBom,
} from './api.ts';
import { classify, type GhFailureInfo } from './classify.ts';
import { buildGhEnv } from './env.ts';
import { buildGraphqlArgs, type GraphqlError, type GraphqlVars, parseGraphqlBody } from './graphql.ts';
import { isMutating } from './guard.ts';
import { parseRateLimitResponse, type RateBudget, type RateResource, RateTracker } from './ratelimit.ts';
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
  /** Default: transient retry for reads, 'none' for mutating calls. A mutating call may pass a policy only with `idempotent: true` (else INTERNAL). */
  retry?: RetryPolicy | 'none';
  stdoutFile?: string;
  /** Memoize identical read calls within one invocation. */
  cache?: boolean;
  /** Public code for a GH_NOT_FOUND failure at this call site (03 §1 row 9). Default REPO_NOT_FOUND. */
  notFound?: NotFoundCode;
  /** Treat a non-zero exit as success when this returns true (api() uses it for 304 and partial GraphQL). */
  accept?: (r: { exitCode: number; stdout: string; stderr: string }) => boolean;
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

export interface GraphqlOptions {
  repo?: RepoRef;
  /** Must equal the query's operation type; a mismatch is INTERNAL. */
  mutates?: boolean;
  notFound?: NotFoundCode;
}

export interface Gh {
  readonly mode: GhMode;
  readonly dryRun: boolean;
  exec(call: GhCall): Promise<GhResult>;
  /** exec, then parse and validate gh's JSON; drift is GH_OUTPUT_UNEXPECTED (§9.9). */
  json<S extends z.ZodType>(call: GhCall, schema: S): Promise<z.output<S>>;
  /** REST with headers, bounded pagination and conditional requests (304 → notModified). */
  api<S extends z.ZodType>(req: ApiRequest, schema: S, o?: ApiCallOptions): Promise<ApiResponse<z.output<S>>>;
  /** REST returning the raw text body (BOM stripped); with toFile the body is streamed to the file. */
  apiText(req: ApiRequest, o?: ApiCallOptions): Promise<ApiResponse<string>>;
  /** GraphQL; any error in the response throws (NOT_FOUND maps to `notFound`). */
  graphql<S extends z.ZodType>(
    query: string,
    vars: GraphqlVars,
    schema: S,
    opts?: GraphqlOptions,
  ): Promise<z.output<S>>;
  /** GraphQL keeping partial data alongside its errors (03 §3.4). `data` is validated with nulls allowed by the schema. */
  graphqlPartial<S extends z.ZodType>(
    query: string,
    vars: GraphqlVars,
    schema: S,
    opts?: GraphqlOptions,
  ): Promise<{ data: z.output<S>; errors: GraphqlError[] }>;
  /** The last observed budget for a resource (default core). */
  rateBudget(resource?: RateResource): RateBudget | undefined;
  /** GET rate_limit (does not count against the limit). */
  refreshRateBudget(): Promise<Partial<Record<RateResource, RateBudget>>>;
  version(): Promise<GhVersion>;
  /**
   * A view of this client whose gh children are also killed when `signal` aborts (its calls then reject
   * with the abort reason). It shares the concurrency limit and rate budgets but not the call memo.
   * Optional so hand-written doubles stay valid: use `gh.withSignal?.(s) ?? gh`.
   */
  withSignal?(signal: AbortSignal): Gh;
  /**
   * A view of this client bound to `signal` *instead of* the runner's signal, with no command deadline,
   * for cleanup that must still run after an abort (ci retrigger's reopen). The caller bounds it.
   * Optional so hand-written doubles stay valid: use `gh.detached?.(s) ?? gh`.
   */
  detached?(signal: AbortSignal): Gh;
}

export interface ApiCallOptions {
  notFound?: NotFoundCode;
  timeoutMs?: number;
  retry?: RetryPolicy | 'none';
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

/** State every view of one client shares: the concurrency limit, the rate budgets and the gh version. */
interface GhShared {
  limit: <T>(fn: () => Promise<T>) => Promise<T>;
  rates: RateTracker;
  version: { p?: Promise<GhVersion> };
}

export function createGh(deps: GhDeps): Gh {
  return buildGh(deps, { limit: semaphore(deps.maxConcurrency ?? 4), rates: new RateTracker(), version: {} });
}

function buildGh(deps: GhDeps, shared: GhShared): Gh {
  const cmd = deps.ghPath ?? 'gh';
  const env = buildGhEnv(deps.env ?? {}, { verbose: deps.verbose === true });
  const log = deps.log ?? nullLogger;
  const { limit, rates } = shared;
  // Per view: a scoped view's aborted call must never be the memoized promise a parent caller awaits.
  const cache = new Map<string, Promise<GhResult>>();

  const fullArgs = (call: GhCall): string[] => (call.repo ? [...call.args, '-R', repoArg(call.repo)] : [...call.args]);

  const attemptTimeout = (call: GhCall): number => {
    const want = call.timeoutMs ?? DEFAULT_ATTEMPT_MS;
    if (deps.deadline === undefined) return want;
    return Math.max(1, Math.min(want, deps.deadline - deps.clock.monotonic()));
  };

  async function runOnce(call: GhCall, argv: string[]): Promise<{ res: ProcResult; argv: string[] }> {
    const res = await limit(() => {
      // Never spawn for an aborted signal (a scoped view's budget may expire while a call is queued).
      deps.signal.throwIfAborted();
      return deps.proc({
        cmd,
        args: argv,
        env,
        signal: deps.signal,
        timeoutMs: attemptTimeout(call),
        ...(call.stdin !== undefined ? { stdin: call.stdin } : {}),
        ...(call.stdoutFile !== undefined ? { stdoutFile: call.stdoutFile } : {}),
      });
    });
    log.debug('gh', { argv, exitCode: res.exitCode, ms: Math.round(res.durationMs) });
    if (res.aborted && deps.signal.aborted) throw deps.signal.reason;
    return { res, argv };
  }

  function failureFrom(call: GhCall, argv: string[], res: ProcResult): GhFailure {
    const included = argv.includes('--include') ? parseIncludeOutput(res.stdout) : undefined;
    if (included) rates.observe(included.headers, deps.clock.now());
    const info = classify({
      exitCode: res.exitCode,
      stderr: res.stderr,
      stdout: included ? included.body : res.stdout,
      timedOut: res.timedOut,
      spawnErrorCode: res.spawnError?.code,
      now: deps.clock.now(),
      ...(included?.status != null ? { status: included.status, headers: included.headers } : {}),
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
    if (mutating && call.retry !== undefined && call.retry !== 'none' && call.retry.idempotent !== true) {
      throw new GhxError(
        'INTERNAL',
        'A mutating gh call was given a retry policy without idempotent: true; repeating a write is only safe when it is idempotent.',
        { details: { argv: ['gh', ...argv] } },
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
        const accepted =
          exitCode === 0 ||
          call.allowExit?.includes(exitCode) === true ||
          (call.accept?.({ exitCode, stdout: res.stdout, stderr: res.stderr }) ?? false);
        if (res.spawnError || res.timedOut || res.outputTooLarge || !accepted) {
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
        decide: (e, attempt) => {
          if (!(e instanceof GhFailure) || !e.failure.transient) return { retry: false };
          // 01 §4.3: a per-attempt timeout is retried once; another full timeout rarely helps.
          if (e.failure.code === 'GH_TIMEOUT' && attempt >= 2) return { retry: false };
          return { retry: true, retryAfterMs: e.failure.retryAfterMs };
        },
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

  const ok2xx = (status: number | null): boolean => status !== null && status >= 200 && status < 300;

  async function apiPage(
    req: ApiRequest,
    o: ApiCallOptions,
    endpoint?: string,
  ): Promise<{ status: number; headers: Record<string, string>; body: string; notModified: boolean }> {
    const { args, stdin } = buildApiArgs(req, endpoint);
    const conditional = Object.keys(req.headers ?? {}).some((k) => k.toLowerCase() === 'if-none-match');
    const r = await exec({
      args,
      ...(stdin !== undefined ? { stdin } : {}),
      ...(o.notFound ? { notFound: o.notFound } : {}),
      ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
      ...(o.retry !== undefined ? { retry: o.retry } : {}),
      accept: (x) => {
        const p = parseIncludeOutput(x.stdout);
        return ok2xx(p.status) || (conditional && p.status === 304);
      },
    });
    const p = parseIncludeOutput(r.stdout);
    rates.observe(p.headers, deps.clock.now());
    // 03 §3.1: exit 1 + status 304 + If-None-Match sent = not modified (free; never retried).
    return { status: p.status ?? 0, headers: p.headers, body: p.body, notModified: p.status === 304 };
  }

  async function api<S extends z.ZodType>(
    req: ApiRequest,
    schema: S,
    o: ApiCallOptions = {},
  ): Promise<ApiResponse<z.output<S>>> {
    if (req.toFile) throw new GhxError('INTERNAL', 'api() with toFile: use apiText().');
    const pages: unknown[] = [];
    let first = await apiPage(req, o);
    const etag = first.headers.etag;
    if (first.notModified) {
      return {
        status: 304,
        headers: first.headers,
        data: undefined,
        pages: 0,
        truncated: false,
        notModified: true,
        ...(etag ? { etag } : {}),
      };
    }
    const parseBody = (body: string, endpoint: string): unknown => {
      const parsed = parseJsonWithPosition(stripBom(body));
      if (!parsed.ok) {
        throw new GhxError('GH_OUTPUT_UNEXPECTED', `GET ${endpoint} did not return JSON: ${parsed.message}`, {
          details: { path: endpoint, line: parsed.line, column: parsed.column },
        });
      }
      return parsed.value;
    };
    pages.push(parseBody(first.body, req.path));
    let truncated = false;
    if (req.paginate) {
      let next = nextLink(first.headers.link);
      while (next) {
        if (pages.length >= req.paginate.maxPages) {
          truncated = true;
          break;
        }
        first = await apiPage(req, o, next);
        pages.push(parseBody(first.body, next));
        next = nextLink(first.headers.link);
      }
    }
    const merged = mergePages(pages, req.paginate?.itemsKey);
    const v = schema.safeParse(merged);
    if (!v.success) {
      throw new GhxError('GH_OUTPUT_UNEXPECTED', `${req.method ?? 'GET'} ${req.path} returned an unexpected shape.`, {
        details: { path: req.path, issues: mapZodIssues(v.error, { input: merged }).slice(0, 20) },
      });
    }
    return {
      status: first.status,
      headers: first.headers,
      data: v.data,
      pages: pages.length,
      truncated,
      notModified: false,
      ...(etag ? { etag } : {}),
    };
  }

  async function apiText(req: ApiRequest, o: ApiCallOptions = {}): Promise<ApiResponse<string>> {
    if (!req.toFile) {
      const r = await apiPage(req, o);
      const etag = r.headers.etag;
      if (r.notModified) {
        return {
          status: 304,
          headers: r.headers,
          data: undefined,
          pages: 0,
          truncated: false,
          notModified: true,
          ...(etag ? { etag } : {}),
        };
      }
      return {
        status: r.status,
        headers: r.headers,
        data: stripBom(r.body),
        pages: 1,
        truncated: false,
        notModified: false,
        ...(etag ? { etag } : {}),
      };
    }
    // Streamed to a file: gh writes headers into the file too, so classify from the file head.
    const { args } = buildApiArgs(req);
    const r = await exec({
      args,
      stdoutFile: req.toFile,
      allowExit: [1],
      ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
      ...(o.retry !== undefined ? { retry: o.retry } : {}),
    });
    const head = await splitHeadersFromFile(req.toFile);
    rates.observe(head.headers, deps.clock.now());
    if (!ok2xx(head.status)) {
      const info = classify({
        exitCode: r.exitCode,
        stderr: r.stderr,
        stdout: '',
        status: head.status ?? undefined,
        headers: head.headers,
        now: deps.clock.now(),
      });
      if (head.status === 404 && /blob/i.test(head.statusLine ?? '')) info.code = 'GH_LOGS_NOT_READY';
      rmSync(req.toFile, { force: true });
      throw new GhFailure(info, publicCodeFor(info.code, o.notFound), describeFailure(args, info, r.stderr), {
        argv: ['gh', ...args],
        exitCode: r.exitCode,
        status: head.status,
        stderrTail: tail(r.stderr),
      });
    }
    return {
      status: head.status ?? 200,
      headers: head.headers,
      data: req.toFile,
      pages: 1,
      truncated: false,
      notModified: false,
    };
  }

  async function graphqlRaw(
    query: string,
    vars: GraphqlVars,
    opts: GraphqlOptions,
  ): Promise<{ data: unknown; errors: GraphqlError[] }> {
    const { args, stdin, mutation } = buildGraphqlArgs(query, vars, { repo: opts.repo });
    if (opts.mutates !== undefined && opts.mutates !== mutation) {
      throw new GhxError(
        'INTERNAL',
        `graphql intent mismatch: mutates=${opts.mutates} but the query is ${mutation ? 'a mutation' : 'a query'}.`,
      );
    }
    const r = await exec({
      args,
      ...(stdin !== undefined ? { stdin } : {}),
      ...(opts.notFound ? { notFound: opts.notFound } : {}),
      // 03 §3.4: a 200 with partial errors exits 1 but still carries data; transient errors are retried.
      accept: (x) => {
        const p = parseIncludeOutput(x.stdout);
        if (p.status !== 200) return false;
        const payload = parseGraphqlBody(p.body);
        return payload !== undefined && !/Something went wrong while executing your query/.test(x.stderr);
      },
    });
    const p = parseIncludeOutput(r.stdout);
    rates.observe(p.headers, deps.clock.now());
    const payload = parseGraphqlBody(p.body) ?? {};
    return { data: payload.data ?? null, errors: payload.errors ?? [] };
  }

  function graphqlFailure(errors: GraphqlError[], opts: GraphqlOptions): GhFailure {
    const types = errors.map((e) => e.type ?? '');
    const info: GhFailureInfo = types.includes('NOT_FOUND')
      ? { code: 'GH_NOT_FOUND', transient: false }
      : types.includes('RATE_LIMITED')
        ? { code: 'GH_RATE_LIMITED', transient: true }
        : types.includes('FORBIDDEN')
          ? { code: 'GH_FORBIDDEN', transient: false }
          : { code: 'GH_FAILED', transient: false };
    const message = `GraphQL: ${errors
      .map((e) => e.message)
      .join('; ')
      .slice(0, 300)}`;
    return new GhFailure(info, publicCodeFor(info.code, opts.notFound), message, {
      errors: errors.slice(0, 10).map((e) => ({ type: e.type ?? null, message: e.message, path: e.path ?? null })),
    });
  }

  async function graphql<S extends z.ZodType>(
    query: string,
    vars: GraphqlVars,
    schema: S,
    opts: GraphqlOptions = {},
  ): Promise<z.output<S>> {
    const { data, errors } = await graphqlRaw(query, vars, opts);
    if (errors.length > 0) throw graphqlFailure(errors, opts);
    return validateGraphql(data, schema);
  }

  async function graphqlPartial<S extends z.ZodType>(
    query: string,
    vars: GraphqlVars,
    schema: S,
    opts: GraphqlOptions = {},
  ): Promise<{ data: z.output<S>; errors: GraphqlError[] }> {
    const { data, errors } = await graphqlRaw(query, vars, opts);
    if (data === null && errors.length > 0) throw graphqlFailure(errors, opts);
    return { data: validateGraphql(data, schema), errors };
  }

  function validateGraphql<S extends z.ZodType>(data: unknown, schema: S): z.output<S> {
    const v = schema.safeParse(data);
    if (!v.success) {
      throw new GhxError('GH_OUTPUT_UNEXPECTED', 'GraphQL returned an unexpected shape.', {
        details: { issues: mapZodIssues(v.error, { input: data }).slice(0, 20) },
      });
    }
    return v.data;
  }

  async function refreshRateBudget(): Promise<Partial<Record<RateResource, RateBudget>>> {
    const r = await apiPage({ path: 'rate_limit' }, {});
    const parsed = parseJsonWithPosition(r.body);
    const budgets = parseRateLimitResponse(parsed.ok ? parsed.value : null, deps.clock.now());
    for (const b of Object.values(budgets)) if (b) rates.set(b);
    return budgets;
  }

  function version(): Promise<GhVersion> {
    shared.version.p ??= exec({ args: ['--version'], retry: 'none', timeoutMs: 10_000 }).then((r) => {
      const v = parseGhVersion(r.stdout);
      if (!v) {
        throw new GhxError('GH_OUTPUT_UNEXPECTED', 'Could not parse `gh --version`.', {
          details: { stdout: r.stdout.slice(0, 200) },
        });
      }
      return v;
    });
    return shared.version.p;
  }

  return {
    mode: deps.mode,
    dryRun: deps.dryRun === true,
    exec,
    json,
    api,
    apiText,
    graphql,
    graphqlPartial,
    rateBudget: (resource = 'core') => rates.get(resource),
    refreshRateBudget,
    version,
    withSignal: (signal) => buildGh({ ...deps, signal: AbortSignal.any([deps.signal, signal]) }, shared),
    detached: (signal) => buildGh({ ...deps, signal, deadline: undefined }, shared),
  };
}
