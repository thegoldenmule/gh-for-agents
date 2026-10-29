// Tool-call outcomes (findings §1.5, §5): exit codes, error kinds, ghx error codes and refusals.
//
// Bash has no exit-code field: an error sets is_error and the content starts with `Exit code N`. Anything
// else with is_error is not the command failing: a hook block, a permission denial, an input validation
// error or a harness refusal, each its own error_kind (rule 7). For ghx, exits 10, 11 and 15 are outcomes
// of `ci wait`, not errors, and an error is a JSON `{"error":{"code"}}` body even when a pipe turned the
// exit into 0 (rule 8).
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

export function classifyResult(r: ResultInput): ResultClass {
  const m = r.isError ? EXIT.exec(r.text) : null;
  const exitCode = m ? Number(m[1]) : !r.isError && r.toolName === 'Bash' && !r.background ? 0 : null;
  const effectiveExit = r.background ? (r.notifExit ?? null) : exitCode;
  const out: ResultClass = {
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
