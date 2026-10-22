// JSON help (01 §7): one contract, no prose pages. Global help stays under 4 KB with ~20 commands, so
// `commands` maps each name to one short "<kind>: <summary>" line, and each global flag is one line;
// modes, flags, replaces and examples belong in `ghx <cmd> --help`.
import type { AnyCommandSpec } from '../core/command.ts';
import { commandName, DEFAULT_TIMEOUT } from '../core/command.ts';
import { deriveInterface, GLOBAL_FLAGS } from './args.ts';

export const BUILTINS = [
  { name: 'help', kind: 'read', summary: 'JSON help: ghx help [command]' },
  { name: 'schema', kind: 'read', summary: 'JSON Schemas: ghx schema [command|envelopes|config] [--all]' },
] as const;

/** One line per global flag: `--repo, -R <string>: owner/name; …`. */
function flagLine(g: (typeof GLOBAL_FLAGS)[number]): string {
  const alias = 'alias' in g && g.alias ? `, ${g.alias}` : '';
  const value = g.type === 'boolean' ? '' : ` <${g.type}>`;
  return `${g.flag}${alias}${value}: ${g.description}`;
}

export function globalHelp(specs: readonly AnyCommandSpec[], version: string): Record<string, unknown> {
  return {
    name: 'ghx',
    version,
    summary: 'GitHub for agents: validated writes, one-call reads. Wraps gh.',
    usage: 'ghx <group> <command> [positionals] [--flags] [--input file.json|-]',
    rules: [
      'One plain call per question: no pipes, --jq, head, sleep or timeout.',
      'stdout is one JSON document; errors are {error:{code,message,hint,details}}, exit non-zero.',
      'Large artifacts are written to files; the result carries their paths.',
    ],
    globalFlags: GLOBAL_FLAGS.map(flagLine),
    commands: Object.fromEntries(
      [...specs.map((s) => ({ name: commandName(s), kind: s.kind, summary: s.summary })), ...BUILTINS].map((c) => [
        c.name,
        `${c.kind}: ${c.summary}`,
      ]),
    ),
    next: 'ghx <command> --help | --schema; ghx doctor checks setup',
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
