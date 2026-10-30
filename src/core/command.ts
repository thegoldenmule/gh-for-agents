// Command specs (01 §3.1). A command is one file under src/commands/ whose default export is a
// defineCommand(...) or defineStreamCommand(...) result; its path is its name (src/cli/registry.ts).
import { z } from 'zod';
import type { LoadedConfig } from '../config/load.ts';
import type { Gh } from '../gh/index.ts';
import type { RepoNeed, ResolvedRepo } from '../gh/repo.ts';
import type { RepoRef } from '../gh/types.ts';
import type { Git } from '../git/index.ts';
import type { ProcessRunner } from '../proc/runner.ts';
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
  /**
   * The --brief preset: --fields paths (src/core/fields.ts) an agent reads after this command, checked
   * against the output schema by test/unit/core/fields.test.ts. Written without `[]` (it is optional),
   * so what help shows is safe to type unquoted. Without it, --brief prints the whole output with the
   * warning BRIEF_NO_PRESET.
   */
  brief?: readonly string[];
  /** Where a --fields or --brief error sends the caller for the field list. Default: `See ghx <name> --schema.` */
  fieldsHint?: string;
  /**
   * `ghx schema <name>` and `--schema`: fields that replace the derived document's (a compact `input` with
   * the rules, say). `config` is the cwd repo's .github/ghx.json when one is found. `schema --all` keeps
   * the derived schema.
   */
  schemaView?: (config: LoadedConfig['config'] | undefined) => Record<string, unknown>;
  /** 'required': JSON must come from --input (USAGE_INPUT_MISSING otherwise). Default 'optional'. */
  jsonInput?: 'required' | 'optional';
  /**
   * A harness protocol that owns stdin and stdout (`ghx hook claude-pretooluse`). When set, a call
   * without --help/--schema skips the runner: stdin is read whole, a non-null reply is written
   * verbatim, and the exit code is always 0. The one exception to "stdin only via --input -".
   * `clock` timestamps its opt-in log (GHX_HOOK_LOG).
   */
  protocol?: (stdin: string, env: Readonly<Record<string, string | undefined>>, clock: Clock) => string | null;
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
  /** 'fixed': the output bound is always DEFAULT_MAX_BYTES; --max-bytes and GHX_MAX_BYTES are ignored. */
  maxBytes?: 'fixed';
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
  /** The raw process seam, for programs other than gh and git (ghx install runs npm). Not mode-guarded. */
  readonly proc: ProcessRunner;
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
  /**
   * The --fields/--brief projection the runner applies to the returned document (src/core/fields.ts), or
   * undefined. The handler still returns the whole document (it is validated and gives the exit code); one
   * that bounds its own output measures and cuts what project(doc) keeps, so unselected parts cost nothing.
   */
  readonly project?: ((doc: unknown) => unknown) | undefined;
}

export interface StreamContext extends Context {
  readonly events: {
    /** Absolute path of the events NDJSON file (created on first use under the artifact dir). */
    path(): Promise<string>;
    /** Move the events file (e.g. into a per-SHA state dir). Lines written so far are copied. */
    setPath(path: string): Promise<void>;
  };
}
