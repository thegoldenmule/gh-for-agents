// `ghx <cmd> --schema` and `ghx schema [target]` (01 §3.4): draft 2020-12 JSON Schema via z.toJSONSchema.
//
// Extension point: a non-command schema target is ONE entry appended to SCHEMA_TARGETS.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { parseConfigText } from '../config/load.ts';
import { CONFIG_PATH, ConfigSchema, type GhxConfig } from '../config/schema.ts';
import type { AnyCommandSpec } from '../core/command.ts';
import { commandName, Warning } from '../core/command.ts';
import { ENVELOPES } from '../core/envelopes.ts';

const toJson = (s: z.ZodType, io: 'input' | 'output'): unknown => z.toJSONSchema(s, { io, unrepresentable: 'any' });

export const SCHEMA_TARGETS: Record<string, { description: string; build: () => unknown }> = {
  envelopes: {
    description: 'error, spilled, dryRun and streamLine envelopes shared by every command',
    build: () => Object.fromEntries(Object.entries(ENVELOPES).map(([k, s]) => [k, toJson(s, 'output')])),
  },
  config: { description: '.github/ghx.json, the per-repo config', build: () => toJson(ConfigSchema, 'input') },
};

/**
 * The .github/ghx.json of the checkout containing `cwd` (the nearest directory with `.git`), for a
 * repo-aware schemaView. Undefined when there is none or it does not parse: the schema is documentation,
 * so a broken config never fails it.
 */
export function cwdConfig(cwd: string): GhxConfig | undefined {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) {
      const path = join(dir, CONFIG_PATH);
      if (!existsSync(path)) return undefined;
      try {
        return parseConfigText(readFileSync(path, 'utf8'), { kind: 'local', path });
      } catch {
        return undefined;
      }
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * The command's schema document. `view` applies spec.schemaView (with the cwd repo's config, when given);
 * `schema --all` passes false and keeps the derived schema.
 */
export function commandSchema(
  spec: AnyCommandSpec,
  view: { config?: GhxConfig | undefined } | false = {},
): Record<string, unknown> {
  const base = {
    command: commandName(spec),
    kind: spec.kind,
    mode: spec.mode,
    input: toJson(spec.input, 'input'),
    envelopes: 'ghx schema envelopes',
    // --fields paths are checked against `output` (or `summary`); --brief selects these.
    brief: spec.brief ?? null,
  };
  // The view's fields follow `input` (rules beside the schema they explain); output stays last.
  const extra = view !== false && spec.schemaView ? spec.schemaView(view.config) : {};
  const { output: viewOutput, ...viewRest } = extra;
  const head = { command: base.command, kind: base.kind, mode: base.mode, input: base.input, ...viewRest };
  const tail = { envelopes: base.envelopes, brief: base.brief };
  if (spec.mode === 'single') {
    const output = viewOutput ?? toJson(spec.output.extend({ warnings: Warning.array().optional() }), 'output');
    return { ...head, ...tail, output };
  }
  return {
    ...head,
    ...tail,
    event: toJson(spec.event, 'output'),
    summary: toJson(spec.summarySchema.extend({ warnings: Warning.array().optional() }), 'output'),
  };
}

export function schemaIndex(specs: readonly AnyCommandSpec[]): Record<string, unknown> {
  return {
    commands: specs.map((s) => ({ name: commandName(s), kind: s.kind, mode: s.mode, summary: s.summary })),
    targets: Object.keys(SCHEMA_TARGETS),
  };
}

export function allSchemas(specs: readonly AnyCommandSpec[]): Record<string, unknown> {
  return {
    commands: Object.fromEntries(specs.map((s) => [commandName(s), commandSchema(s, false)])),
    targets: Object.fromEntries(Object.entries(SCHEMA_TARGETS).map(([k, t]) => [k, t.build()])),
  };
}
