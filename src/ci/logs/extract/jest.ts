// jest: `FAIL path/to/a-test.js (21.5 s)`, `  ● suite › test`, `Tests:       1 failed, …`. The first
// non-empty line under a `●` header is the matcher or error message. `● Test suite failed to run`
// is a suite error, not a test.
import type { Extraction, Extractor } from './types.ts';

const BULLET = /^\s*●\s+(.+)$/;
const SUMMARY = /^\s*Tests:\s+.*\d+ failed/;
const SUITES = /^\s*Test Suites:\s+/;
const SUITE_ERROR = /^Test suite failed to run$/;
const CONSOLE = /^(?:Console|console\.\w+)$/;

export const jest: Extractor = {
  name: 'jest',
  detect: (lines) => lines.some((l) => SUMMARY.test(l) || SUITES.test(l) || (BULLET.test(l) && l.includes(' › '))),
  extract(lines): Extraction {
    const tests: string[] = [];
    const errors: string[] = [];
    let firstLine: number | null = null;
    lines.forEach((l, i) => {
      const m = BULLET.exec(l);
      if (!m) return;
      const title = (m[1] ?? '').trim();
      if (CONSOLE.test(title)) return;
      firstLine ??= i;
      const detail = lines
        .slice(i + 1, i + 8)
        .map((x) => x.trim())
        .find((x) => x !== '');
      if (SUITE_ERROR.test(title)) {
        if (detail) errors.push(detail);
        return;
      }
      tests.push(title);
      if (detail && !BULLET.test(detail)) errors.push(detail);
    });
    return { tests, errors, firstLine };
  },
};
