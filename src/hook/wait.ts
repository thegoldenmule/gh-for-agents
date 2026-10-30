// Where a `ghx ci wait` (or `ghx pr land`, which waits the same way) runs (02 §11.0; research: subagent lifecycles). The main thread can end its turn
// and be re-invoked when a background task exits, so its waits go to the background. A subagent cannot:
// ending its turn hands back to its parent with the wait still running, which is where the relaunched
// waits, Monitor/pgrep polling and orphaned waits came from. So a subagent's wait runs in the foreground
// with --foreground, which self-returns `pending` (exit 15) within 9 minutes, under the Bash tool's
// 10-minute cap, and the call's timeout is raised to that cap; on exit 15 it re-runs the identical command.
// Pure, and kept off the ci wait driver's imports (the hook has a 100 ms budget).
import { scanShell } from './shell.ts';

/** Claude Code's Bash tool timeout cap (ms); the foreground rewrite sets the call's timeout to it. */
export const BASH_TIMEOUT_CAP_MS = 600_000;

/** The ghx commands that wait on CI and follow these rules (pr land waits until mergeable, then merges). */
export const WAIT_COMMANDS: readonly (readonly [string, string])[] = [
  ['ci', 'wait'],
  ['pr', 'land'],
];

const ENV_PREFIX = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s'"]*)\s+)*`;

/** The command starts with a wait command (after env assignments); the match ends after its verb. */
function waitPrefix(command: string): RegExpExecArray | null {
  const verbs = WAIT_COMMANDS.map(([g, v]) => `${g}\\s+${v}`).join('|');
  return new RegExp(String.raw`^\s*${ENV_PREFIX}ghx\s+(?:${verbs})(?=\s|$)`).exec(command);
}

export function startsWithWait(command: string): boolean {
  return waitPrefix(command) !== null;
}

/** The PreToolUse event comes from a subagent: Claude Code adds `agent_id` there, and only there. */
export function isSubagent(event: Record<string, unknown>): boolean {
  return typeof event.agent_id === 'string' && event.agent_id !== '';
}

/** The words of the command's first invocation (the wait itself). */
function firstArgv(command: string): readonly string[] {
  return scanShell(command).invocations[0]?.argv ?? [];
}

const has = (argv: readonly string[], flag: string) => argv.some((a) => a === flag || a.startsWith(`${flag}=`));

export type WaitRewrite =
  | { kind: 'background'; input: Record<string, unknown> }
  | { kind: 'foreground'; input: Record<string, unknown> };

/**
 * The rewrite for a Bash `ghx ci wait`, or null to leave it alone:
 * - explicit run_in_background: true, --help, -h or --schema: null (asked for; nothing waits).
 * - a subagent, or an explicit --foreground: foreground, with --foreground inserted after the verb (never as
 *   an env prefix, so a `Bash(ghx ci wait:*)` rule still matches) and the timeout raised to the cap.
 * - the main thread otherwise: run_in_background: true.
 */
export function waitRewrite(event: Record<string, unknown>, input: Record<string, unknown>): WaitRewrite | null {
  const command = input.command;
  if (typeof command !== 'string') return null;
  const m = waitPrefix(command);
  if (m === null || input.run_in_background === true) return null;
  const argv = firstArgv(command);
  if (has(argv, '--help') || argv.includes('-h') || has(argv, '--schema')) return null;
  const flagged = has(argv, '--foreground');
  if (!isSubagent(event) && !flagged) return { kind: 'background', input: { ...input, run_in_background: true } };
  const timeout = typeof input.timeout === 'number' ? input.timeout : 0;
  if (flagged && timeout >= BASH_TIMEOUT_CAP_MS) return null;
  const end = m[0].length;
  const updated = flagged ? command : `${command.slice(0, end)} --foreground${command.slice(end)}`;
  return { kind: 'foreground', input: { ...input, command: updated, timeout: BASH_TIMEOUT_CAP_MS } };
}

/** How to run `cmd` (a ghx ci wait) from here: the instruction the hook's nudges give. */
export function runWaitAdvice(cmd: string, subagent: boolean): string {
  return subagent
    ? `Run \`${cmd} --foreground\` with the Bash tool in the foreground (not run_in_background, not Monitor). It returns within 9 minutes with one JSON summary; on exit 15 re-run the identical command, which resumes. Don't hand back while a wait runs.`
    : `Run \`${cmd}\` with the Bash tool and run_in_background: true, then continue other work or end your turn. You are re-invoked when it exits; its stdout is one JSON summary with the diagnosis, and its exit code is the outcome.`;
}
