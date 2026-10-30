// GHX_HOOK_LOG (07 "ghx instrumentation"): an opt-in, local, append-only NDJSON record of every Bash or
// Monitor command the PreToolUse hook sees, raw gh included, with the reply it gave. It is the one place
// that sees both eval arms with a session id and a tool_use_id; src/hook/join.ts joins it to GHX_LOG.
// Off unless the env var is set. Logging never changes the reply: every failure is swallowed here.
import { appendFileSync } from 'node:fs';
import { type Clock, isoNow } from '../core/clock.ts';
import type { HookDecision, HookMode, HookRule } from './rules.ts';

/**
 * One line per Bash or Monitor event with a string `command`. Optional fields are copied from the
 * PreToolUse event only when it has them as strings.
 *
 * `decision` is what Claude Code does with the reply: `allow` (no output), `rewrite` (updatedInput
 * only), `ask` or `deny` (permissionDecision). `rule` names the branch: `wrapped-write` is the
 * always-denied raw gh write; `ci-wait-background` and `ci-wait-foreground` (a subagent's, or
 * an explicit --foreground) are the rewrites; `monitor-ci-wait`, `poll-loop`,
 * `compound-replaces` and `replaces` are the nudges toward ghx, delivered as `ask` or `deny` by `mode`.
 */
export interface HookLogLine {
  v: 1;
  /** When the hook ran (ISO-8601). Always before the command itself starts. */
  ts: string;
  session_id: string | null;
  tool_use_id: string | null;
  transcript_path?: string;
  agent_id?: string;
  agent_type?: string;
  permission_mode?: string;
  cwd: string | null;
  tool: 'Bash' | 'Monitor';
  command: string;
  run_in_background: boolean;
  /** The event's repo has .github/ghx.json, so the hook enforced more than the ci wait rewrite. */
  enforce: boolean;
  mode: HookMode;
  decision: 'allow' | 'rewrite' | 'ask' | 'deny';
  rule: HookRule | null;
  /** permissionDecisionReason, when there is one. */
  reason?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export function hookLogLine(
  event: unknown,
  d: HookDecision,
  o: { mode: HookMode; enforce: boolean; clock: Clock },
): HookLogLine | null {
  if (typeof event !== 'object' || event === null) return null;
  const ev = event as Record<string, unknown>;
  const tool = ev.tool_name;
  const input = ev.tool_input as Record<string, unknown> | undefined;
  if ((tool !== 'Bash' && tool !== 'Monitor') || typeof input !== 'object' || input === null) return null;
  const command = input.command;
  if (typeof command !== 'string') return null;
  const reply = d.out?.hookSpecificOutput;
  const line: HookLogLine = {
    v: 1,
    ts: isoNow(o.clock),
    session_id: str(ev.session_id) ?? null,
    tool_use_id: str(ev.tool_use_id) ?? null,
    cwd: str(ev.cwd) ?? null,
    tool,
    command,
    run_in_background: input.run_in_background === true,
    enforce: o.enforce,
    mode: o.mode,
    decision: reply?.permissionDecision ?? (reply?.updatedInput ? 'rewrite' : 'allow'),
    rule: d.rule,
  };
  for (const k of ['transcript_path', 'agent_id', 'agent_type', 'permission_mode'] as const) {
    const v = str(ev[k]);
    if (v !== undefined) line[k] = v;
  }
  if (reply?.permissionDecisionReason !== undefined) line.reason = reply.permissionDecisionReason;
  return line;
}

/** Append one line for this event, or nothing. Never throws. One appendFileSync per line keeps
 * concurrent hook processes (parallel subagents) from interleaving within a line. */
export function logHookEvent(
  path: string,
  event: unknown,
  d: HookDecision,
  o: { mode: HookMode; enforce: boolean; clock: Clock },
): void {
  try {
    const line = hookLogLine(event, d, o);
    if (line !== null) appendFileSync(path, `${JSON.stringify(line)}\n`);
  } catch {
    // Instrumentation is best effort: the hook's reply never depends on it.
  }
}
