// `ghx <cmd> --schema` and `ghx schema [target]` (01 §3.4): draft 2020-12 JSON Schema via z.toJSONSchema.
//
// Extension point: a non-command schema target is ONE entry appended to SCHEMA_TARGETS.
import { z } from 'zod';
import type { AnyCommandSpec } from '../core/command.ts';
import { commandName, Warning } from '../core/command.ts';
import { ENVELOPES } from '../core/envelopes.ts';

const toJson = (s: z.ZodType, io: 'input' | 'output'): unknown => z.toJSONSchema(s, { io, unrepresentable: 'any' });

export const SCHEMA_TARGETS: Record<string, { description: string; build: () => unknown }> = {
  envelopes: {
    description: 'error, spilled, dryRun and streamLine envelopes shared by every command',
    build: () => Object.fromEntries(Object.entries(ENVELOPES).map(([k, s]) => [k, toJson(s, 'output')])),
  },
};

export function commandSchema(spec: AnyCommandSpec): Record<string, unknown> {
  const base = {
    command: commandName(spec),
    kind: spec.kind,
    mode: spec.mode,
    input: toJson(spec.input, 'input'),
    envelopes: 'ghx schema envelopes',
  };
  if (spec.mode === 'single') {
    return { ...base, output: toJson(spec.output.extend({ warnings: Warning.array().optional() }), 'output') };
  }
  return {
    ...base,
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
    commands: Object.fromEntries(specs.map((s) => [commandName(s), commandSchema(s)])),
    targets: Object.fromEntries(Object.entries(SCHEMA_TARGETS).map(([k, t]) => [k, t.build()])),
  };
}
