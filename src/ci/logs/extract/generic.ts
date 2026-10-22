// Always runs (03 M2.4): `##[error]` annotations (including `The operation was canceled.`), the exit
// line `Process completed with exit code N.`, `ERR_PNPM_*`, `AssertionError`/`Error:` lines, and the
// repo's `ci.logPatterns`.
import { ERROR_LINE, type Extraction } from './types.ts';

const ANNOTATION = /^##\[error\](.*)$/;
const EXIT = /^Process completed with exit code \d+\.?$/;
const PNPM = /\bERR_PNPM_[A-Z_]+\b/;

export interface GenericExtraction extends Extraction {
  exitLine: string | null;
}

export function compilePatterns(patterns: readonly string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p));
    } catch {
      // The config schema validates these; a bad one here is skipped, never fatal.
    }
  }
  return out;
}

export function generic(lines: readonly string[], patterns: readonly RegExp[] = []): GenericExtraction {
  const errors: string[] = [];
  let exitLine: string | null = null;
  let firstLine: number | null = null;
  lines.forEach((l, i) => {
    const a = ANNOTATION.exec(l);
    if (a) {
      const msg = (a[1] ?? '').trim();
      if (EXIT.test(msg)) exitLine = msg;
      else if (msg !== '') {
        errors.push(msg);
        firstLine ??= i;
      }
      return;
    }
    if (PNPM.test(l) || ERROR_LINE.test(l) || patterns.some((p) => p.test(l))) {
      errors.push(l.trim());
      firstLine ??= i;
    }
  });
  return { tests: [], errors, exitLine, firstLine };
}
