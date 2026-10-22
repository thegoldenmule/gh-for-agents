// Command specs (01 §3.1). A command is one file under src/commands/ whose default export is a
// defineCommand(...) or defineStreamCommand(...) result; its path is its name (src/cli/registry.ts).
import { z } from 'zod';
import type { LoadedConfig } from '../config/load.ts';
import type { Gh } from '../gh/index.ts';
import type { RepoNeed, ResolvedRepo } from '../gh/repo.ts';
import type { RepoRef } from '../gh/types.ts';
import type { Git } from '../git/index.ts';
import type { ArtifactStore } from './artifacts.ts';
import type { Clock } from './clock.ts';
import type { ExitCode } from './exit.ts';
import type { Logger } from './log.ts';
import type { Random } from './random.ts';

export type CommandKind = 'read' | 'write';
export type { RepoNeed };
export type ConfigNeed = 'none' | 'optional' | 'required';

export interface TimeoutSpec {
  defaultMs: number;
  maxMs: number;
}

export const DEFAULT_TIMEOUT: TimeoutSpec = { defaultMs: 60_000, maxMs: 300_000 };

export const Warning = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type Warning = z.infer<typeof Warning>;

export interface CommandExample {
  argv: string;
  note?: string;
  /** JSON input for the registry smoke test (sent as `--input -`). */
  input?: unknown;
}

interface BaseSpec<I extends z.ZodObject> {
  /** ['pr', 'status']. Must equal the file's path under src/commands/ (registry.test.ts). */
  name: readonly [string, ...string[]];
  /** One line, ≤100 chars, shown in `ghx --help`. */
  summary: string;
  description?: string;
  kind: CommandKind;
  /** Top-level object; scalar fields become flags, the rest are JSON-only (01 §3.3). */
  input: I;
  /** Input fields filled from positionals, in order. An array field must be last and takes the rest. */
  positionals?: readonly (keyof z.input<I> & string)[];
  needs?: { repo?: RepoNeed; config?: ConfigNeed };
  /** Default {60 s, 300 s}. `null` means no deadline (ci wait); --timeout is then refused. */
  timeout?: TimeoutSpec | null;
  /** Raw gh invocations this command replaces, for help, refusal hints and the steering hook. */
  replaces?: readonly string[];
  examples?: readonly CommandExample[];
  /** 'required': JSON must come from --input (USAGE_INPUT_MISSING otherwise). Default 'optional'. */
  jsonInput?: 'required' | 'optional';
}

export interface SingleCommandSpec<I extends z.ZodObject, O extends z.ZodObject> extends BaseSpec<I> {
  mode: 'single';
  output: O;
  run(input: z.output<I>, ctx: Context): Promise<z.input<O>>;
  /** Default ExitCode.OK. */
  exitCode?(output: z.output<O>): ExitCode;
}

export type StreamOutputMode = 'final' | 'ndjson';

export interface StreamCommandSpec<I extends z.ZodObject, E extends z.ZodType, S extends z.ZodObject>
  extends BaseSpec<I> {
  mode: 'stream';
  /** Discriminated union on `type`; reserved types: summary, error, heartbeat, warning. */
  event: E;
  /** The terminal summary's schema (printed as `summary` by --schema). */
  summarySchema: S;
  /** Emit a heartbeat line after this much silence (ndjson mode). */
  heartbeatMs?: number;
  /**
   * 'final' (03 §1 row 3): every line goes to the events file and stdout gets only the terminal
   * object as one JSON document. 'ndjson': every line also goes to stdout. Default 'ndjson'.
   */
  outputMode?: StreamOutputMode | ((input: z.output<I>) => StreamOutputMode);
  run(input: z.output<I>, ctx: StreamContext): AsyncGenerator<z.input<E>, z.input<S>, void>;
  exitCode?(summary: z.output<S>): ExitCode;
}

export type AnyCommandSpec =
  | SingleCommandSpec<z.ZodObject, z.ZodObject>
  | StreamCommandSpec<z.ZodObject, z.ZodType, z.ZodObject>;

export function defineCommand<I extends z.ZodObject, O extends z.ZodObject>(
  s: Omit<SingleCommandSpec<I, O>, 'mode'>,
): SingleCommandSpec<I, O> {
  return { ...s, mode: 'single' };
}

export function defineStreamCommand<I extends z.ZodObject, E extends z.ZodType, S extends z.ZodObject>(
  s: Omit<StreamCommandSpec<I, E, S>, 'mode'>,
): StreamCommandSpec<I, E, S> {
  return { ...s, mode: 'stream' };
}

export function commandName(spec: Pick<AnyCommandSpec, 'name'>): string {
  return spec.name.join(' ');
}

/** What every handler receives (01 §3.1). */
export interface Context {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock: Clock;
  readonly random: Random;
  /** Aborts on the deadline or on shutdown; the reason is a GhxError (TIMEOUT | INTERRUPTED). */
  readonly signal: AbortSignal;
  /** clock.monotonic() at which `signal` fires; undefined for no deadline. */
  readonly deadline: number | undefined;
  /** Read mode for read commands (mutations throw), write mode otherwise. */
  readonly gh: Gh;
  readonly git: Git;
  readonly artifacts: ArtifactStore;
  /** --dry-run (write commands only). Local fs writes must check it themselves. */
  readonly dryRun: boolean;
  /** Resolve the target repo (memoized; honors needs.repo). Throws when nothing resolves. */
  repo(o?: { ref?: RepoRef | undefined }): Promise<ResolvedRepo>;
  /** Like repo(), but undefined when nothing resolves and needs.repo is 'optional'. */
  tryRepo(o?: { ref?: RepoRef | undefined }): Promise<ResolvedRepo | undefined>;
  /** .github/ghx.json of the TARGET repo (memoized; honors needs.config). */
  config(o?: { ref?: RepoRef | undefined }): Promise<LoadedConfig>;
  warn(w: Warning): void;
  /** Attached to the dry-run result. */
  preview(value: unknown): void;
  /** stderr NDJSON, only with --verbose. */
  readonly log: Logger;
}

export interface StreamContext extends Context {
  readonly events: {
    /** Absolute path of the events NDJSON file (created on first use under the artifact dir). */
    path(): Promise<string>;
    /** Move the events file (e.g. into a per-SHA state dir). Lines written so far are copied. */
    setPath(path: string): Promise<void>;
  };
}
