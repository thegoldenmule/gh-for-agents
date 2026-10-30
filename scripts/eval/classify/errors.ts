// Tool-call outcomes (findings §1.5, §5): exit codes, error kinds, ghx error codes and refusals.
//
// Bash has no exit-code field: an error sets is_error and the content starts with `Exit code N`. Anything
// else with is_error is not the command failing: a hook block, a permission denial, an input validation
// error or a harness refusal, each its own error_kind (rule 7). For ghx, exits 10, 11 and 15 are outcomes
// of `ci wait`, not errors, and an error is a JSON `{"error":{"code"}}` body even when a pipe turned the
// exit into 0 (rule 8).
import { exitCodeFor, isErrorCode } from '../../../src/core/errors.ts';
import type { CommandCli } from './command.ts';

export type ErrorKind =
  /** The command ran and failed: a non-zero exit, or a ghx error body. */
  | 'command'
  /** A PreToolUse/PostToolUse hook blocked the call (the ghx hook denying raw gh, among others). */
  | 'hook_block'
  /** The permission system, auto-mode classifier or the user refused the call. */
  | 'permission_denied'
  /** The tool input failed validation (InputValidationError, missing parameter). */
  | 'input_validation'
  /** The harness refused to run it: `Blocked: sleep …`, worktree isolation, files not read first. */
  | 'harness_block'
  /** Any other is_error result without an exit code. */
  | 'tool_error';

export type Refusal = 'ghx_policy' | 'hook' | 'permission' | 'harness';

export type GhxOutcome = 'ci_red' | 'ci_red_on_main' | 'handed_back';

/**
 * Whose a failed call is (METRIC_VERSION 2.0.0). A mistake is the agent's: a usage error, an unknown command,
 * flag or field, input that fails validation (on a --dry-run too) or glue that breaks on the output. An outcome
 * is the world's: CI or PR state (`ci wait` exits 12–14, RUN_IN_PROGRESS, `gh pr checks` exit 8), GitHub, the
 * environment, a timeout or a kill. A denial is a refusal: a hook, the permission system, the harness or ghx
 * policy.
 */
export type Failure = 'mistake' | 'outcome' | 'denial';

/** ghx `ci wait` exits that report CI state rather than a failure. */
export const GHX_OUTCOME_EXITS: Readonly<Record<number, GhxOutcome>> = {
  10: 'ci_red',
  11: 'ci_red_on_main',
  15: 'handed_back',
};
export const GHX_POLICY_EXIT = 6;

export interface ResultInput {
  toolName: string;
  isError: boolean;
  /** The result text the model saw (usage.ts resultText). */
  text: string;
  /** The user record's `toolDenialKind`, when set. */
  toolDenialKind?: string | null;
  /** classifyCommand(...).cli for Bash/Monitor, else null. */
  cli: CommandCli | null;
  /** A background call: its exit comes from the task notification. */
  background?: boolean;
  notifExit?: number | null;
  /** `<cli> <subcommand>` of each gh/ghx invocation (classifyCommand), for gh's own state exits. */
  subcommands?: readonly string[];
}

export interface ResultClass {
  /** From the immediate result: `Exit code N`, 0 for a clean foreground Bash call, else null. */
  exitCode: number | null;
  /** The exit judged: the notification's for a background call, else exitCode. */
  effectiveExit: number | null;
  errorKind: ErrorKind | null;
  /** The first ghx error code in the visible result (`VALIDATION`, `USAGE_UNKNOWN_COMMAND`, …). */
  ghxErrorCode: string | null;
  ghxErrorCodes: string[];
  ghxOutcome: GhxOutcome | null;
  refusal: Refusal | null;
  /** Null when errorKind is null. */
  failure: Failure | null;
  /** Why: the ghx error code, `exit:N`, an error kind, or `gh:<pattern>` / `glue:<pattern>` for text. */
  failureReason: string | null;
}

const EXIT = /^Exit code (\d+)/;
const GHX_ERROR = /"error"\s*:\s*\{\s*"code"\s*:\s*"([A-Z_]+)"/g;
const HOOK =
  /^(?:Pre|Post)ToolUse:\S+ hook (?:error|blocked)|\b(?:blocked|denied) by (?:a |the )?(?:PreToolUse )?hook\b/;
const PERMISSION_KINDS = new Set(['automode-blocked', 'automode-unavailable', 'user-rejected']);
const PERMISSION =
  /^Permission (?:to use \S+ (?:with command [\s\S]*)?has been denied|for this (?:action|tool use) was denied)|The user doesn't want to proceed with this tool use|auto mode classifier/;
const VALIDATION = /InputValidationError|Missing required parameter|An unexpected parameter|Invalid tool parameters/;
const HARNESS =
  /^<tool_use_error>Blocked:|^This agent is isolated in the worktree|<tool_use_error>File has not been read yet|<tool_use_error>File has been modified since read/;

/** Why a non-exit-code error happened, from toolDenialKind first, then the text. */
export function nonExitErrorKind(text: string, toolDenialKind?: string | null): ErrorKind {
  if (HOOK.test(text)) return 'hook_block';
  if ((toolDenialKind && PERMISSION_KINDS.has(toolDenialKind)) || PERMISSION.test(text)) return 'permission_denied';
  if (toolDenialKind === 'permission-rule') return 'permission_denied';
  if (VALIDATION.test(text)) return 'input_validation';
  if (HARNESS.test(text)) return 'harness_block';
  return 'tool_error';
}

export function ghxErrorCodes(text: string): string[] {
  return [...new Set([...text.matchAll(GHX_ERROR)].map((m) => m[1] as string))];
}

/** The failure class of a ghx exit code (02 §6.1): usage and not-found are mistakes, policy is a denial. */
export function exitFailure(exit: number): Failure {
  if (exit === 2 || exit === 5) return 'mistake';
  if (exit === 6) return 'denial';
  return 'outcome';
}

/** The failure class of a ghx error code through its exit class, or null for a code ghx no longer has. */
export function ghxCodeFailure(code: string): Failure | null {
  if (!isErrorCode(code)) return null;
  // Its exit class depends on details; every blocker is the PR's state or its rules, not the agent.
  if (code === 'MERGE_BLOCKED') return 'outcome';
  return exitFailure(exitCodeFor(code));
}

/**
 * gh's and the shell's own messages for a command the agent got wrong, by reason. Anchored to their shapes
 * (line starts, gh's `(HTTP 404)` suffix) because a result also holds whatever the command printed: CI logs
 * say "not found" and "error" all the time.
 */
const MISTAKE_TEXT: readonly (readonly [string, RegExp])[] = [
  ['gh:unknown_command', /^unknown command "/m],
  ['gh:unknown_flag', /^unknown (?:shorthand )?flag:/m],
  [
    'gh:bad_args',
    /^(?:accepts|requires) .*\bargs?\b|^flag needs an argument|^required flag|^invalid argument "|^if any flags in the group|^specify only one of|^cannot use `?--/m,
  ],
  ['gh:unknown_field', /^Unknown JSON field: |Field '[^']+' doesn't exist on type/m],
  [
    'gh:not_found',
    /GraphQL: Could not resolve to a |\(HTTP 404\)|^no (?:open )?pull requests? found for branch|^could not find pull request/m,
  ],
  ['gh:invalid', /\(HTTP 422\)|^HTTP 422: /m],
  ['gh:no_repo', /^(?:failed to run git: )?fatal: not a git repository/m],
  ['glue:jq', /^failed to parse jq expression|^jq: (?:error|\S+ compile error)/m],
  ['glue:python', /^Traceback \(most recent call last\)/m],
  [
    'glue:shell',
    /^\((?:eval)\):\d+: |^(?:zsh|bash|sh): (?:\d+: )?.*(?:command not found|no matches found|parse error|syntax error)/m,
  ],
];
/** gh's messages for the world's state: the PR or run is not in a state the command needs, or GitHub failed. */
const OUTCOME_TEXT: readonly (readonly [string, RegExp])[] = [
  [
    'gh:state',
    /\bis not mergeable\b|\balready (?:been )?merged\b|^no checks reported\b|\bcannot be rerun\b|\bcannot be retried\b|\(HTTP 409\)|^Base branch was modified/m,
  ],
  ['gh:github', /\(HTTP 5\d\d\)|^HTTP 5\d\d|\bAPI rate limit exceeded\b|^error connecting to |\bi\/o timeout\b/m],
];
/** gh subcommands whose non-zero exit reports CI state: checks failed (1) or pending (8), a watched run failed. */
const GH_STATE_SUBCOMMANDS = new Set(['gh pr checks', 'gh run watch']);
/** Exits that mean the command was killed or timed out (signals, `timeout`, the Bash tool's limit). */
const KILLED_EXITS = new Set([124, 130, 137, 143, 144]);

function textFailure(text: string): { failure: Failure; reason: string } | null {
  for (const [reason, re] of MISTAKE_TEXT) if (re.test(text)) return { failure: 'mistake', reason };
  for (const [reason, re] of OUTCOME_TEXT) if (re.test(text)) return { failure: 'outcome', reason };
  return null;
}

/** Whose failure a failed call is; only called with a non-null error kind. */
function failureOf(
  r: ResultInput,
  out: Omit<ResultClass, 'failure' | 'failureReason'>,
): { failure: Failure; reason: string } {
  const kind = out.errorKind as ErrorKind;
  if (kind === 'hook_block' || kind === 'permission_denied' || kind === 'harness_block') {
    return { failure: 'denial', reason: kind };
  }
  if (kind === 'input_validation') return { failure: 'mistake', reason: kind };
  if (kind === 'tool_error') return textFailure(r.text) ?? { failure: 'outcome', reason: kind };
  const exit = out.effectiveExit;
  if (out.ghxErrorCode !== null) {
    const f = ghxCodeFailure(out.ghxErrorCode) ?? (exit !== null && exit !== 0 ? exitFailure(exit) : 'mistake');
    return { failure: f, reason: out.ghxErrorCode };
  }
  if (exit !== null && KILLED_EXITS.has(exit)) return { failure: 'outcome', reason: `exit:${exit}` };
  const text = textFailure(r.text);
  if (text?.failure === 'mistake') return text;
  if (exit !== null && (r.subcommands ?? []).some((s) => GH_STATE_SUBCOMMANDS.has(s)) && (exit === 1 || exit === 8)) {
    return { failure: 'outcome', reason: `exit:${exit}` };
  }
  if (text) return text;
  if (r.cli === 'ghx' && exit !== null) return { failure: exitFailure(exit), reason: `exit:${exit}` };
  // No error anyone can name: most often a compound command whose last stage (grep, a loop's test) exited
  // non-zero after the gh call worked. Not counted as the agent's mistake.
  return { failure: 'outcome', reason: exit === null ? 'unknown' : `exit:${exit}` };
}

export function classifyResult(r: ResultInput): ResultClass {
  const out = classifyExit(r);
  if (out.errorKind === null) return { ...out, failure: null, failureReason: null };
  const f = failureOf(r, out);
  return { ...out, failure: f.failure, failureReason: f.reason };
}

function classifyExit(r: ResultInput): Omit<ResultClass, 'failure' | 'failureReason'> {
  const m = r.isError ? EXIT.exec(r.text) : null;
  const exitCode = m ? Number(m[1]) : !r.isError && r.toolName === 'Bash' && !r.background ? 0 : null;
  const effectiveExit = r.background ? (r.notifExit ?? null) : exitCode;
  const out: Omit<ResultClass, 'failure' | 'failureReason'> = {
    exitCode,
    effectiveExit,
    errorKind: null,
    ghxErrorCode: null,
    ghxErrorCodes: [],
    ghxOutcome: null,
    refusal: null,
  };
  if (r.isError && !m) {
    out.errorKind = nonExitErrorKind(r.text, r.toolDenialKind);
    out.refusal =
      out.errorKind === 'hook_block'
        ? 'hook'
        : out.errorKind === 'permission_denied'
          ? 'permission'
          : out.errorKind === 'harness_block'
            ? 'harness'
            : null;
    return out;
  }
  const ghx = r.cli === 'ghx' || r.cli === 'mixed';
  if (ghx) {
    out.ghxErrorCodes = ghxErrorCodes(r.text);
    out.ghxErrorCode = out.ghxErrorCodes[0] ?? null;
    if (effectiveExit === GHX_POLICY_EXIT) out.refusal = 'ghx_policy';
    if (out.ghxErrorCode !== null) {
      out.errorKind = 'command';
      return out;
    }
    const outcome = effectiveExit === null ? undefined : GHX_OUTCOME_EXITS[effectiveExit];
    if (outcome && r.cli === 'ghx') {
      out.ghxOutcome = outcome;
      return out;
    }
  }
  if (effectiveExit !== null && effectiveExit !== 0) out.errorKind = 'command';
  return out;
}
