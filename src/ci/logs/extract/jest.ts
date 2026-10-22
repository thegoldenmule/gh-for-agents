// jest: `FAIL path/to/a-test.js (21.5 s)`, `  ● suite › test`, `Tests:       1 failed, …`. The first
// non-empty line under a `●` header is the matcher or error message. `● Test suite failed to run`
// is a suite error, not a test. A bullet is a test only if its title has ` › ` (suite › test) or it sits under
// a `FAIL <file>` header: jest also prints `● Validation Warning:` and `● Deprecation Warning:` bullets, which
// must never become failing tests (they would fake a shared red on main).
import type { Extraction, Extractor } from './types.ts';

const BULLET = /^\s*●\s+(.+)$/;
const SUMMARY = /^\s*Tests:\s+.*\d+ failed/;
const SUITES = /^\s*Test Suites:\s+/;
const SUITE_ERROR = /^Test suite failed to run$/;
const CONSOLE = /^(?:Console|console\.\w+)$/;
const FAIL_HEADER = /^\s*FAIL\s+\S/;
const SECTION_END = /^\s*(?:PASS\s+\S|Test Suites:|Tests:)/;

export const jest: Extractor = {
  name: 'jest',
  detect: (lines) => lines.some((l) => SUMMARY.test(l) || SUITES.test(l) || (BULLET.test(l) && l.includes(' › '))),
  extract(lines): Extraction {
    const tests: string[] = [];
    const errors: string[] = [];
    let firstLine: number | null = null;
    let inFail = false;
    lines.forEach((l, i) => {
      if (FAIL_HEADER.test(l)) inFail = true;
      else if (SECTION_END.test(l)) inFail = false;
      const m = BULLET.exec(l);
      if (!m) return;
      const title = (m[1] ?? '').trim();
      if (CONSOLE.test(title)) return;
      const suiteError = SUITE_ERROR.test(title);
      if (!suiteError && !inFail && !title.includes(' › ')) return;
      firstLine ??= i;
      const detail = lines
        .slice(i + 1, i + 8)
        .map((x) => x.trim())
        .find((x) => x !== '');
      if (suiteError) {
        if (detail) errors.push(detail);
        return;
      }
      tests.push(title);
      if (detail && !BULLET.test(detail)) errors.push(detail);
    });
    return { tests, errors, firstLine };
  },
};
