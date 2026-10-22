// The stream runner (01 §3.6 amended by 03 §1 row 3 and §2 M1.10).
//
// A stream handler is an async generator: yield events, return the summary. Every line is
// {type, seq, at, ...payload} with seq gapless from 0, and there is always exactly one terminal
// line (summary or error), last. Lines always go to the events file. Output modes:
//   ndjson: every line also goes to stdout (01's behaviour, `--stream` for humans);
//   final:  stdout gets only the terminal object as ONE JSON document (the ci wait agent protocol).
// A spec may declare `timeout: null` (no deadline); signals and the grace window still apply.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { z } from 'zod';
import type { GlobalOptions } from '../cli/args.ts';
import { validateInput } from '../cli/args.ts';
import { DryRunHalt } from '../gh/index.ts';
import { isoNow } from './clock.ts';
import { commandName, type StreamCommandSpec, type StreamContext, type StreamOutputMode, Warning } from './command.ts';
import { createContext } from './context.ts';
import { GhxError, toErrorObject } from './errors.ts';
import { ExitCode, exitForSignal } from './exit.ts';
import { createLineLogger, nullLogger } from './log.ts';
import { byteLength, DEFAULT_MAX_EVENT_BYTES, serializeJson } from './output.ts';
import { secureHex } from './random.ts';
import { emitDocument, emitError, type OutputOptions, type RunDeps, type RunOutcome, timeoutMsFor } from './runner.ts';
import { createDeadline, GRACE_MS } from './signals.ts';

type AnyStreamSpec = StreamCommandSpec<z.ZodObject, z.ZodType, z.ZodObject>;

export const RESERVED_LINE_TYPES = new Set(['summary', 'error', 'heartbeat', 'warning']);

interface EventsFile {
  path(): Promise<string>;
  setPath(p: string): Promise<void>;
  append(line: string): Promise<void>;
}

function eventsFile(defaultPath: () => Promise<string>): EventsFile {
  let current: string | undefined;
  const ensure = async (): Promise<string> => {
    current ??= await defaultPath();
    mkdirSync(dirname(current), { recursive: true });
    return current;
  };
  return {
    path: ensure,
    async setPath(p) {
      const prev = current;
      mkdirSync(dirname(p), { recursive: true });
      if (prev && prev !== p && existsSync(prev)) {
        appendFileSync(p, readFileSync(prev));
        rmSync(prev, { force: true });
      }
      current = p;
    },
    async append(line) {
      appendFileSync(await ensure(), `${line}\n`);
    },
  };
}

function resolveMode(spec: AnyStreamSpec, input: unknown): StreamOutputMode {
  const m = spec.outputMode;
  if (typeof m === 'function') return m(input as never);
  return m ?? 'ndjson';
}

export async function runStream(
  spec: AnyStreamSpec,
  globals: Partial<GlobalOptions>,
  deps: RunDeps,
  rawInput: (signal: AbortSignal) => Promise<Record<string, unknown>>,
  out: OutputOptions,
): Promise<RunOutcome> {
  const name = commandName(spec);
  const clock = deps.clock;
  let deadline: ReturnType<typeof createDeadline> | undefined;
  try {
    if (globals.dryRun && spec.kind === 'read') {
      throw new GhxError('USAGE_UNKNOWN_FLAG', `'ghx ${name}' has no flag '--dry-run'.`, {
        hint: 'Read commands never mutate; --dry-run applies to write commands only.',
        details: { flag: '--dry-run', suggestions: [] },
      });
    }
    deadline = createDeadline(clock, timeoutMsFor(spec, globals.timeout), deps.shutdown.signal, `ghx ${name}`);
    const input = validateInput(spec.input, await rawInput(deadline.signal));
    const mode = resolveMode(spec, input);
    const started = clock.monotonic();
    const events = eventsFile(() =>
      out.artifacts.pathFor('events', `${name.replaceAll(' ', '-')}-${clock.now()}-${secureHex(4)}.ndjson`),
    );
    const built = createContext({
      spec,
      cwd: deps.cwd,
      env: deps.env,
      clock,
      random: deps.random,
      proc: deps.proc,
      ...(deps.git ? { git: deps.git } : {}),
      ...(deps.gh ? { gh: deps.gh(spec.kind, globals.dryRun === true) } : {}),
      artifacts: out.artifacts,
      signal: deadline.signal,
      deadline: deadline.at,
      dryRun: globals.dryRun === true,
      verbose: globals.verbose === true,
      log: globals.verbose && deps.stderrLine ? createLineLogger(deps.stderrLine, () => clock.now()) : nullLogger,
      flagRepo: globals.repo,
    });
    const ctx: StreamContext = { ...built.ctx, events: { path: events.path, setPath: events.setPath } };

    let seq = 0;
    let lastLineAt = clock.monotonic();
    let flushedWarnings = 0;
    const line = (type: string, payload: Record<string, unknown>): Record<string, unknown> => ({
      type,
      seq: seq++,
      at: isoNow(clock),
      ...payload,
    });
    /** A non-terminal line: bounded at 4 KB; an oversized payload is spilled and replaced by its path. */
    const writeLine = async (obj: Record<string, unknown>): Promise<void> => {
      let text = serializeJson(obj);
      if (byteLength(text) > DEFAULT_MAX_EVENT_BYTES) {
        const ref = await out.artifacts.write({
          kind: 'events',
          name: `${name.replaceAll(' ', '-')}-${clock.now()}-${String(obj.seq)}.json`,
          content: `${text}\n`,
        });
        text = serializeJson({ type: obj.type, seq: obj.seq, at: obj.at, spilled: ref.path });
      }
      await events.append(text);
      if (mode === 'ndjson') await deps.stdout.writeLine(text);
      lastLineAt = clock.monotonic();
    };
    const flushWarnings = async (): Promise<void> => {
      while (flushedWarnings < built.warnings.length) {
        const w = built.warnings[flushedWarnings++] as Warning;
        await writeLine(line('warning', { ...w }));
      }
    };
    /** The terminal line: bounded by maxBytes (02 §15 ask 2). In final mode stdout gets the bare object. */
    const terminal = async (kind: 'summary' | 'error', body: object): Promise<void> => {
      await flushWarnings();
      const obj = line(kind, body as Record<string, unknown>);
      const text = serializeJson(obj);
      if (byteLength(text) <= out.maxBytes) {
        await events.append(text);
      } else {
        const ref = await out.artifacts.write({
          kind: 'events',
          name: `${name.replaceAll(' ', '-')}-${clock.now()}-terminal.json`,
          content: `${text}\n`,
        });
        await events.append(serializeJson({ type: obj.type, seq: obj.seq, at: obj.at, spilled: ref.path }));
      }
      if (mode === 'final') {
        await emitDocument(deps.stdout, body, out);
      } else if (byteLength(text) <= out.maxBytes) {
        await deps.stdout.writeLine(text);
      } else {
        await emitDocument(deps.stdout, obj, out);
      }
    };
    const terminalError = async (e: unknown): Promise<number> => {
      if (e instanceof GhxError) {
        await terminal('error', toErrorObject(e));
        return e.exitCode;
      }
      const err = e instanceof Error ? e : new Error(String(e));
      let stackPath: string | undefined;
      try {
        stackPath = (
          await out.artifacts.write({
            kind: 'internal',
            name: `stack-${clock.now()}.txt`,
            content: err.stack ?? err.message,
          })
        ).path;
      } catch {
        stackPath = undefined;
      }
      await terminal(
        'error',
        toErrorObject(
          new GhxError('INTERNAL', `Unexpected: ${err.message}`, stackPath ? { details: { stackPath } } : {}),
        ),
      );
      return ExitCode.INTERNAL;
    };

    const gen = spec.run(input, ctx);
    const shutdown = deps.shutdown;
    const shutdownHit = new Promise<void>((r) => {
      if (shutdown.signal.aborted) r();
      shutdown.signal.addEventListener('abort', () => r(), { once: true });
    });
    let graceTimer: Promise<'grace'> | undefined;
    const graceStop = new AbortController();
    const armGrace = (): Promise<'grace'> => {
      graceTimer ??= Promise.race([
        clock.sleep(GRACE_MS, graceStop.signal).then(
          () => 'grace' as const,
          () => new Promise<'grace'>(() => {}),
        ),
        shutdown.forced.then(() => 'grace' as const),
      ]);
      return graceTimer;
    };
    const signalExit = (): number | undefined => (shutdown.signal.aborted ? exitForSignal(shutdown.cause) : undefined);

    try {
      for (;;) {
        await flushWarnings();
        const next = gen.next().then(
          (r) => ({ kind: 'next' as const, r }),
          (e: unknown) => ({ kind: 'throw' as const, e }),
        );
        let step: Awaited<typeof next> | 'grace';
        for (;;) {
          const racers: Promise<Awaited<typeof next> | 'grace' | 'heartbeat' | 'shutdown'>[] = [next];
          const hbStop = new AbortController();
          if (shutdown.signal.aborted) racers.push(armGrace());
          else racers.push(shutdownHit.then(() => 'shutdown' as const));
          if (mode === 'ndjson' && spec.heartbeatMs && !shutdown.signal.aborted) {
            const wait = Math.max(0, spec.heartbeatMs - (clock.monotonic() - lastLineAt));
            racers.push(
              clock.sleep(wait, hbStop.signal).then(
                () => 'heartbeat' as const,
                () => new Promise<never>(() => {}),
              ),
            );
          }
          const got = await Promise.race(racers);
          hbStop.abort();
          if (got === 'heartbeat') {
            await writeLine(line('heartbeat', { elapsedMs: Math.round(clock.monotonic() - started) }));
            continue;
          }
          if (got === 'shutdown') continue;
          step = got;
          break;
        }
        if (step === 'grace') {
          // Ungraceful: the generator did not settle within the grace window (or a second signal came).
          void gen.return(undefined as never).catch(() => {});
          await terminal('error', toErrorObject(shutdown.signal.reason));
          return { exitCode: exitForSignal(shutdown.cause), forced: true };
        }
        if (step.kind === 'throw') {
          const code = await terminalError(
            step.e instanceof DryRunHalt
              ? new GhxError('INTERNAL', 'stream commands cannot dry-run a mutation.')
              : step.e,
          );
          return { exitCode: signalExit() ?? code, forced: false };
        }
        if (step.r.done) {
          const value = {
            ...(step.r.value as Record<string, unknown>),
            ...(built.warnings.length > 0 && mode === 'final' ? { warnings: built.warnings } : {}),
          };
          const checked = spec.summarySchema.extend({ warnings: Warning.array().optional() }).safeParse(value);
          if (!checked.success) {
            await terminalError(
              new GhxError('INTERNAL_OUTPUT_CONTRACT', `ghx ${name} returned a summary that violates its schema.`, {
                details: {
                  issues: checked.error.issues
                    .slice(0, 20)
                    .map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
                },
              }),
            );
            return { exitCode: ExitCode.INTERNAL, forced: false };
          }
          await terminal('summary', checked.data as Record<string, unknown>);
          return { exitCode: signalExit() ?? spec.exitCode?.(checked.data as never) ?? ExitCode.OK, forced: false };
        }
        const ev = step.r.value as Record<string, unknown>;
        const checked = spec.event.safeParse(ev);
        const type = (checked.success ? (checked.data as { type?: unknown }).type : ev?.type) as unknown;
        if (!checked.success || typeof type !== 'string' || RESERVED_LINE_TYPES.has(type)) {
          void gen.return(undefined as never).catch(() => {});
          await terminalError(
            new GhxError('INTERNAL_OUTPUT_CONTRACT', `ghx ${name} yielded an event that violates its schema.`, {
              details: {
                issues: checked.success
                  ? [
                      {
                        path: 'type',
                        message: `reserved or missing event type '${String(type)}'`,
                        code: 'invalid_type',
                      },
                    ]
                  : checked.error.issues
                      .slice(0, 20)
                      .map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
              },
            }),
          );
          return { exitCode: ExitCode.INTERNAL, forced: false };
        }
        const { type: _t, ...payload } = checked.data as Record<string, unknown>;
        await flushWarnings();
        await writeLine(line(type, payload));
      }
    } finally {
      graceStop.abort();
    }
  } catch (e) {
    return { exitCode: await emitError(deps.stdout, e, out, clock), forced: false };
  } finally {
    deadline?.cancel();
  }
}
