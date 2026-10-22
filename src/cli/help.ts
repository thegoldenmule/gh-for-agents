// JSON help (01 §7): one contract, no prose pages. Global help stays under 4 KB.
import type { AnyCommandSpec } from '../core/command.ts';
import { commandName, DEFAULT_TIMEOUT } from '../core/command.ts';
import { deriveInterface, GLOBAL_FLAGS } from './args.ts';

export const BUILTINS = [
  { name: 'help', kind: 'read', mode: 'single', summary: 'JSON help: ghx help [command]' },
  {
    name: 'schema',
    kind: 'read',
    mode: 'single',
    summary: 'JSON Schemas: ghx schema [command|envelopes|config] [--all]',
  },
] as const;

export function globalHelp(specs: readonly AnyCommandSpec[], version: string): Record<string, unknown> {
  return {
    name: 'ghx',
    version,
    summary: 'GitHub for agents: validated writes, one-call reads. Wraps gh.',
    usage: 'ghx <group> <command> [positionals] [--flags] [--input file.json|-]',
    rules: [
      'One plain call per question: no pipes, --jq, head, sleep or timeout.',
      'stdout is one JSON document (NDJSON only for streams); errors are {error:{code,message,hint,details}} with a non-zero exit.',
      'Large artifacts are written to files; the result carries their paths.',
    ],
    globalFlags: GLOBAL_FLAGS.map((g) => ({ ...g })),
    commands: [
      ...specs.map((s) => ({
        name: commandName(s),
        kind: s.kind,
        mode: s.mode,
        summary: s.summary,
        ...(s.replaces && s.replaces.length > 0 ? { replaces: s.replaces } : {}),
      })),
      ...BUILTINS,
    ],
    next: 'ghx <command> --help for flags and examples; ghx <command> --schema for JSON Schema; ghx doctor to check setup',
  };
}

export function commandHelp(spec: AnyCommandSpec): Record<string, unknown> {
  const d = deriveInterface(spec);
  const name = commandName(spec);
  const timeout = spec.timeout === undefined ? DEFAULT_TIMEOUT : spec.timeout;
  return {
    name,
    summary: spec.summary,
    description: spec.description ?? null,
    kind: spec.kind,
    mode: spec.mode,
    positionals: d.positionals.map((p) => ({ name: p.field, required: p.required, variadic: p.variadic })),
    flags: d.flags.map((f) => ({
      flag: f.flag,
      type: f.type,
      required: f.required,
      ...(f.enum ? { enum: f.enum } : {}),
      ...(f.default !== undefined ? { default: f.default } : {}),
      ...(f.multiple ? { multiple: true } : {}),
      description: f.description ?? null,
    })),
    jsonOnlyFields: d.jsonOnly,
    input:
      spec.jsonInput === 'required'
        ? `JSON input is required: write it to a file, then ghx ${name} --input file.json (or --input -).`
        : d.jsonOnly.length > 0
          ? `JSON-only fields go in --input file.json (or --input -); flags and positionals cover the rest.`
          : 'Flags and positionals only; --input file.json is also accepted.',
    examples: spec.examples ?? [],
    replaces: spec.replaces ?? [],
    timeout,
    ...(spec.kind === 'write' ? { dryRun: `ghx ${name} … --dry-run shows exactly what would be sent` } : {}),
  };
}
