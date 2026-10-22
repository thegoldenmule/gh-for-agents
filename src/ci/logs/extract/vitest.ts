// vitest: ` FAIL  [project]  path/file.test.ts[:line] > suite > test`, `   × suite > test 12ms` (also `✗`),
// `Test Files  1 failed | 3 passed (4)`, and the error line under each FAIL block. One test can print
// several FAIL blocks (one per failed snapshot); names are deduplicated.
import { ERROR_LINE, type Extraction, type Extractor, stripDuration } from './types.ts';

const FAIL = /^\s*FAIL\s+(.+)$/;
const CROSS = /^\s*[×✗]\s+(.+)$/;
const SUMMARY = /^\s*Test Files\s+\d+ failed/;
const FILE = /^(?:[\w@.~-]+\/)*[\w@.-]+\.(?:[cm]?[jt]sx?|vue|svelte|astro)(?::\d+(?::\d+)?)?$/;

/** `[project]  test/a.test.ts:18 > suite > name` → `test/a.test.ts > suite > name`. */
export function vitestFailName(rest: string): string | null {
  const parts = rest.trim().split(' > ');
  const head = (parts[0] ?? '').trim().split(/\s+/);
  const fileAt = head.findIndex((t) => FILE.test(t));
  if (fileAt === -1) return null;
  const file = (head[fileAt] ?? '').replace(/:\d+(?::\d+)?$/, '');
  const tail = parts.slice(1).map((p) => p.trim());
  // ` FAIL  src/a.test.ts [ src/a.test.ts ]` is a suite-level failure (import error etc.).
  return [file, ...tail].join(' > ').replace(/\s+\[ .* \]$/, '');
}

export const vitest: Extractor = {
  name: 'vitest',
  detect: (lines) => lines.some((l) => SUMMARY.test(l) || /\bvitest\b/.test(l) || (FAIL.test(l) && l.includes(' > '))),
  extract(lines): Extraction {
    const full: string[] = [];
    const short: string[] = [];
    const errors: string[] = [];
    let firstLine: number | null = null;
    lines.forEach((l, i) => {
      const f = FAIL.exec(l);
      if (f) {
        const name = vitestFailName(f[1] ?? '');
        if (name) {
          full.push(name);
          firstLine ??= i;
          const next = lines.slice(i + 1, i + 6).find((x) => x.trim() !== '');
          if (next && ERROR_LINE.test(next)) errors.push(next.trim());
        }
        return;
      }
      const c = CROSS.exec(l);
      if (c) {
        short.push(stripDuration(c[1] ?? ''));
        firstLine ??= i;
      }
    });
    // A test seen on both a `×` detail line and a FAIL summary line is listed once (the FAIL form).
    const tests = [...full, ...short.filter((s) => !full.some((f) => f === s || f.endsWith(` > ${s}`)))];
    return { tests, errors, firstLine };
  },
};
