// Claude Code PreToolUse rules (01 §7, 02 §11.0 "Enforcement", 03 M12.2). Pure: (event, mode) → the
// hook's stdout object, or null for no output. A `ghx ci wait` rewrite carries no permissionDecision, so
// permission rules still apply to the rewritten call (03 §3.6). Replacement argv comes from the
// passthrough refusal table; spec `replaces` entries it doesn't cover come from replaces.generated.json
// (pnpm docs:gen), so both follow the specs. No gh calls; runHook() never throws (fail open).
// A raw gh write that ghx wraps is denied in every mode, wherever -R/--repo sits (04 final review):
// permissions.deny prefix rules cannot match `gh -R o/r pr merge 1`. GHX_HOOK_MODE governs the rest.
// All of that enforcement applies only in a repo with .github/ghx.json (04 "enforcement scope"); elsewhere
// the hook only moves `ghx ci wait` to the background. A gh call that names another repo (-R, a URL, a
// literal gh api repos/o/r path) is judged by that repo, not the cwd: unless it is one of the checkout's
// own remotes, it is out of scope too (src/hook/foreign.ts).
import type { Clock } from '../core/clock.ts';
import { decide, firstPositional, normalizeGhArgv, takeRepoFlag, WRAPPED_WRITES } from '../passthrough/policy.ts';
import { isForeign, localRepoSlugs } from './foreign.ts';
import { logHookEvent } from './log.ts';
import REPLACES from './replaces.generated.json' with { type: 'json' };
import { ghxConfigured } from './repo.ts';
import { type Invocation, isCiWait, isGh, isGhx, scanShell, startsWithCiWait } from './shell.ts';

export type HookMode = 'ask' | 'deny' | 'off';

export interface HookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    updatedInput?: Record<string, unknown>;
    permissionDecision?: 'ask' | 'deny';
    permissionDecisionReason?: string;
  };
}

export interface ReplacesEntry {
  /** A raw gh invocation from a spec's `replaces`, e.g. 'gh run view --log'. */
  pattern: string;
  /** The ghx command that replaces it, e.g. 'ci why'. */
  command: string;
}

export const REPLACES_TABLE: readonly ReplacesEntry[] = REPLACES;

export function hookMode(env: Readonly<Record<string, string | undefined>>): HookMode {
  const v = env.GHX_HOOK_MODE?.trim().toLowerCase();
  return v === 'off' || v === 'ask' ? v : 'deny';
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const PR_SELECTOR = /^(#?\d+|[\w.-]+\/[\w.-]+#\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\S*)$/;

/** Flags whose value is a separate word, for picking positionals out of a gh argv. */
const VALUE_FLAGS = new Set([
  '-X',
  '--method',
  '--json',
  '-q',
  '--jq',
  '-H',
  '--header',
  '-t',
  '--template',
  '-R',
  '--repo',
]);

/** A gh invocation with -R/--repo moved behind the command words, so argv[1] and argv[2] are the verb. */
function normalized(inv: Invocation): Invocation {
  return isGh(inv) ? { ...inv, argv: [inv.argv[0] as string, ...normalizeGhArgv(inv.argv.slice(1))] } : inv;
}

/** gh invocations that read CI state, i.e. what a polling loop polls. */
function pollsCi(inv: Invocation): boolean {
  const [, group, verb] = inv.argv;
  if (isGhx(inv)) return (group === 'ci' && verb === 'wait') || (group === 'pr' && verb === 'status');
  if (!isGh(inv)) return false;
  if (group === 'pr') return verb === 'checks' || verb === 'view';
  if (group === 'run') return verb === 'watch' || verb === 'list' || verb === 'view' || verb === 'ls';
  if (group === 'api') {
    const endpoint = positionals(inv.argv.slice(2))[0] ?? '';
    return /check-runs|check-suites|\/status(es)?\b|actions\/runs|actions\/jobs/.test(endpoint);
  }
  return false;
}

function positionals(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i] as string;
    if (t.startsWith('-')) {
      if (!t.includes('=') && VALUE_FLAGS.has(t)) i++;
      continue;
    }
    out.push(t);
  }
  return out;
}

/** `ghx ci wait <pr> [-R repo]` from the first PR selector in the polled commands, else `<pr>`. */
function ciWaitCommand(polls: readonly Invocation[]): string {
  for (const inv of polls) {
    const { rest, repo } = takeRepoFlag(inv.argv.slice(3));
    const sel = firstPositional(rest);
    const isPrCommand = inv.argv[1] === 'pr' || isCiWait(inv);
    const runId = inv.argv[1] === 'run' && sel !== undefined && /^\d+$/.test(sel) ? `run:${sel}` : undefined;
    const target = isPrCommand && sel !== undefined && PR_SELECTOR.test(sel) ? sel : runId;
    if (target !== undefined)
      return ['ghx', 'ci', 'wait', target, ...(repo !== undefined ? ['-R', repo] : [])].join(' ');
  }
  return 'ghx ci wait <pr>';
}

const loopReason = (cmd: string): string =>
  `Don't poll CI. Run \`${cmd}\` with the Bash tool and run_in_background: true, then continue other work or end your turn. You are re-invoked when it exits; its stdout is one JSON summary with the diagnosis, and its exit code is the outcome.`;

/** Does a raw invocation match a spec `replaces` pattern? Placeholders ({x}, <x>) match one path segment. */
export function matchesPattern(pattern: string, argv: readonly string[]): boolean {
  const p = pattern.trim().split(/\s+/);
  if (p[0] !== 'gh' || base0(argv) !== 'gh') return false;
  const patArgs = p.slice(1);
  const args = argv.slice(1);
  const patPos = positionals(patArgs);
  const argPos = positionals(args).map((a) => a.replace(/^\//, ''));
  if (patPos.length > argPos.length) return false;
  for (const [i, tok] of patPos.entries()) {
    if (!segmentRegex(tok).test(argPos[i] as string)) return false;
  }
  for (let i = 0; i < patArgs.length; i++) {
    const f = patArgs[i] as string;
    if (!f.startsWith('-')) continue;
    const value = VALUE_FLAGS.has(f) ? patArgs[i + 1] : undefined;
    if (value !== undefined) i++;
    const hit = args.some((a, k) => {
      if (value === undefined) return a === f || a.startsWith(`${f}=`);
      return (a === f && args[k + 1]?.toUpperCase() === value.toUpperCase()) || a === `${f}=${value}`;
    });
    if (!hit) return false;
  }
  return true;
}

function base0(argv: readonly string[]): string {
  const h = argv[0] ?? '';
  return h.slice(h.lastIndexOf('/') + 1);
}

function segmentRegex(tok: string): RegExp {
  const src = tok
    .split(/(\{[^}]*\}|<[^>]*>)/)
    .map((part, i) => (i % 2 === 1 ? '[^/\\s]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${src}$`);
}

/** A bare `gh <group> <verb>` entry (gh run list) is an allowlisted read; it only counts inside a loop. */
function isBare(pattern: string): boolean {
  return /^gh [a-z-]+ [a-z-]+$/.test(pattern.trim());
}

/** The nudge for one gh invocation outside a loop, or undefined. */
function replacementReason(inv: Invocation): string | undefined {
  const raw = inv.argv.slice(1);
  const d = decide(raw);
  const shown = `gh ${raw.join(' ')}`.trim();
  if (d.kind === 'refuse' && d.error.code === 'USAGE_UNKNOWN_COMMAND' && isObject(d.error.details)) {
    const suggestion = d.error.details.suggestion;
    if (Array.isArray(suggestion)) {
      return `ghx replaces \`${shown}\`. ${d.error.hint ?? `Use: ${suggestion.join(' ')}.`}`;
    }
  }
  for (const e of REPLACES_TABLE) {
    if (e.pattern.includes('&&')) continue;
    if (isBare(e.pattern) && d.kind === 'run') continue;
    if (matchesPattern(e.pattern, inv.argv)) {
      return `ghx replaces \`${shown}\`: use \`ghx ${e.command}\` (it replaces \`${e.pattern}\`; ghx ${e.command} --help lists its arguments).`;
    }
  }
  return undefined;
}

/** Is it a raw gh write that ghx wraps: a wrapped verb (pr merge, …) or a gh api write to a wrapped endpoint? */
function isWrappedWrite(inv: Invocation): boolean {
  const raw = inv.argv.slice(1);
  const d = decide(raw);
  if (d.kind !== 'refuse') return false;
  if (d.wrapped !== undefined) return WRAPPED_WRITES.has(d.wrapped);
  return (
    d.error.code === 'PASSTHROUGH_WRITE_REFUSED' &&
    raw[0] === 'api' &&
    REPLACES_TABLE.some((e) => !e.pattern.includes('&&') && matchesPattern(e.pattern, inv.argv))
  );
}

const WRITE_DENIED =
  ' Raw gh writes that ghx wraps are always denied: the ghx command checks policy, validates input and pins the head SHA (or the run, for run:<id>).';

/** Compound `replaces` entries (gh pr close <n> && gh pr reopen <n>): every part matches some invocation. */
function compoundReason(gh: readonly Invocation[]): string | undefined {
  for (const e of REPLACES_TABLE) {
    if (!e.pattern.includes('&&')) continue;
    const parts = e.pattern.split('&&').map((s) => s.trim());
    if (parts.every((part) => gh.some((inv) => matchesPattern(part, inv.argv)))) {
      return `ghx replaces \`${e.pattern}\`: use \`ghx ${e.command} <pr>\` (ghx ${e.command} --help lists its arguments).`;
    }
  }
  return undefined;
}

function nudge(mode: 'ask' | 'deny', reason: string): HookOutput {
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: mode, permissionDecisionReason: reason },
  };
}

/** Which branch of decideHook produced the reply; null when there is none. Recorded in GHX_HOOK_LOG. */
export type HookRule =
  | 'wrapped-write'
  | 'ci-wait-background'
  | 'monitor-ci-wait'
  | 'poll-loop'
  | 'compound-replaces'
  | 'replaces';

export interface HookDecision {
  out: HookOutput | null;
  rule: HookRule | null;
}

const none: HookDecision = { out: null, rule: null };
const background = (input: Record<string, unknown>): HookDecision => ({
  out: { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input, run_in_background: true } } },
  rule: 'ci-wait-background',
});

export interface HookOptions {
  /**
   * Is a repo a gh invocation names explicitly (-R, a URL, `gh api repos/o/r/…`; lowercase owner/name)
   * this checkout's own? A named repo that is not is foreign: enforcement skips it (src/hook/foreign.ts).
   * Default: every named repo is this one.
   */
  sameRepo?: (slug: string) => boolean;
}

/**
 * The hook's reply to one PreToolUse event, or null for no output. `enforce` is whether the event's
 * repo opted into ghx (.github/ghx.json): without it, only the `ghx ci wait` rewrite applies.
 */
export function decideHook(event: unknown, mode: HookMode, enforce = true, opts: HookOptions = {}): HookOutput | null {
  return decideHookRule(event, mode, enforce, opts).out;
}

/** decideHook plus the rule that fired. */
export function decideHookRule(event: unknown, mode: HookMode, enforce = true, opts: HookOptions = {}): HookDecision {
  if (!isObject(event)) return none;
  const tool = event.tool_name;
  const input = event.tool_input;
  if ((tool !== 'Bash' && tool !== 'Monitor') || !isObject(input)) return none;
  const command = input.command;
  if (typeof command !== 'string') return none;

  if (!enforce) {
    if (mode === 'off' || tool !== 'Bash' || !startsWithCiWait(command) || input.run_in_background === true)
      return none;
    return background(input);
  }

  const scan = scanShell(command);
  // A gh call aimed at another repo is judged by that repo, which never opted into ghx here.
  const sameRepo = opts.sameRepo ?? (() => true);
  const invocations = scan.invocations.map(normalized).filter((inv) => !isGh(inv) || !isForeign(inv, sameRepo));
  const gh = invocations.filter(isGh);
  const compound = compoundReason(gh);
  // Wrapped writes first and in every mode, so neither the rewrite nor GHX_HOOK_MODE=off lets one through.
  const write = gh.find(isWrappedWrite);
  if (write)
    return {
      out: nudge('deny', `${compound ?? replacementReason(write) ?? ''}${WRITE_DENIED}`.trim()),
      rule: 'wrapped-write',
    };
  if (mode === 'off') return none;

  if (tool === 'Bash' && startsWithCiWait(command) && input.run_in_background !== true) return background(input);

  const waits = invocations.filter(isCiWait);
  if (tool === 'Monitor' && waits.length > 0) {
    return {
      out: nudge(
        mode,
        `Don't run ghx ci wait under Monitor. Run \`${ciWaitCommand(waits)}\` with the Bash tool and run_in_background: true; you are re-invoked once when it exits, with one JSON summary.`,
      ),
      rule: 'monitor-ci-wait',
    };
  }

  const polls = invocations.filter(pollsCi);
  if (polls.length > 0 && (scan.loop || scan.sleep))
    return { out: nudge(mode, loopReason(ciWaitCommand(polls))), rule: 'poll-loop' };

  if (compound) return { out: nudge(mode, compound), rule: 'compound-replaces' };
  for (const inv of gh) {
    const reason = replacementReason(inv);
    if (reason) return { out: nudge(mode, reason), rule: 'replaces' };
  }
  return none;
}

/**
 * The protocol entry point: raw stdin in, raw stdout out (or null). Never throws. With GHX_HOOK_LOG set,
 * each Bash or Monitor command is also appended to that file (src/hook/log.ts); a failed write is
 * swallowed there and never changes the reply.
 */
export function runHook(stdin: string, env: Readonly<Record<string, string | undefined>>, clock: Clock): string | null {
  try {
    const event: unknown = JSON.parse(stdin);
    const mode = hookMode(env);
    const enforce = isObject(event) && ghxConfigured(event.cwd);
    let slugs: Set<string> | undefined;
    const sameRepo = (slug: string): boolean => {
      slugs ??= localRepoSlugs(isObject(event) ? event.cwd : undefined);
      return slugs.has(slug);
    };
    const decision = decideHookRule(event, mode, enforce, { sameRepo });
    const logPath = env.GHX_HOOK_LOG;
    if (logPath) logHookEvent(logPath, event, decision, { mode, enforce, clock });
    return decision.out === null ? null : JSON.stringify(decision.out);
  } catch {
    return null;
  }
}
