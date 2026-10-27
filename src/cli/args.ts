// argv → raw input object (01 §3.3). Flags are derived from the input schema's JSON Schema, so a
// command declares its interface once (zod) and gets flags, help and --schema from it.
import { parseArgs } from 'node:util';
import { z } from 'zod';
import type { AnyCommandSpec } from '../core/command.ts';
import { GhxError, mapZodIssues } from '../core/errors.ts';
import { ghFlagAlias, suggest } from '../core/suggest.ts';
import { parseJsonWithPosition } from '../util/json.ts';

/** Global flags (01 §3.2): reserved, never derived from input. */
export const GLOBAL_FLAGS = [
  { flag: '--repo', alias: '-R', type: 'string', description: 'owner/name; overrides the cwd repo' },
  { flag: '--input', type: 'string', description: 'JSON input file, or - for stdin' },
  { flag: '--schema', type: 'boolean', description: 'JSON Schema of input and output' },
  { flag: '--help', alias: '-h', type: 'boolean', description: 'JSON help' },
  { flag: '--timeout', type: 'string', description: 'Deadline, e.g. 90s, 10m' },
  { flag: '--dry-run', type: 'boolean', description: 'Writes: show what would be sent' },
  { flag: '--pretty', type: 'boolean', description: 'Indent JSON output' },
  { flag: '--max-bytes', type: 'string', description: 'Spill bound (default 16384)' },
  {
    flag: '--fields',
    type: 'string',
    description: 'Keep only these output paths: state,ci.counts,merge.blockers[].code',
  },
  { flag: '--brief', type: 'boolean', description: "The command's preset --fields" },
  { flag: '--verbose', type: 'boolean', description: 'NDJSON diagnostics on stderr' },
] as const;

export const RESERVED_NAMES = new Set(GLOBAL_FLAGS.map((g) => g.flag.slice(2)));

export const MAX_STDIN_BYTES = 1024 * 1024;

export interface GlobalOptions {
  repo?: string;
  input?: string;
  schema: boolean;
  help: boolean;
  timeout?: string;
  dryRun: boolean;
  pretty: boolean;
  maxBytes?: string;
  verbose: boolean;
  /** --fields values (repeatable; each comma-separated). */
  fields?: string[];
  brief: boolean;
}

type JsonSchema = {
  type?: string | string[];
  enum?: unknown[];
  items?: JsonSchema;
  default?: unknown;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  anyOf?: unknown[];
  oneOf?: unknown[];
  jsonOnly?: boolean;
};

export interface FlagSpec {
  /** --kebab-name */
  flag: string;
  field: string;
  type: 'string' | 'number' | 'integer' | 'boolean';
  multiple: boolean;
  required: boolean;
  enum?: unknown[];
  default?: unknown;
  description?: string;
}

export interface DerivedInterface {
  flags: FlagSpec[];
  /** Fields that can only arrive through --input (objects, unions, arrays of objects). */
  jsonOnly: string[];
  positionals: { field: string; variadic: boolean; required: boolean }[];
}

export function kebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

const SCALAR = new Set(['string', 'number', 'integer', 'boolean']);

function scalarType(s: JsonSchema | undefined): FlagSpec['type'] | undefined {
  if (!s || s.anyOf || s.oneOf) return undefined;
  if (typeof s.type === 'string' && SCALAR.has(s.type)) return s.type as FlagSpec['type'];
  return undefined;
}

export function inputJsonSchema(spec: Pick<AnyCommandSpec, 'input'>): JsonSchema {
  return z.toJSONSchema(spec.input, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
}

/** Flags, JSON-only fields and positionals of a command, from its input schema. */
export function deriveInterface(spec: Pick<AnyCommandSpec, 'input' | 'positionals'>): DerivedInterface {
  const js = inputJsonSchema(spec);
  const required = new Set(js.required ?? []);
  const positional = new Set<string>(spec.positionals ?? []);
  const flags: FlagSpec[] = [];
  const jsonOnly: string[] = [];
  for (const [field, prop] of Object.entries(js.properties ?? {})) {
    if (positional.has(field)) continue;
    // `.meta({jsonOnly: true})`: prose and structured fields arrive through --input only (02 §0), never as flags.
    if (prop.jsonOnly === true) {
      jsonOnly.push(field);
      continue;
    }
    let type = scalarType(prop);
    let multiple = false;
    if (!type && prop.type === 'array') {
      type = scalarType(prop.items);
      multiple = type !== undefined;
    }
    if (!type) {
      jsonOnly.push(field);
      continue;
    }
    const f: FlagSpec = { flag: `--${kebab(field)}`, field, type, multiple, required: required.has(field) };
    const en = multiple ? prop.items?.enum : prop.enum;
    if (en) f.enum = en;
    if (prop.default !== undefined) f.default = prop.default;
    if (prop.description) f.description = prop.description;
    flags.push(f);
  }
  const positionals = (spec.positionals ?? []).map((field) => ({
    field,
    variadic: js.properties?.[field]?.type === 'array',
    required: required.has(field),
  }));
  return { flags, jsonOnly, positionals };
}

const GLOBAL_PARSE_OPTIONS = {
  repo: { type: 'string', short: 'R' },
  input: { type: 'string' },
  schema: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  timeout: { type: 'string' },
  'dry-run': { type: 'boolean' },
  pretty: { type: 'boolean' },
  'max-bytes': { type: 'string' },
  verbose: { type: 'boolean' },
  fields: { type: 'string', multiple: true },
  brief: { type: 'boolean' },
} as const;

export interface ParsedArgv {
  globals: GlobalOptions;
  /** Flag values by input field (already coerced). */
  flagValues: Record<string, unknown>;
  positionals: string[];
}

function unknownFlagError(
  flag: string,
  commandName: string | undefined,
  known: readonly string[],
  hasBrief = false,
): GhxError {
  const where = commandName ? `'ghx ${commandName}'` : 'ghx';
  const alias = ghFlagAlias(commandName, flag);
  const suggestions = alias === undefined ? suggest(flag, known) : alias.use !== undefined ? [alias.use] : [];
  let hint: string;
  if (alias !== undefined) {
    const use = alias.use !== undefined ? `gh's ${flag} is ${alias.use} in ghx` : `gh's ${flag} has no ghx flag`;
    hint = `${use}${alias.note !== undefined ? `; ${alias.note}` : ''}.`;
  } else if (flag === '--json' || flag === '--jq' || flag === '-q' || flag === '--template') {
    const cmd = commandName ? `ghx ${commandName}` : 'ghx <command>';
    hint = `Output is a fixed schema; --fields a.b,c[].d${hasBrief ? ' or --brief' : ''} keeps the parts you need ('${cmd} --schema' lists them).`;
  } else if (suggestions.length > 0) {
    hint = `Did you mean ${suggestions.join(' or ')}?`;
  } else {
    hint = `Run '${commandName ? `ghx ${commandName}` : 'ghx'} --help' for its flags.`;
  }
  return new GhxError('USAGE_UNKNOWN_FLAG', `${where} has no flag '${flag}'.`, {
    hint,
    details: { flag, suggestions },
  });
}

/** Parse argv (the tokens after the command name) against global plus derived flags. */
export function parseCommandArgv(
  tokens: readonly string[],
  spec: AnyCommandSpec | undefined,
  derived: DerivedInterface | undefined,
): ParsedArgv {
  const options: Record<string, { type: 'string' | 'boolean'; short?: string; multiple?: boolean }> = {
    ...GLOBAL_PARSE_OPTIONS,
  };
  for (const f of derived?.flags ?? []) {
    const name = f.flag.slice(2);
    if (RESERVED_NAMES.has(name)) continue;
    options[name] = { type: f.type === 'boolean' ? 'boolean' : 'string', ...(f.multiple ? { multiple: true } : {}) };
  }
  const commandName = spec?.name.join(' ');
  const known = Object.keys(options).map((k) => `--${k}`);
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: [...tokens], options, strict: true, allowPositionals: true, allowNegative: true });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const m = /'(-{1,2}[^'\s]+)'/.exec(err.message);
    if (err.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      throw unknownFlagError(m?.[1] ?? '?', commandName, known, spec?.brief !== undefined);
    }
    throw new GhxError('VALIDATION', err.message.split('\n')[0] ?? 'invalid arguments', {
      details: { issues: [{ path: m?.[1] ?? '(argv)', code: 'invalid_flag', message: err.message.split('\n')[0] }] },
    });
  }
  const v = parsed.values as Record<string, unknown>;
  const globals: GlobalOptions = {
    schema: v.schema === true,
    help: v.help === true,
    dryRun: v['dry-run'] === true,
    pretty: v.pretty === true,
    verbose: v.verbose === true,
    brief: v.brief === true,
  };
  if (typeof v.repo === 'string') globals.repo = v.repo;
  if (typeof v.input === 'string') globals.input = v.input;
  if (typeof v.timeout === 'string') globals.timeout = v.timeout;
  if (typeof v['max-bytes'] === 'string') globals.maxBytes = v['max-bytes'];
  if (Array.isArray(v.fields)) globals.fields = v.fields as string[];

  const flagValues: Record<string, unknown> = {};
  const issues: { path: string; code: string; message: string }[] = [];
  for (const f of derived?.flags ?? []) {
    const raw = v[f.flag.slice(2)];
    if (raw === undefined || RESERVED_NAMES.has(f.flag.slice(2))) continue;
    const coerce = (x: unknown): unknown => {
      if (f.type !== 'number' && f.type !== 'integer') return x;
      const n = Number(x);
      if (typeof x !== 'string' || x.trim() === '' || !Number.isFinite(n)) {
        issues.push({ path: f.flag, code: 'invalid_type', message: `${f.flag} expects a number, got '${String(x)}'` });
        return x;
      }
      return n;
    };
    flagValues[f.field] = Array.isArray(raw) ? raw.map(coerce) : coerce(raw);
  }
  if (issues.length > 0) {
    throw new GhxError('VALIDATION', `${issues.length} input issue${issues.length === 1 ? '' : 's'}.`, {
      hint: issues[0]?.message,
      details: { issues },
    });
  }
  return { globals, flagValues, positionals: parsed.positionals };
}

/** Map positionals to fields; an array field (last) takes the rest. */
export function positionalValues(
  positionals: readonly string[],
  derived: DerivedInterface,
  commandName: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let i = 0;
  for (const p of derived.positionals) {
    if (i >= positionals.length) break;
    if (p.variadic) {
      out[p.field] = positionals.slice(i);
      i = positionals.length;
    } else {
      out[p.field] = positionals[i++];
    }
  }
  if (i < positionals.length) {
    const extra = positionals.slice(i);
    throw new GhxError(
      'VALIDATION',
      `'ghx ${commandName}' got unexpected argument${extra.length > 1 ? 's' : ''}: ${extra.join(' ')}`,
      {
        hint: `Run 'ghx ${commandName} --help' for its arguments.`,
        details: { issues: [{ path: '(positional)', code: 'unexpected_argument', message: extra.join(' ') }] },
      },
    );
  }
  return out;
}

export interface InputSourceDeps {
  readFile(path: string): Promise<string>;
  /** Read stdin fully, at most `maxBytes` (+1 to detect overflow), honoring `signal`. */
  readStdin(maxBytes: number, signal: AbortSignal): Promise<string>;
}

/** Load and parse --input (a file, or - for stdin). Stdin is read only here. */
export async function loadJsonInput(
  source: string,
  deps: InputSourceDeps,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const label = source === '-' ? 'stdin' : source;
  let text: string;
  if (source === '-') {
    text = await deps.readStdin(MAX_STDIN_BYTES, signal);
    if (Buffer.byteLength(text) > MAX_STDIN_BYTES) {
      throw new GhxError('USAGE_INPUT_JSON', `stdin input exceeds ${MAX_STDIN_BYTES} bytes.`, {
        hint: 'Inputs are small JSON documents; write the JSON to a file and pass --input file.json.',
        details: { maxBytes: MAX_STDIN_BYTES },
      });
    }
  } else {
    try {
      text = await deps.readFile(source);
    } catch (e) {
      throw new GhxError('USAGE_INPUT_JSON', `Cannot read --input ${source}: ${(e as Error).message}`, {
        hint: 'Write the JSON with your file tool, then pass its path.',
        details: { path: source },
      });
    }
  }
  const parsed = parseJsonWithPosition(text);
  if (!parsed.ok) {
    const at = parsed.line !== null ? ` at line ${parsed.line}, column ${parsed.column}` : '';
    throw new GhxError('USAGE_INPUT_JSON', `${label} is not valid JSON: ${parsed.message}${at}.`, {
      hint: `Fix the JSON in ${label}; do not build it with shell interpolation.`,
      details: { line: parsed.line, column: parsed.column },
    });
  }
  const v = parsed.value;
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new GhxError('USAGE_INPUT_JSON', `${label} must hold a JSON object.`, { details: { line: 1, column: 1 } });
  }
  return v as Record<string, unknown>;
}

/** Shallow merge; a field from two sources is USAGE_INPUT_CONFLICT (no source wins silently). */
export function mergeSources(sources: { name: string; values: Record<string, unknown> }[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const from: Record<string, string> = {};
  for (const s of sources) {
    for (const [k, v] of Object.entries(s.values)) {
      if (k in from) {
        throw new GhxError('USAGE_INPUT_CONFLICT', `'${k}' was given both ${from[k]} and ${s.name}.`, {
          hint: `Pass ${k} once.`,
          details: { field: k, sources: [from[k], s.name] },
        });
      }
      from[k] = s.name;
      out[k] = v;
    }
  }
  return out;
}

/** spec.input.safeParse with VALIDATION issues (did-you-mean on unknown keys and enum values). */
export function validateInput<I extends z.ZodObject>(schema: I, raw: Record<string, unknown>): z.output<I> {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  const issues = mapZodIssues(r.error, { schema, input: raw, suggest: (w, c) => suggest(w, c) });
  const first = issues.find((i) => i.suggestion !== undefined) ?? issues[0];
  const hint = first
    ? `${first.path || 'input'}: ${first.message}${first.suggestion ? ` (did you mean '${first.suggestion}'?)` : ''}`
    : undefined;
  throw new GhxError('VALIDATION', `${issues.length} input issue${issues.length === 1 ? '' : 's'}.`, {
    hint,
    details: { issues },
  });
}
