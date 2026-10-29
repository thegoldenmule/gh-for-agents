// Joins GHX_LOG to GHX_HOOK_LOG (07 M5): which tool_use ran each ghx invocation. Pure, for scripts/eval.
// The hook has session_id + tool_use_id + the command; ghx has its argv + CLAUDE_CODE_SESSION_ID but no
// tool_use_id. An invocation joins the nearest preceding (hook.ts <= inv.ts) hook line that
//   - shares its session_id when both have one, else its cwd (weaker: `cd x && ghx …` runs elsewhere);
//   - was not denied (an `ask` may have run);
//   - has an unused ghx call in its command (scanShell) with exactly the invocation's argv. Each ghx
//     call is one slot, so `ghx pr status 1 && ghx ci why 1` joins two invocations.
// Shell-expanded arguments (`ghx pr status $PR`) don't match their literal text and stay unjoined.
import type { InvocationLogLine } from '../proc/invocation-log.ts';
import type { HookLogLine } from './log.ts';
import { isGhx, scanShell } from './shell.ts';

export interface JoinedInvocation {
  invocation: InvocationLogLine;
  /** The hook line for the tool_use that ran it, or null. */
  hook: HookLogLine | null;
  tool_use_id: string | null;
  /** Which key matched: session_id, the cwd fallback, or nothing. */
  by: 'session_id' | 'cwd' | null;
}

/** The argument lists of every ghx call in a shell command. */
export function ghxCalls(command: string): string[][] {
  const out: string[][] = [];
  for (const inv of scanShell(command).invocations) {
    if (isGhx(inv)) out.push(inv.argv.slice(1));
    else if (/(^|\/)node$/.test(inv.argv[0] ?? '') && /(^|\/)bin\/ghx\.js$/.test(inv.argv[1] ?? ''))
      out.push(inv.argv.slice(2));
  }
  return out;
}

const sameArgv = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((t, i) => t === b[i]);

export function joinInvocations(
  hooks: readonly HookLogLine[],
  invocations: readonly InvocationLogLine[],
): JoinedInvocation[] {
  const slots = hooks.map((h) => ({
    hook: h,
    at: Date.parse(h.ts),
    calls: h.decision === 'deny' ? [] : ghxCalls(h.command),
    used: new Set<number>(),
  }));
  const order = invocations
    .map((inv, i) => ({ inv, i, at: Date.parse(inv.ts) }))
    .sort((a, b) => a.at - b.at || a.i - b.i);
  const out: JoinedInvocation[] = new Array(invocations.length);
  for (const { inv, i, at } of order) {
    let best: { slot: (typeof slots)[number]; k: number; by: 'session_id' | 'cwd' } | undefined;
    for (const slot of slots) {
      const h = slot.hook;
      const by = inv.session_id !== null && h.session_id !== null ? 'session_id' : 'cwd';
      if (by === 'session_id' ? h.session_id !== inv.session_id : h.cwd !== inv.cwd) continue;
      if (slot.at > at || (best && slot.at < best.slot.at)) continue;
      const k = slot.calls.findIndex((argv, n) => !slot.used.has(n) && sameArgv(argv, inv.argv));
      if (k !== -1) best = { slot, k, by };
    }
    if (best) best.slot.used.add(best.k);
    out[i] = {
      invocation: inv,
      hook: best?.slot.hook ?? null,
      tool_use_id: best?.slot.hook.tool_use_id ?? null,
      by: best?.by ?? null,
    };
  }
  return out;
}
