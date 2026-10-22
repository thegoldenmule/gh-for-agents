// --override CODE[,CODE…] --reason "…" (02 §8.1 step 5; 03 §5.1 overrides.test.ts). An override must name
// an overridable merge check and carry a one-line reason of at most 200 chars; anything else is VALIDATION.
// Whether the overridden check actually failed is only known after evaluation: an unused one warns
// OVERRIDE_UNUSED there (merge.ts).
import { GhxError } from '../core/errors.ts';
import { checkSpec, type MergeCheckCode, OVERRIDABLE_CODES } from './checks.ts';

export const MAX_REASON_CHARS = 200;

export interface Overrides {
  codes: MergeCheckCode[];
  reason: string;
}

interface Issue {
  path: string;
  code: string;
  message: string;
}

/** Validate the flags. No codes gives null; `--reason` alone is ignored. */
export function parseOverrides(codes: readonly string[], reason: string | null | undefined): Overrides | null {
  const list = [
    ...new Set(
      codes
        .flatMap((c) => c.split(','))
        .map((c) => c.trim())
        .filter((c) => c !== ''),
    ),
  ];
  if (list.length === 0) return null;
  const issues: Issue[] = [];
  for (const code of list) {
    const spec = checkSpec(code);
    if (!spec) {
      issues.push({ path: 'override', code: 'override.unknown', message: `'${code}' is not a merge check code` });
    } else if (!spec.overridable) {
      issues.push({ path: 'override', code: 'override.not_overridable', message: `${code} cannot be overridden` });
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
        hint: `Overridable codes: ${OVERRIDABLE_CODES.join(', ')}. Override only what the user explicitly accepted.`,
        details: { issues },
      },
    );
  }
  return { codes: list as MergeCheckCode[], reason: r };
}
