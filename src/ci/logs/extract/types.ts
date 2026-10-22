// The extractor contract (03 M2.4). An extractor reads cleaned log lines (strip.ts) and returns the
// failing test names and error lines it recognises. Names must be stable across runs (no durations,
// no line numbers), because compare-main and flake compare them between the PR and main.

export interface Extraction {
  tests: string[];
  errors: string[];
  /** Index of the first line that shows a failure, for the excerpt. */
  firstLine: number | null;
}

export interface Extractor {
  name: string;
  /** True when the log looks like this runner's output. */
  detect(lines: readonly string[]): boolean;
  extract(lines: readonly string[]): Extraction;
}

export const empty = (): Extraction => ({ tests: [], errors: [], firstLine: null });

/** Strip a trailing duration such as ` 1926ms`, ` (243.626ms)`, ` (21.506 s)` or ` (0.00s)`. */
export function stripDuration(s: string): string {
  return s.replace(/\s+\(?\d+(?:\.\d+)?\s?(?:ms|s|m)\)?$/, '').trimEnd();
}

export function firstOf(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/** Lines that look like an error message: `Error: …`, `TypeError: …`, `AssertionError [ERR_X]: …`. */
export const ERROR_LINE = /^\s*(?:Uncaught\s+)?([A-Z]\w*)?(?:Error|Exception)(?: \[[A-Z0-9_]+\])?: \S/;
