// Failing-test and error extraction (02 §12 step 4; 03 M2.4, §5.1). Runner extractors are picked by
// signature; `generic` and `ci.logPatterns` always run. Results are deduplicated and capped to the
// FailingJob limits (30 tests, 20 errors, 300 chars per line); `testsTruncated` says the test cap cut the list. A log no extractor recognises still
// yields errors, an exit line and an excerpt, never an empty diagnosis.
import { CI_CAPS } from '../../../schemas/ci.ts';
import { END_ACTION } from '../steps.ts';
import { compilePatterns, generic } from './generic.ts';
import { goTest } from './go-test.ts';
import { jest } from './jest.ts';
import { nodeTest } from './node-test.ts';
import { pytest } from './pytest.ts';
import { type Extractor, firstOf } from './types.ts';
import { vitest } from './vitest.ts';

export const EXTRACTORS: readonly Extractor[] = [vitest, jest, nodeTest, pytest, goTest];

export interface Failures {
  /** Extractors whose signature matched. */
  runners: string[];
  tests: string[];
  /** More distinct failing tests than `tests` holds (the cap cut the list): never a subset proof. */
  testsTruncated: boolean;
  errors: string[];
  exitLine: string | null;
  /** Index (in the input lines) of the first failure line, or null. */
  firstLine: number | null;
}

export interface ExtractOptions {
  /** ci.logPatterns: regex sources whose matching lines count as errors. */
  logPatterns?: readonly string[];
  maxTests?: number;
  maxErrors?: number;
}

/** Cap one line at `max` chars, ellipsis included. */
export function capLine(s: string, max: number = CI_CAPS.lineChars): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function dedupe(xs: readonly string[], cap: number): string[] {
  return dedupeCounted(xs, cap).out;
}

/** Deduplicated and capped, plus whether anything distinct was left out by the cap. */
function dedupeCounted(xs: readonly string[], cap: number): { out: string[]; truncated: boolean } {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of xs) {
    const v = capLine(x.trim());
    if (v === '' || seen.has(v)) continue;
    if (out.length >= cap) return { out, truncated: true };
    seen.add(v);
    out.push(v);
  }
  return { out, truncated: false };
}

export function extractFailures(lines: readonly string[], o: ExtractOptions = {}): Failures {
  const runners: string[] = [];
  const tests: string[] = [];
  const errors: string[] = [];
  let firstLine: number | null = null;
  for (const x of EXTRACTORS) {
    if (!x.detect(lines)) continue;
    const r = x.extract(lines);
    runners.push(x.name);
    tests.push(...r.tests);
    errors.push(...r.errors);
    firstLine = firstOf(firstLine, r.firstLine);
  }
  const g = generic(lines, compilePatterns(o.logPatterns ?? []));
  errors.push(...g.errors);
  firstLine = firstOf(firstLine, g.firstLine);
  const t = dedupeCounted(tests, o.maxTests ?? CI_CAPS.tests);
  return {
    runners,
    tests: t.out,
    testsTruncated: t.truncated,
    errors: dedupe(errors, o.maxErrors ?? CI_CAPS.errors),
    exitLine: g.exitLine === null ? null : capLine(g.exitLine),
    firstLine,
  };
}

const NOISE = /^##\[(?:group|endgroup)\]|^##\[end-action\b/;

/**
 * Up to `maxLines` lines (and `maxChars`) around the first failure: from 2 lines before it, or the
 * last lines before the exit line when nothing was recognised. Runner markers are dropped.
 */
export function excerpt(
  lines: readonly string[],
  firstLine: number | null,
  o: { maxLines?: number; maxChars?: number } = {},
): string {
  const maxLines = Math.min(o.maxLines ?? CI_CAPS.excerptLinesDefault, CI_CAPS.excerptLinesMax);
  const maxChars = Math.min(o.maxChars ?? CI_CAPS.excerptChars, CI_CAPS.excerptChars);
  const useful = lines.map((l, i) => ({ l, i })).filter(({ l }) => !NOISE.test(l) && !END_ACTION.test(l));
  let start: number;
  let end = useful.length;
  if (firstLine !== null) {
    const at = useful.findIndex(({ i }) => i >= firstLine);
    start = Math.max(0, (at === -1 ? useful.length : at) - 2);
  } else {
    while (end > 0 && /^(?:##\[error\])?Process completed with exit code/.test(useful[end - 1]?.l ?? '')) end--;
    start = Math.max(0, end - maxLines);
  }
  const out: string[] = [];
  let chars = 0;
  for (const { l } of useful.slice(start, Math.min(end, start + maxLines))) {
    const line = capLine(l);
    const add = line.length + (out.length > 0 ? 1 : 0);
    if (chars + add > maxChars) break;
    out.push(line);
    chars += add;
  }
  return out.join('\n');
}
