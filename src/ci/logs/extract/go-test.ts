// go test: `--- FAIL: TestX (0.00s)` with indented subtests `--- FAIL: TestX/sub (0.01s)`,
// `    x_test.go:12: message` lines, `panic:` and `FAIL\tpkg\t1.2s`. A parent whose subtest failed is
// dropped in favour of the subtest (the leaf names what broke).
import type { Extraction, Extractor } from './types.ts';

const FAIL = /^\s*--- FAIL: (\S+)(?: \([\d.]+s\))?/;
const PKG = /^FAIL\t(\S+)(?:\t.*)?$/;
const OK = /^ok {2}\t\S+/;
const LOC = /^\s+(\S+_test\.go:\d+: .+)$/;
const PANIC = /^panic: .+/;

export const goTest: Extractor = {
  name: 'go-test',
  detect: (lines) => lines.some((l) => FAIL.test(l) || PKG.test(l) || OK.test(l)),
  extract(lines): Extraction {
    const names: string[] = [];
    const locs: string[] = [];
    const pkgs: string[] = [];
    let firstLine: number | null = null;
    lines.forEach((l, i) => {
      const f = FAIL.exec(l);
      if (f) {
        names.push(f[1] ?? '');
        firstLine ??= i;
        return;
      }
      const loc = LOC.exec(l);
      if (loc) {
        locs.push((loc[1] ?? '').trim());
        return;
      }
      if (PANIC.test(l)) {
        locs.push(l.trim());
        firstLine ??= i;
        return;
      }
      const p = PKG.exec(l);
      if (p) pkgs.push(`FAIL ${p[1]}`);
    });
    const tests = names.filter((n) => !names.some((m) => m.startsWith(`${n}/`)));
    return { tests, errors: [...locs, ...pkgs], firstLine };
  },
};
