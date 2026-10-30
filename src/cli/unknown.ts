// What happens to an argv that names no ghx command (01 §3.7, 02 §10). A gh-shaped read with a faithful
// ghx equivalent (src/passthrough/redirect.ts: pr view → pr status, run view --log-failed → ci why) runs
// that command, with a REDIRECTED warning naming it for next time. Otherwise src/passthrough/policy.ts
// decides: an allowlisted gh read runs as a synthetic read spec (raw input, no ghx flag parsing), a
// wrapped command or a write is refused, and anything else is unknown, with "did you mean" suggestions.

import type { AnyCommandSpec, Context, Warning } from '../core/command.ts';
import { GhxError } from '../core/errors.ts';
import { suggest } from '../core/suggest.ts';
import { ALLOWED_NAMES, decide } from '../passthrough/policy.ts';
import { type ReadRedirect, readRedirect } from '../passthrough/redirect.ts';
import { passthroughSpec } from '../passthrough/run.ts';
import { deriveInterface, type GlobalOptions, parseCommandArgv, positionalValues } from './args.ts';
import type { Resolved } from './registry.ts';

export type UnknownResult =
  | { kind: 'refuse'; error: GhxError }
  | { kind: 'run'; spec: AnyCommandSpec; input: Record<string, unknown>; globals?: Partial<GlobalOptions> };

export interface UnknownContext {
  /** Every registered command name. */
  names: readonly string[][];
  /**
   * Resolve a ghx command, so a gh-shaped read can run its equivalent. Absent (help, `ghx help pr view`):
   * nothing is redirected, and the refusal names the command instead.
   */
  resolve?: (tokens: readonly string[]) => Promise<Resolved | undefined>;
}

export async function onUnknown(tokens: readonly string[], ctx: UnknownContext): Promise<UnknownResult> {
  if (ctx.resolve !== undefined) {
    const r = await redirected(tokens, ctx.resolve);
    if (r !== undefined) return r;
  }
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

const HELP_FLAGS = new Set(['--help', '-h', '--schema']);

/** The redirect for a gh-shaped read, ready to run, or undefined to fall back to the refusal. */
async function redirected(
  tokens: readonly string[],
  resolve: NonNullable<UnknownContext['resolve']>,
): Promise<UnknownResult | undefined> {
  if (tokens.some((t) => HELP_FLAGS.has(t))) return undefined;
  const r = readRedirect(tokens);
  if (r === undefined) return undefined;
  if (r.command[0] === 'api') {
    // The read guard still decides: the redirect runs only what `ghx api <endpoint>` would.
    const d = decide([...r.command, ...r.args]);
    if (d.kind !== 'run') return undefined;
    const maxBytes = r.globals.maxBytes !== undefined ? { maxBytes: Number(r.globals.maxBytes) } : {};
    return {
      kind: 'run',
      spec: withNote(passthroughSpec(d.plan.name), note(r)),
      input: { ...d.plan, ...maxBytes },
      globals: { ...d.globals, ...r.globals },
    };
  }
  const hit = await resolve(r.command);
  if (hit === undefined || hit.consumed !== r.command.length) return undefined;
  const derived = deriveInterface(hit.spec);
  try {
    // The target's own flags parse as typed; anything it does not take keeps the refusal and its hint.
    const parsed = parseCommandArgv(r.args, hit.spec, derived);
    if (parsed.globals.input !== undefined || parsed.globals.dryRun) return undefined;
    const input = { ...positionalValues(parsed.positionals, derived, r.command.join(' ')), ...parsed.flagValues };
    return {
      kind: 'run',
      spec: withNote(hit.spec, note(r)),
      input,
      globals: { ...parsed.globals, ...r.globals },
    };
  } catch {
    return undefined;
  }
}

/** The ghx command a redirect ran, as the agent would type it (fields quoted for zsh). */
export function redirectArgv(r: ReadRedirect): string {
  const repo = r.globals.repo;
  // ghx api has no -R: the repo goes into the endpoint.
  const api = r.command[0] === 'api' && repo !== undefined;
  const slug = repo?.split('/').slice(-2).join('/') ?? '';
  const parts = ['ghx', ...r.command, ...r.args.map((a) => (api ? a.replace('{owner}/{repo}', slug) : a))];
  if (repo !== undefined && !api) parts.push('-R', repo);
  if (r.globals.fields !== undefined) parts.push('--fields', `'${r.globals.fields.join(',')}'`);
  if (r.globals.brief) parts.push('--brief');
  return parts.join(' ');
}

function note(r: ReadRedirect): Warning {
  const ran = redirectArgv(r);
  const tail = r.notes.length > 0 ? ` ${r.notes.join('; ')}.` : '';
  return {
    code: 'REDIRECTED',
    message: `'ghx ${r.from}' is not a ghx command, so this ran ${ran}; call that next time.${tail}`,
    details: {
      from: `ghx ${r.from}`,
      ran,
      ...(r.mapped !== undefined ? { fields: r.mapped } : {}),
      ...(r.notes.length > 0 ? { notes: r.notes } : {}),
    },
  };
}

/**
 * The spec, with `w` first in its output's warnings. ctx.warn is held back while it runs: the runner
 * would put those warnings in place of a `warnings` the output carries itself (pr status does). On a
 * failure they go to ctx.warn, so the error's details.warnings still name the redirect.
 */
function withNote(spec: AnyCommandSpec, w: Warning): AnyCommandSpec {
  if (spec.mode !== 'single') return spec;
  const inner = spec.run as (input: unknown, ctx: Context) => Promise<unknown>;
  return {
    ...spec,
    async run(input: unknown, ctx: Context) {
      const held: Warning[] = [];
      try {
        const out = (await inner(input, { ...ctx, warn: (x: Warning) => held.push(x) })) as Record<string, unknown>;
        const own = Array.isArray(out.warnings) ? (out.warnings as Warning[]) : [];
        return { ...out, warnings: [w, ...held, ...own] };
      } catch (e) {
        ctx.warn(w);
        for (const x of held) ctx.warn(x);
        throw e;
      }
    },
  } as AnyCommandSpec;
}
