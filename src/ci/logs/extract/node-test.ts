// node:test: TAP `not ok 3 - name` (nested subtests are indented; `# SKIP`/`# TODO` are not failures)
// and the spec reporter's `✖ name (1.2ms)`, which it repeats under `✖ failing tests:`.
import { ERROR_LINE, type Extraction, type Extractor, stripDuration } from './types.ts';

const TAP = /^\s*not ok \d+(?: - (.*))?$/;
const SPEC = /^\s*✖ (.+)$/;
const HEADER = /^\s*✖ failing tests:\s*$/;
const SUMMARY = /^\s*(?:ℹ|#) (?:tests|fail) \d+/;

export const nodeTest: Extractor = {
  name: 'node-test',
  detect: (lines) => lines.some((l) => SUMMARY.test(l)) && lines.some((l) => TAP.test(l) || SPEC.test(l)),
  extract(lines): Extraction {
    const tests: string[] = [];
    const errors: string[] = [];
    let firstLine: number | null = null;
    lines.forEach((l, i) => {
      if (HEADER.test(l)) return;
      const tap = TAP.exec(l);
      const spec = tap ? null : SPEC.exec(l);
      if (!tap && !spec) return;
      const raw = (tap ? (tap[1] ?? '') : (spec?.[1] ?? '')).trim();
      if (tap && /#\s*(?:SKIP|TODO)\b/i.test(raw)) return;
      // Only a TAP directive (` # SKIP`, ` # TODO`) follows ` #`; any other `#` belongs to the name.
      const name = stripDuration(tap ? raw.replace(/\s+#\s*(?:SKIP|TODO)\b.*$/i, '') : raw);
      if (name === '') return;
      tests.push(name);
      firstLine ??= i;
      const next = lines.slice(i + 1, i + 6).find((x) => ERROR_LINE.test(x.replace(/^##\[error\]/, '')));
      if (next) errors.push(next.replace(/^##\[error\]/, '').trim());
    });
    return { tests, errors, firstLine };
  },
};
