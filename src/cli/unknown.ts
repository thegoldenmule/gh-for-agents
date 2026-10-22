// What happens to an argv that names no ghx command (01 §3.7, 02 §10). src/passthrough/policy.ts
// decides: an allowlisted gh read runs as a synthetic read spec (raw input, no ghx flag parsing), a
// wrapped command or a write is refused, and anything else is unknown, with "did you mean" suggestions.

import type { AnyCommandSpec } from '../core/command.ts';
import { GhxError } from '../core/errors.ts';
import { suggest } from '../core/suggest.ts';
import { ALLOWED_NAMES, decide } from '../passthrough/policy.ts';
import { passthroughSpec } from '../passthrough/run.ts';
import type { GlobalOptions } from './args.ts';

export type UnknownResult =
  | { kind: 'refuse'; error: GhxError }
  | { kind: 'run'; spec: AnyCommandSpec; input: Record<string, unknown>; globals?: Partial<GlobalOptions> };

export interface UnknownContext {
  /** Every registered command name. */
  names: readonly string[][];
}

export async function onUnknown(tokens: readonly string[], ctx: UnknownContext): Promise<UnknownResult> {
  const d = decide(tokens);
  if (d.kind === 'refuse') return d;
  if (d.kind === 'run') {
    return { kind: 'run', spec: passthroughSpec(d.plan.name), input: { ...d.plan }, globals: d.globals };
  }
  const words = d.words.length > 0 ? d.words : tokens.filter((t) => !t.startsWith('-')).slice(0, 2);
  const typed = words.join(' ');
  const all = [...ctx.names.map((n) => n.join(' ')), ...ALLOWED_NAMES];
  const suggestions = suggest(typed, all);
  if (suggestions.length === 0 && words[0])
    suggestions.push(
      ...suggest(
        words[0],
        all.map((n) => n.split(' ')[0] ?? n),
      ),
    );
  const didYouMean = suggestions.length > 0 ? `Did you mean: ${suggestions.map((s) => `ghx ${s}`).join(', ')}?` : '';
  const hint = d.ghKnown
    ? `gh ${typed} is not on the passthrough allowlist (reads only: ${ALLOWED_NAMES.join(', ')}). ${didYouMean || 'Run ghx --help for ghx commands.'}`
    : didYouMean || 'Run ghx --help to list commands.';
  return {
    kind: 'refuse',
    error: new GhxError('USAGE_UNKNOWN_COMMAND', `'ghx ${typed || tokens.join(' ')}' is not a ghx command.`, {
      hint,
      details: { suggestions },
    }),
  };
}
