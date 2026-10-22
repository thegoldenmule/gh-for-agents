// pytest: `FAILED path::Class::test[param] - AssertionError: …` in the short test summary, `E   …`
// detail lines, and `=== 1 failed, 2 passed in 0.12s ===`. When a short test summary exists, only
// lines after the last one are read: pytest's own tests print nested pytest output that also
// contains FAILED lines. An id may contain spaces (`test_p[hello world]`); it ends at ` - ` or the line end.
import type { Extraction, Extractor } from './types.ts';

const SHORT = /^=+ short test summary info =+$/;
const FAILED = /^FAILED (.+?)(?: - (.*))?$/;
const ERROR = /^ERROR (.+?)(?: - (.*))?$/;
const DETAIL = /^E {2,}(\S.*)$/;
const SUMMARY = /^=+ .*\b\d+ (?:failed|passed|errors?)\b.* in [\d.]+s\b.*=+$/;
const SESSION = /^=+ test session starts =+$/;

export const pytest: Extractor = {
  name: 'pytest',
  detect: (lines) => lines.some((l) => SESSION.test(l) || SHORT.test(l) || SUMMARY.test(l)),
  extract(lines): Extraction {
    const tests: string[] = [];
    const errors: string[] = [];
    let firstLine: number | null = null;
    let from = 0;
    lines.forEach((l, i) => {
      if (SHORT.test(l)) from = i + 1;
    });
    for (let i = from; i < lines.length; i++) {
      const l = lines[i] ?? '';
      const f = FAILED.exec(l);
      const e = f ? null : ERROR.exec(l);
      if (f) {
        tests.push(f[1] ?? '');
        if (f[2]) errors.push(f[2].trim());
        firstLine ??= i;
      } else if (e) {
        errors.push(`${e[1]}${e[2] ? ` - ${e[2].trim()}` : ''}`);
        firstLine ??= i;
      }
    }
    // The `E   …` detail lines from the FAILURES section (before the short summary).
    if (errors.length === 0) {
      lines.forEach((l, i) => {
        const d = DETAIL.exec(l);
        if (d) {
          errors.push((d[1] ?? '').trim());
          firstLine ??= i;
        }
      });
    }
    return { tests, errors, firstLine };
  },
};
