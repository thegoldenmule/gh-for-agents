// The public error catalogue (02 §6.2, 03 §1, 01 §3/§4/§5) and the error envelope.
//
// Extension point: a new public error code is ONE line appended to the matching section of
// ERROR_CODES below. Keep sections grouped by exit class. Error names are a public contract.
import type { z } from 'zod';
import { ExitCode, exitForSignal } from './exit.ts';

export type ErrorDetails = Record<string, unknown>;

export interface ErrorSpec {
  /** Exit code, or a function of `details` for codes whose class depends on the case (MERGE_BLOCKED, INTERRUPTED). */
  readonly exit: ExitCode | ((details: ErrorDetails | undefined) => ExitCode);
  /** Default hint when the thrower gives none. */
  readonly hint?: string;
}

export const ERROR_CODES = {
  // ── 1 INTERNAL ───────────────────────────────────────────────────────────
  INTERNAL: { exit: ExitCode.INTERNAL, hint: 'This is a ghx bug. Report it with the stack file in details.' },
  INTERNAL_OUTPUT_CONTRACT: {
    exit: ExitCode.INTERNAL,
    hint: 'This is a ghx bug: the command produced off-schema output.',
  },
  INTERNAL_READ_MUTATION: {
    exit: ExitCode.INTERNAL,
    hint: 'This is a ghx bug: a read command attempted a mutating gh call.',
  },

  // ── 2 USAGE ──────────────────────────────────────────────────────────────
  USAGE_UNKNOWN_COMMAND: { exit: ExitCode.USAGE, hint: 'Run ghx --help to list commands.' },
  USAGE_UNKNOWN_FLAG: { exit: ExitCode.USAGE },
  USAGE_BAD_SELECTOR: { exit: ExitCode.USAGE, hint: 'Use 3198, #3198, owner/repo#3198 or a PR URL.' },
  USAGE_INPUT_MISSING: { exit: ExitCode.USAGE },
  USAGE_INPUT_JSON: { exit: ExitCode.USAGE, hint: 'Fix the JSON; do not build it with shell interpolation.' },
  USAGE_INPUT_CONFLICT: { exit: ExitCode.USAGE },
  USAGE_REPO_MISMATCH: { exit: ExitCode.USAGE },
  USAGE_REPO_REQUIRED: { exit: ExitCode.USAGE },
  REPO_AMBIGUOUS: { exit: ExitCode.USAGE, hint: 'Pass --repo owner/name, or run: gh repo set-default' },
  VALIDATION: { exit: ExitCode.USAGE },
  META_TOO_LARGE: { exit: ExitCode.USAGE, hint: 'Shorten the body; GitHub caps bodies at 65,536 characters.' },

  // ── 3 CONFIG ─────────────────────────────────────────────────────────────
  CONFIG_MISSING: { exit: ExitCode.CONFIG, hint: 'Run: ghx init (or ghx schema config for the format).' },
  CONFIG_INVALID_JSON: { exit: ExitCode.CONFIG },
  CONFIG_INVALID: { exit: ExitCode.CONFIG },
  CONFIG_UNSUPPORTED_VERSION: { exit: ExitCode.CONFIG },
  CONFIG_EXISTS: { exit: ExitCode.CONFIG, hint: 'Pass --force to overwrite it, or edit the file.' },

  // ── 4 ENV ────────────────────────────────────────────────────────────────
  ENV_GH_MISSING: {
    exit: ExitCode.ENV,
    hint: "Install GitHub CLI and run 'gh auth login'; 'ghx doctor' checks the setup.",
  },
  ENV_GH_AUTH: { exit: ExitCode.ENV, hint: "Run 'gh auth login' (a human must do this)." },
  ENV_GIT_MISSING: { exit: ExitCode.ENV, hint: 'Install git.' },
  // ghx install from the npx cache installs ghx globally with npm first.
  ENV_NPM_MISSING: { exit: ExitCode.ENV, hint: 'Install Node.js with npm, or install ghx globally yourself.' },
  // Printed by bin/ghx.js itself, before anything else loads.
  ENV_NODE_UNSUPPORTED: {
    exit: ExitCode.ENV,
    hint: 'Install Node.js 24+ (for example with nvm or fnm) and run ghx with it.',
  },
  // ghx install / uninstall refuse to touch a local file they can't edit safely; a human fixes it.
  INSTALL_SETTINGS_INVALID: { exit: ExitCode.ENV, hint: 'Fix the settings file by hand, then run it again.' },
  INSTALL_CLAUDE_MD_INVALID: { exit: ExitCode.ENV, hint: 'Fix the ghx marker lines by hand, then run it again.' },
  INSTALL_BIN_CONFLICT: { exit: ExitCode.ENV, hint: 'Move the existing file, or pass a different --bin-dir.' },
  INSTALL_HOME_UNKNOWN: { exit: ExitCode.ENV, hint: 'Set HOME or CLAUDE_CONFIG_DIR, or use --scope project.' },
  INSTALL_GLOBAL_FAILED: {
    exit: ExitCode.ENV,
    hint: 'Read the npm output in details, fix it, and run it again; or install ghx globally yourself.',
  },
  INSTALL_NOT_WRITABLE: { exit: ExitCode.ENV, hint: 'Make the file or its directory writable, then run it again.' },

  // ── 5 NOT_FOUND ──────────────────────────────────────────────────────────
  PR_NOT_FOUND: { exit: ExitCode.NOT_FOUND },
  REPO_NOT_FOUND: { exit: ExitCode.NOT_FOUND, hint: 'Pass -R owner/repo or an owner/repo#N selector.' },
  RUN_NOT_FOUND: { exit: ExitCode.NOT_FOUND },
  ID_NOT_FOUND: { exit: ExitCode.NOT_FOUND },
  REF_NOT_FOUND: { exit: ExitCode.NOT_FOUND },

  // ── 6 POLICY ─────────────────────────────────────────────────────────────
  DUPLICATE_PR: { exit: ExitCode.POLICY },
  MERGE_BLOCKED: {
    // 6 when any blocker is policy-class, 9 when every blocker is state-class (02 §8.4).
    exit: (d) => (d?.exitClass === 'state' ? ExitCode.STATE : ExitCode.POLICY),
  },
  AUTHOR_NOT_VIEWER: { exit: ExitCode.POLICY },
  WRITER_UNTRUSTED: { exit: ExitCode.POLICY },
  RERUN_LIMIT: { exit: ExitCode.POLICY },
  METHOD_NOT_ALLOWED: { exit: ExitCode.POLICY },
  // A merge blocker (in MERGE_BLOCKED's plan): the viewer lacks write access to the base repo.
  NO_MERGE_PERMISSION: { exit: ExitCode.POLICY },
  PASSTHROUGH_WRITE_REFUSED: { exit: ExitCode.POLICY },

  // ── 7 GH_FAILED ──────────────────────────────────────────────────────────
  GH_FAILED: { exit: ExitCode.GH_FAILED },
  GH_FORBIDDEN: { exit: ExitCode.GH_FAILED },
  GH_RATE_LIMITED: { exit: ExitCode.GH_FAILED, hint: 'Retry after the reset.' },
  GH_OUTPUT_UNEXPECTED: { exit: ExitCode.GH_FAILED, hint: 'gh or the GitHub API changed shape; run ghx doctor.' },
  REOPEN_FAILED: { exit: ExitCode.GH_FAILED },
  REVIEW_REJECTED: { exit: ExitCode.GH_FAILED },
  PARTIAL_FAILURE: { exit: ExitCode.GH_FAILED },
  DIFF_TOO_LARGE: { exit: ExitCode.GH_FAILED, hint: 'Use a local diff: git diff <base>...<head>' },
  READBACK_MISMATCH: { exit: ExitCode.GH_FAILED },

  // ── 8 TIMEOUT ────────────────────────────────────────────────────────────
  TIMEOUT: { exit: ExitCode.TIMEOUT, hint: 'Re-run; if it repeats, check GitHub status.' },

  // ── 9 STATE ──────────────────────────────────────────────────────────────
  HEAD_MOVED: { exit: ExitCode.STATE },
  PR_NOT_OPEN: { exit: ExitCode.STATE },
  BRANCH_MISSING: { exit: ExitCode.STATE },
  HEAD_NOT_PUSHED: { exit: ExitCode.STATE },
  NO_COMMITS: { exit: ExitCode.STATE },
  NO_BLOCK: { exit: ExitCode.STATE },
  DESCRIPTION_DRIFT: { exit: ExitCode.STATE },
  CONCURRENT_EDIT: { exit: ExitCode.STATE, hint: 'Re-run the same command; it re-reads the PR.' },
  RUN_IN_PROGRESS: { exit: ExitCode.STATE },
  NO_FAILED_RUNS: { exit: ExitCode.STATE },
  NO_FLAKY_CANDIDATES: { exit: ExitCode.STATE },
  HEAD_BRANCH_MISSING: { exit: ExitCode.STATE },
  MERGEABLE_UNKNOWN: { exit: ExitCode.STATE },

  // ── 130 / 143 INTERRUPTED ────────────────────────────────────────────────
  INTERRUPTED: { exit: (d) => exitForSignal(typeof d?.signal === 'string' ? d.signal : undefined) },
} as const satisfies Record<string, ErrorSpec>;

export type ErrorCode = keyof typeof ERROR_CODES;

export function isErrorCode(s: string): s is ErrorCode {
  return Object.hasOwn(ERROR_CODES, s);
}

export interface GhxErrorOptions {
  hint?: string | undefined;
  details?: ErrorDetails | undefined;
  cause?: unknown;
}

export class GhxError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly details: ErrorDetails | undefined;

  constructor(code: ErrorCode, message: string, opts: GhxErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'GhxError';
    this.code = code;
    this.hint = opts.hint;
    this.details = opts.details;
  }

  get exitCode(): ExitCode {
    return exitCodeFor(this.code, this.details);
  }
}

export function isGhxError(e: unknown, code?: ErrorCode): e is GhxError {
  return e instanceof GhxError && (code === undefined || e.code === code);
}

export function exitCodeFor(code: ErrorCode, details?: ErrorDetails): ExitCode {
  const spec: ErrorSpec = ERROR_CODES[code];
  return typeof spec.exit === 'function' ? spec.exit(details) : spec.exit;
}

export interface ErrorObject {
  error: { code: string; message: string; hint: string | null; details: ErrorDetails | null };
}

/** The error envelope. All four keys are always present; empty ones are null (brief, 2026-10-22). */
export function toErrorObject(e: unknown): ErrorObject {
  if (e instanceof GhxError) {
    const spec: ErrorSpec = ERROR_CODES[e.code];
    const details = e.details && Object.keys(e.details).length > 0 ? e.details : null;
    return { error: { code: e.code, message: e.message, hint: e.hint ?? spec.hint ?? null, details } };
  }
  const message = e instanceof Error ? e.message : String(e);
  return {
    error: { code: 'INTERNAL', message: `Unexpected: ${message}`, hint: ERROR_CODES.INTERNAL.hint, details: null },
  };
}

// ── Internal gh failure codes (01 §4.3) and their public mapping (03 §1 row 9) ──

export type GhFailureCode =
  | 'GH_NOT_INSTALLED'
  | 'GH_AUTH'
  | 'GH_NOT_FOUND'
  | 'GH_FORBIDDEN'
  | 'GH_RATE_LIMITED'
  | 'GH_TRANSIENT'
  | 'GH_TOO_LARGE'
  | 'GH_IN_PROGRESS'
  | 'GH_NO_CHECKS'
  | 'GH_ALREADY'
  | 'GH_NOT_A_REPO'
  | 'GH_TIMEOUT'
  | 'GH_LOGS_NOT_READY'
  | 'GH_LOGS_GONE'
  | 'GH_FAILED';

type NotFoundCode = 'PR_NOT_FOUND' | 'RUN_NOT_FOUND' | 'REPO_NOT_FOUND' | 'REF_NOT_FOUND' | 'ID_NOT_FOUND';

/**
 * Public code for an internal gh failure. GH_NOT_FOUND maps by call site (`notFound`); the internal
 * codes callers are expected to handle themselves (in-progress, no-checks, already, logs) map to
 * GH_FAILED if they ever escape.
 */
export function publicCodeFor(code: GhFailureCode, notFound: NotFoundCode = 'REPO_NOT_FOUND'): ErrorCode {
  switch (code) {
    case 'GH_NOT_INSTALLED':
      return 'ENV_GH_MISSING';
    case 'GH_AUTH':
      return 'ENV_GH_AUTH';
    case 'GH_NOT_FOUND':
      return notFound;
    case 'GH_NOT_A_REPO':
      return 'REPO_NOT_FOUND';
    case 'GH_FORBIDDEN':
      return 'GH_FORBIDDEN';
    case 'GH_RATE_LIMITED':
      return 'GH_RATE_LIMITED';
    case 'GH_TOO_LARGE':
      return 'DIFF_TOO_LARGE';
    default:
      return 'GH_FAILED';
  }
}

// ── zod issue mapping (01 §3.3 step 5) ──

export interface IssueDetail {
  path: string;
  message: string;
  code: string;
  expected?: string;
  received?: string;
  suggestion?: string;
}

export function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out === '' ? String(seg) : `.${String(seg)}`;
  }
  return out;
}

function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let cur: unknown = input;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[seg];
  }
  return cur;
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** Keys of the object schema at `path`, unwrapping optional/default/nullable/pipe wrappers. */
export function objectKeysAt(schema: z.ZodType, path: readonly PropertyKey[]): string[] {
  let cur: unknown = schema;
  const unwrap = (s: unknown): unknown => {
    for (let i = 0; i < 20; i++) {
      const def = (s as { _zod?: { def?: Record<string, unknown> } })?._zod?.def;
      if (!def) return s;
      if (def.innerType) s = def.innerType;
      else if (def.type === 'pipe' && def.in) s = def.in;
      else return s;
    }
    return s;
  };
  for (const seg of path) {
    cur = unwrap(cur);
    const def = (cur as { _zod?: { def?: Record<string, unknown> } })?._zod?.def;
    if (!def) return [];
    if (def.type === 'object' && typeof seg === 'string') cur = (def.shape as Record<string, unknown>)[seg];
    else if (def.type === 'array') cur = def.element;
    else if (def.type === 'record') cur = def.valueType;
    else return [];
  }
  cur = unwrap(cur);
  const def = (cur as { _zod?: { def?: Record<string, unknown> } })?._zod?.def;
  return def?.type === 'object' ? Object.keys(def.shape as Record<string, unknown>) : [];
}

/**
 * Map zod issues to the public `details.issues` shape. `unrecognized_keys` becomes one issue per key,
 * each with a "did you mean" against the schema's keys at that path. `received` is derived from the
 * raw input when it is given.
 */
export function mapZodIssues(
  error: z.ZodError,
  o: { schema?: z.ZodType; input?: unknown; suggest?: (word: string, candidates: readonly string[]) => string[] } = {},
): IssueDetail[] {
  const out: IssueDetail[] = [];
  for (const issue of error.issues) {
    const path = issue.path as PropertyKey[];
    if (issue.code === 'unrecognized_keys') {
      const known = o.schema ? objectKeysAt(o.schema, path) : [];
      for (const key of issue.keys) {
        const d: IssueDetail = {
          path: formatPath([...path, key]),
          message: `unknown key '${key}'`,
          code: 'unrecognized_keys',
        };
        const s = o.suggest?.(key, known)[0];
        if (s !== undefined) d.suggestion = s;
        out.push(d);
      }
      continue;
    }
    const d: IssueDetail = { path: formatPath(path), message: issue.message, code: issue.code };
    if (issue.code === 'invalid_type') {
      d.expected = String(issue.expected);
      if (o.input !== undefined) d.received = typeName(valueAt(o.input, path));
    }
    if (issue.code === 'invalid_value' && o.suggest && o.input !== undefined) {
      const got = valueAt(o.input, path);
      const values = (issue.values as unknown[]).filter((v): v is string => typeof v === 'string');
      if (typeof got === 'string' && values.length > 0) {
        d.received = got;
        const s = o.suggest(got, values)[0];
        if (s !== undefined) d.suggestion = s;
      }
    }
    out.push(d);
  }
  return out;
}
