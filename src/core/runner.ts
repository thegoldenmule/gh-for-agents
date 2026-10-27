// The central runner (01 §3.5): deadline, input, context, run, validate output, emit, exit code.
// Every stdout write goes through emitDocument(), which bounds the size and spills to a file.
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import {
  deriveInterface,
  type GlobalOptions,
  type InputSourceDeps,
  loadJsonInput,
  mergeSources,
  type ParsedArgv,
  positionalValues,
  validateInput,
} from '../cli/args.ts';
import { DryRunHalt, type Gh } from '../gh/index.ts';
import type { Git } from '../git/index.ts';
import type { ProcessRunner } from '../proc/runner.ts';
import { type ArtifactStore, artifactRoot, createArtifactStore } from './artifacts.ts';
import type { Clock } from './clock.ts';
import { type AnyCommandSpec, commandName, DEFAULT_TIMEOUT, Warning } from './command.ts';
import { createContext } from './context.ts';
import { parseDuration } from './duration.ts';
import { ErrorEnvelope } from './envelopes.ts';
import { GhxError, toErrorObject } from './errors.ts';
import { ExitCode, exitForSignal } from './exit.ts';
import { fieldProjection } from './fields.ts';
import { createLineLogger, type Logger, nullLogger } from './log.ts';
import { byteLength, DEFAULT_MAX_BYTES, type Sink, serializeJson } from './output.ts';
import type { Random } from './random.ts';
import { createDeadline, type Shutdown, withinGrace } from './signals.ts';

export interface RunDeps extends InputSourceDeps {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  clock: Clock;
  random: Random;
  proc: ProcessRunner;
  stdout: Sink;
  /** --verbose diagnostics. */
  stderrLine?: (line: string) => void;
  shutdown: Shutdown;
  stdoutIsTTY?: boolean;
  /** Test overrides. */
  git?: Git;
  gh?: (mode: 'read' | 'write', dryRun: boolean) => Gh;
}

export interface RunOutcome {
  exitCode: number;
  /** The handler did not settle within the grace window; main must force-exit after the write. */
  forced: boolean;
}

export interface OutputOptions {
  pretty: boolean;
  maxBytes: number;
  command: string;
  artifacts: ArtifactStore;
  /** --fields/--brief (src/core/fields.ts): applied to every document but an error, before the bound. */
  project?: (doc: unknown) => unknown;
}

/** Resolve --pretty / --max-bytes / GHX_MAX_BYTES into output options. Invalid values are VALIDATION. */
export function outputOptions(
  globals: Partial<GlobalOptions>,
  deps: Pick<RunDeps, 'env' | 'stdoutIsTTY' | 'clock'>,
  command: string,
  artifacts?: ArtifactStore,
): OutputOptions {
  const rawMax = globals.maxBytes ?? deps.env.GHX_MAX_BYTES;
  let maxBytes = DEFAULT_MAX_BYTES;
  if (rawMax !== undefined && rawMax !== '') {
    if (!/^\d+$/.test(rawMax) || Number(rawMax) < 256) {
      throw new GhxError('VALIDATION', `--max-bytes must be an integer ≥ 256, got '${rawMax}'.`, {
        details: {
          issues: [{ path: '--max-bytes', code: 'invalid_value', message: `'${rawMax}' is not an integer ≥ 256` }],
        },
      });
    }
    maxBytes = Number(rawMax);
  }
  return {
    pretty: globals.pretty === true || deps.stdoutIsTTY === true,
    maxBytes,
    command,
    artifacts: artifacts ?? createArtifactStore({ root: artifactRoot(deps.env), clock: deps.clock }),
  };
}

/**
 * Write one JSON document to stdout. Over `maxBytes`, the full JSON goes to an artifact and stdout
 * gets {spilled, path, bytes, command} instead (01 §3.5 step 7). A projection runs first, so the
 * projected document is what is bounded and spilled; an error document is never projected.
 */
export async function emitDocument(stdout: Sink, doc: unknown, o: OutputOptions): Promise<void> {
  const value = o.project && !ErrorEnvelope.safeParse(doc).success ? o.project(doc) : doc;
  const text = serializeJson(value, o.pretty);
  if (byteLength(text) <= o.maxBytes) {
    await stdout.writeLine(text);
    return;
  }
  const full = serializeJson(value, false);
  const sha = createHash('sha256').update(full).digest('hex').slice(0, 12);
  const ref = await o.artifacts.write({
    kind: 'output',
    name: `${o.command.replaceAll(' ', '-') || 'ghx'}-${sha}.json`,
    content: `${full}\n`,
  });
  await stdout.writeLine(
    serializeJson({ spilled: true, path: ref.path, bytes: ref.bytes, command: o.command }, o.pretty),
  );
}

/** Emit an error envelope and return its exit code. Unknown throws become INTERNAL with a stack artifact. */
export async function emitError(stdout: Sink, e: unknown, o: OutputOptions, clock: Clock): Promise<number> {
  if (e instanceof GhxError) {
    await emitDocument(stdout, toErrorObject(e), o);
    return e.exitCode;
  }
  const err = e instanceof Error ? e : new Error(String(e));
  let stackPath: string | undefined;
  try {
    stackPath = (
      await o.artifacts.write({ kind: 'internal', name: `stack-${clock.now()}.txt`, content: err.stack ?? err.message })
    ).path;
  } catch {
    stackPath = undefined;
  }
  const wrapped = new GhxError('INTERNAL', `Unexpected: ${err.message}`, stackPath ? { details: { stackPath } } : {});
  await emitDocument(stdout, toErrorObject(wrapped), o);
  return ExitCode.INTERNAL;
}

export function timeoutMsFor(spec: AnyCommandSpec, raw: string | undefined): number | null {
  const t = spec.timeout === undefined ? DEFAULT_TIMEOUT : spec.timeout;
  if (t === null) {
    if (raw !== undefined) {
      throw new GhxError('USAGE_UNKNOWN_FLAG', `'ghx ${commandName(spec)}' has no flag '--timeout'.`, {
        hint: 'This command ends on observed states only; it takes no caller duration.',
        details: { flag: '--timeout', suggestions: [] },
      });
    }
    return null;
  }
  if (raw === undefined) return t.defaultMs;
  const d = parseDuration(raw);
  if (!d.ok) {
    throw new GhxError('VALIDATION', d.message, {
      details: { issues: [{ path: '--timeout', code: 'invalid_duration', message: d.message }] },
    });
  }
  if (d.ms <= 0 || d.ms > t.maxMs) {
    throw new GhxError('VALIDATION', `--timeout must be between 1ms and ${t.maxMs}ms for ghx ${commandName(spec)}.`, {
      details: { issues: [{ path: '--timeout', code: 'too_big', message: `max is ${t.maxMs}ms` }], maxMs: t.maxMs },
    });
  }
  return d.ms;
}

function loggerFor(globals: Partial<GlobalOptions>, deps: RunDeps): Logger {
  return globals.verbose && deps.stderrLine ? createLineLogger(deps.stderrLine, () => deps.clock.now()) : nullLogger;
}

/** Build the raw input object from argv sources (positionals, flags, --input), in that merge order. */
export async function rawInputFrom(
  spec: AnyCommandSpec,
  parsed: ParsedArgv,
  deps: InputSourceDeps,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const derived = deriveInterface(spec);
  const positional = positionalValues(parsed.positionals, derived, commandName(spec));
  const sources = [
    { name: 'as a positional', values: positional },
    { name: 'as a flag', values: parsed.flagValues },
  ];
  if (parsed.globals.input !== undefined) {
    sources.push({
      name: `in ${parsed.globals.input === '-' ? 'stdin' : parsed.globals.input}`,
      values: await loadJsonInput(parsed.globals.input, deps, signal),
    });
  } else if (spec.jsonInput === 'required') {
    throw new GhxError('USAGE_INPUT_MISSING', `ghx ${commandName(spec)} needs JSON input and --input was not given.`, {
      hint: `Write the JSON to a file with your file tool, then run: ghx ${commandName(spec)} --input input.json (or --input - to read stdin).`,
    });
  }
  return mergeSources(sources);
}

/**
 * --fields shapes the one summary document of a 'final' stream; NDJSON lines (ci wait --stream) are
 * written as they are, so the pair is refused. The mode depends on the validated input, so the check
 * wraps the input producer and runs inside runStream, whose error path then reports it.
 */
function projectableStream(
  spec: Extract<AnyCommandSpec, { mode: 'stream' }>,
  rawInput: (signal: AbortSignal) => Promise<Record<string, unknown>>,
): (signal: AbortSignal) => Promise<Record<string, unknown>> {
  return async (signal) => {
    const raw = await rawInput(signal);
    const m = spec.outputMode;
    const mode = typeof m === 'function' ? m(validateInput(spec.input, raw) as never) : (m ?? 'ndjson');
    if (mode === 'ndjson') {
      const flag = 'stream' in raw ? ' --stream' : '';
      throw new GhxError('VALIDATION', `--fields and --brief do not apply to ghx ${commandName(spec)}${flag} NDJSON.`, {
        hint: `Drop --fields/--brief, or drop${flag || ' the NDJSON mode'}: the single summary document can be projected.`,
        details: {
          issues: [{ path: '--fields', code: 'invalid_combination', message: 'NDJSON lines are not projected' }],
        },
      });
    }
    return raw;
  };
}

/** Run a spec from parsed argv. */
export async function runCommand(spec: AnyCommandSpec, parsed: ParsedArgv, deps: RunDeps): Promise<RunOutcome> {
  return runCommandWith(spec, parsed.globals, deps, (signal) => rawInputFrom(spec, parsed, deps, signal));
}

/**
 * Run a spec with a raw input producer. Passthrough (src/cli/unknown.ts) uses this to run a synthetic
 * spec without ghx flag parsing.
 */
export async function runCommandWith(
  spec: AnyCommandSpec,
  globals: Partial<GlobalOptions>,
  deps: RunDeps,
  rawInput: (signal: AbortSignal) => Promise<Record<string, unknown>>,
): Promise<RunOutcome> {
  const name = commandName(spec);
  const artifacts = createArtifactStore({ root: artifactRoot(deps.env), clock: deps.clock });
  let out: OutputOptions;
  try {
    out = outputOptions(globals, deps, name, artifacts);
    // Paths are checked here, before any input is read or gh is called: a typo never follows a write.
    const project = fieldProjection(spec, globals);
    if (project) out = { ...out, project };
  } catch (e) {
    const fallback = { pretty: false, maxBytes: DEFAULT_MAX_BYTES, command: name, artifacts };
    return { exitCode: await emitError(deps.stdout, e, fallback, deps.clock), forced: false };
  }
  if (spec.mode === 'stream') {
    if (spec.maxBytes === 'fixed') out = { ...out, maxBytes: DEFAULT_MAX_BYTES };
    const { runStream } = await import('./stream.ts');
    return runStream(spec, globals, deps, out.project ? projectableStream(spec, rawInput) : rawInput, out);
  }
  let deadline: ReturnType<typeof createDeadline> | undefined;
  let warnings: Warning[] = [];
  let previews: unknown[] = [];
  try {
    if (globals.dryRun && spec.kind === 'read') {
      throw new GhxError('USAGE_UNKNOWN_FLAG', `'ghx ${name}' has no flag '--dry-run'.`, {
        hint: 'Read commands never mutate; --dry-run applies to write commands only.',
        details: { flag: '--dry-run', suggestions: [] },
      });
    }
    deadline = createDeadline(deps.clock, timeoutMsFor(spec, globals.timeout), deps.shutdown.signal, `ghx ${name}`);
    const input = validateInput(spec.input, await rawInput(deadline.signal));
    const log = loggerFor(globals, deps);
    const dryRun = globals.dryRun === true;
    const built = createContext({
      spec,
      cwd: deps.cwd,
      env: deps.env,
      clock: deps.clock,
      random: deps.random,
      proc: deps.proc,
      ...(deps.git ? { git: deps.git } : {}),
      ...(deps.gh ? { gh: deps.gh(spec.kind, dryRun) } : {}),
      artifacts,
      signal: deadline.signal,
      deadline: deadline.at,
      dryRun,
      verbose: globals.verbose === true,
      log,
      flagRepo: globals.repo,
      project: out.project,
    });
    warnings = built.warnings;
    previews = built.previews;

    const work = spec.run(input, built.ctx);
    const shutdownHit = new Promise<'shutdown'>((r) => {
      if (deps.shutdown.signal.aborted) r('shutdown');
      deps.shutdown.signal.addEventListener('abort', () => r('shutdown'), { once: true });
    });
    const first = await Promise.race([
      work.then(
        (v) => ({ ok: true as const, v }),
        (e: unknown) => ({ ok: false as const, e }),
      ),
      shutdownHit,
    ]);

    let result: { ok: true; v: unknown } | { ok: false; e: unknown };
    if (first === 'shutdown') {
      const g = await withinGrace(work, { clock: deps.clock, shutdown: deps.shutdown });
      const reason = deps.shutdown.signal.reason as GhxError;
      if (!g.settled) {
        await emitDocument(deps.stdout, toErrorObject(reason), out);
        return { exitCode: exitForSignal(deps.shutdown.cause), forced: true };
      }
      // Single mode has no graceful summary: a shutdown always ends in INTERRUPTED (01 §3.6).
      result = { ok: false, e: reason };
    } else {
      result = first;
    }
    if (!result.ok) throw result.e;

    const schema = spec.output.extend({ warnings: Warning.array().optional() }) as z.ZodObject;
    const value = { ...(result.v as Record<string, unknown>), ...(warnings.length > 0 ? { warnings } : {}) };
    const checked = schema.safeParse(value);
    if (!checked.success) {
      throw new GhxError('INTERNAL_OUTPUT_CONTRACT', `ghx ${name} produced output that violates its schema.`, {
        details: {
          issues: checked.error.issues
            .slice(0, 20)
            .map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
        },
      });
    }
    await emitDocument(deps.stdout, checked.data, out);
    return { exitCode: spec.exitCode?.(checked.data as never) ?? ExitCode.OK, forced: false };
  } catch (e) {
    if (e instanceof DryRunHalt) {
      // An empty argv halts a write with nothing to send (pr merge --dry-run on a merged PR): wouldRun is [].
      const wouldRun =
        e.argv.length === 0 ? [] : [{ argv: e.argv, ...(e.stdin !== undefined ? { stdin: e.stdin } : {}) }];
      const preview = previews.length === 0 ? null : previews.length === 1 ? previews[0] : previews;
      // The dry-run envelope is not the command's output: --fields does not apply to it.
      const { project: _project, ...plain } = out;
      await emitDocument(
        deps.stdout,
        { dryRun: true, wouldRun, preview, ...(warnings.length > 0 ? { warnings } : {}) },
        plain,
      );
      return { exitCode: ExitCode.OK, forced: false };
    }
    return { exitCode: await emitError(deps.stdout, e, out, deps.clock), forced: false };
  } finally {
    deadline?.cancel();
  }
}
