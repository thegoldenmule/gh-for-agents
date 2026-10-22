// --override CODE --reason "…" for the CI write commands (02 §13): `ci rerun` overrides RERUN_LIMIT and
// `ci retrigger` overrides AUTHOR_NOT_VIEWER. The rules match the merge overrides (src/policy/overrides.ts),
// which accept only merge-check codes: each command names its own overridable codes, and an override needs
// a one-line reason of at most MAX_REASON_CHARS. Anything else is VALIDATION.
import { GhxError } from '../../core/errors.ts';
import { MAX_REASON_CHARS } from '../../policy/overrides.ts';

export interface CommandOverrides<C extends string> {
  codes: C[];
  reason: string;
}

interface Issue {
  path: string;
  code: string;
  message: string;
}

/** Validate the flags against `allowed`. No codes gives null; `--reason` alone is ignored. */
export function parseCommandOverrides<C extends string>(
  codes: readonly string[] | undefined,
  reason: string | null | undefined,
  allowed: readonly C[],
): CommandOverrides<C> | null {
  const list = [
    ...new Set(
      (codes ?? [])
        .flatMap((c) => c.split(','))
        .map((c) => c.trim())
        .filter((c) => c !== ''),
    ),
  ];
  if (list.length === 0) return null;
  const issues: Issue[] = [];
  for (const code of list) {
    if (!(allowed as readonly string[]).includes(code)) {
      issues.push({ path: 'override', code: 'override.unknown', message: `'${code}' cannot be overridden here` });
    }
  }
  const r = reason?.trim() ?? '';
  if (r === '') {
    issues.push({
      path: 'reason',
      code: 'override.reason_required',
      message: '--override needs --reason "<who asked and why>"',
    });
  } else if (r.length > MAX_REASON_CHARS || /[\r\n]/.test(r)) {
    issues.push({
      path: 'reason',
      code: 'override.reason_too_long',
      message: `--reason must be one line of at most ${MAX_REASON_CHARS} chars (got ${r.length})`,
    });
  }
  if (issues.length > 0) {
    throw new GhxError(
      'VALIDATION',
      issues.length === 1 ? (issues[0] as Issue).message : `${issues.length} override issues.`,
      {
        hint: `Overridable codes: ${allowed.join(', ')}. Override only what the user explicitly accepted.`,
        details: { issues },
      },
    );
  }
  return { codes: list as C[], reason: r };
}

/** HEAD_MOVED (9) unless the head starts with `expected` (7–40 hex chars). */
export function assertExpectHead(ref: string, head: string, expected: string | undefined): void {
  if (expected === undefined || head.startsWith(expected)) return;
  throw new GhxError('HEAD_MOVED', `Head is ${head.slice(0, 7)}, expected ${expected.slice(0, 7)}.`, {
    hint: `Re-check the new head: ghx pr status ${ref}, then retry with --expect-head ${head.slice(0, 7)}.`,
    details: { expected, actual: head },
  });
}
