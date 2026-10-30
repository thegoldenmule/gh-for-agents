// The ci wait summary (02 §11.7, §11.9, §6.1): per-outcome exit codes, the multi-target aggregate,
// `next` suggestions, and the compaction that keeps the one stdout document within 16 KB. The
// summary is never spilled (03 §1 row 2): detail is cut level by level, and the full JSON goes to
// diagnosisPath.
import { CI_WAIT_EXIT_PRECEDENCE, ExitCode } from '../../core/exit.ts';
import { serializeJson } from '../../core/output.ts';
import type { Outcome, TargetSummary } from '../../schemas/ci.ts';

export const OUTCOME_EXIT: Readonly<Record<Exclude<Outcome, 'interrupted'>, ExitCode>> = {
  green: ExitCode.OK,
  red: ExitCode.CI_RED,
  'red-shared': ExitCode.CI_RED_SHARED,
  superseded: ExitCode.SUPERSEDED,
  closed: ExitCode.SUPERSEDED,
  'no-checks': ExitCode.NO_CHECKS,
  stalled: ExitCode.CI_STALLED,
  pending: ExitCode.CI_PENDING_RESUME,
};

/**
 * The aggregate of several targets: the first exit in 10 > 14 > 13 > 12 > 15 > 11 > 0 that any result
 * has, and that result's outcome. `interrupted` is decided by the caller (it wins outright).
 */
export function aggregate(results: readonly Pick<TargetSummary, 'outcome'>[]): {
  outcome: Outcome;
  exitCode: ExitCode;
} {
  const codes = results.map((r) => (r.outcome === 'interrupted' ? ExitCode.SIGTERM : OUTCOME_EXIT[r.outcome]));
  for (const code of CI_WAIT_EXIT_PRECEDENCE) {
    const i = codes.indexOf(code);
    if (i >= 0) return { outcome: (results[i] as TargetSummary).outcome, exitCode: code };
  }
  return { outcome: 'green', exitCode: ExitCode.OK };
}

/** Shell-quote one argument for a `next` command (only when it needs it). */
export function shellArg(s: string): string {
  return /^[\w@%+=:,./#-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

export interface CommandShape {
  targets: readonly string[];
  until: string;
  any: boolean;
  onHeadChange?: string | undefined;
  check?: readonly string[] | undefined;
  diagnose: boolean;
  compareMain: boolean;
  stream: boolean;
  foreground?: boolean | undefined;
  /** -R, when the repo came from the flag. */
  repo?: string | undefined;
}

/** The identical command, for `pending` and continuation (`next: [<the identical command>]`). */
export function identicalCommand(c: CommandShape): string {
  const parts = ['ghx', 'ci', 'wait', ...c.targets.map(shellArg)];
  if (c.until !== 'first-failure') parts.push('--until', c.until);
  if (c.any) parts.push('--any');
  if (c.onHeadChange) parts.push('--on-head-change', c.onHeadChange);
  for (const g of c.check ?? []) parts.push('--check', shellArg(g));
  if (!c.diagnose) parts.push('--no-diagnose');
  if (!c.compareMain) parts.push('--no-compare-main');
  if (c.stream) parts.push('--stream');
  if (c.foreground) parts.push('--foreground');
  if (c.repo) parts.push('-R', c.repo);
  return parts.join(' ');
}

export interface NextInput {
  outcome: Outcome;
  /** A PR ref (owner/repo#N) for PR targets; null for branch and run targets. */
  prRef: string | null;
  /** What ci rerun takes for this target (the PR, or `run:<id> -R o/r`); defaults to prRef. */
  rerunRef?: string | null;
  /** no-checks on a PR that conflicts with this base branch: resolve the conflict, not retrigger. */
  conflictBase?: string | null;
  headSha: string;
  /** The CI settled (a red that cannot change without a re-run). */
  settled: boolean;
  flaky: boolean;
  identical: string;
  /** Fix-the-file lines for runs GitHub rejected before any job ran (invalidRunNext); they replace a red's `next`. */
  workflowInvalid?: readonly string[];
}

export function nextFor(n: NextInput): string[] {
  const merge = n.prRef ? [`ghx pr merge ${n.prRef} --expect-head ${n.headSha.slice(0, 7)} --dry-run`] : [];
  const rerun = n.rerunRef === undefined ? n.prRef : n.rerunRef;
  const rerunFlaky = rerun && n.flaky ? [`ghx ci rerun ${rerun} --flaky`] : [];
  switch (n.outcome) {
    case 'green':
      return merge;
    case 'red-shared':
      return [...merge, ...rerunFlaky];
    case 'red':
      // Neither a re-wait nor a rerun changes a rejected workflow file.
      if (n.workflowInvalid && n.workflowInvalid.length > 0) return [...n.workflowInvalid];
      // An early red: the identical command continues to the next failure or to settle.
      return [...rerunFlaky, ...(n.settled ? [] : [n.identical])];
    case 'stalled':
      return [n.identical, ...(rerun ? [`ghx ci rerun ${rerun}`] : [])];
    case 'no-checks':
      // A retrigger cannot help a conflicting PR: merge the base in (or rebase), resolve, push.
      if (n.prRef && n.conflictBase) {
        return [`git fetch origin ${n.conflictBase} && git merge origin/${n.conflictBase}`, n.identical];
      }
      return n.prRef ? [`ghx ci retrigger ${n.prRef}`, n.identical] : [n.identical];
    case 'closed':
    case 'superseded':
      return n.prRef ? [`ghx pr status ${n.prRef}`] : [];
    case 'pending':
    case 'interrupted':
      return [n.identical];
  }
}

const cut = (s: string | null, n: number): string | null => (s === null || s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** Successively smaller forms of one target summary; level 0 is the full form. */
export function compactTarget(t: TargetSummary, level: number): TargetSummary {
  if (level <= 0) return t;
  const jobs = t.diagnosis?.jobs ?? [];
  const short = jobs.map((j) => ({
    ...j,
    tests: j.tests.slice(0, 1).map((x) => cut(x, 160) ?? ''),
    firstError: cut(j.firstError, 160),
  }));
  if (level === 1) return { ...t, diagnosis: t.diagnosis ? { ...t.diagnosis, jobs: short } : null };
  if (level === 2) {
    return {
      ...t,
      diagnosis: t.diagnosis ? { ...t.diagnosis, jobs: short.slice(0, 2).map((j) => ({ ...j, tests: [] })) } : null,
      ci: { ...t.ci, failing: t.ci.failing.slice(0, 5), expectedMissing: t.ci.expectedMissing.slice(0, 5) },
      stalled: t.stalled.slice(0, 3),
    };
  }
  if (level === 3) {
    return {
      ...t,
      diagnosis: t.diagnosis ? { ...t.diagnosis, jobs: [] } : null,
      ci: {
        ...t.ci,
        failing: t.ci.failing.slice(0, 2).map((f) => ({ ...f, name: cut(f.name, 80) ?? '' })),
        expectedMissing: t.ci.expectedMissing.slice(0, 2),
      },
      stalled: t.stalled.slice(0, 1),
      rerunCandidates: t.rerunCandidates.slice(0, 5),
      next: t.next.slice(0, 2),
    };
  }
  return {
    ...t,
    reason: cut(t.reason, 40),
    diagnosis: t.diagnosis ? { jobs: [], partial: t.diagnosis.partial } : null,
    ci: { ...t.ci, failing: [], expectedMissing: [] },
    stalled: t.stalled.slice(0, 1),
    rerunCandidates: [],
    next: t.next.slice(0, 1),
  };
}

export const COMPACT_LEVELS = 4;

/**
 * The least-compacted form of `doc` whose JSON fits `maxBytes`. `build(level)` returns the document at
 * a level. Returns the level used (0 = nothing cut). With `project` (--fields/--brief, Context.project)
 * the bound is on what the runner prints, project(doc): detail the projection drops is never cut for size.
 */
export function fitDocument<T>(
  build: (level: number) => T,
  maxBytes: number,
  project?: (doc: unknown) => unknown,
): { doc: T; level: number } {
  for (let level = 0; level <= COMPACT_LEVELS; level++) {
    const doc = build(level);
    if (Buffer.byteLength(serializeJson(project ? project(doc) : doc), 'utf8') <= maxBytes) return { doc, level };
  }
  return { doc: build(COMPACT_LEVELS), level: COMPACT_LEVELS };
}
