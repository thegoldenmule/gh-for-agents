// What happens to an argv that names no ghx command (01 §3.7). 02 §10 owns the passthrough policy;
// until it lands (M7.1), every unknown command is refused with "did you mean" suggestions.
//
// Extension point for passthrough: return {kind: 'run', spec, input} to run a synthetic spec (with
// raw input, no ghx flag parsing) through the normal runner, or {kind: 'refuse', error} to refuse.

import type { AnyCommandSpec } from '../core/command.ts';
import { GhxError } from '../core/errors.ts';
import { suggest } from '../core/suggest.ts';
import type { GlobalOptions } from './args.ts';

export type UnknownResult =
  | { kind: 'refuse'; error: GhxError }
  | { kind: 'run'; spec: AnyCommandSpec; input: Record<string, unknown>; globals?: Partial<GlobalOptions> };

export interface UnknownContext {
  /** Every registered command name. */
  names: readonly string[][];
}

export async function onUnknown(tokens: readonly string[], ctx: UnknownContext): Promise<UnknownResult> {
  const words = tokens.filter((t) => !t.startsWith('-'));
  const typed = words.slice(0, 2).join(' ');
  const all = ctx.names.map((n) => n.join(' '));
  const suggestions = suggest(typed, all);
  if (suggestions.length === 0 && words[0])
    suggestions.push(
      ...suggest(
        words[0],
        all.map((n) => n.split(' ')[0] ?? n),
      ),
    );
  const hint =
    suggestions.length > 0
      ? `Did you mean: ${suggestions.map((s) => `ghx ${s}`).join(', ')}?`
      : 'Run ghx --help to list commands.';
  return {
    kind: 'refuse',
    error: new GhxError('USAGE_UNKNOWN_COMMAND', `'ghx ${typed || tokens.join(' ')}' is not a ghx command.`, {
      hint,
      details: { suggestions },
    }),
  };
}
