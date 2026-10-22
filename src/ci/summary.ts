// Checks → CiSummary (02 §1.5, §11.3; 03 M2.2): counts, state and phase. Pure.
//
// - Zero considered checks is `no-checks`/`registering`, never green.
// - `cancelled` counts as red.
// - A missing expected check (required/config/baseline, computed by the caller) keeps the state off
//   green and the phase at `partial`.
import type { Check, CiCounts, CiSummary, ExpectedCheck, FailingCheck, PendingCheck } from '../schemas/ci.ts';

export interface SummariseInput {
  headSha: string;
  /** Considered checks (already collapsed and ignore-filtered). */
  checks: readonly Check[];
  /** Names of ignored checks. */
  ignored?: readonly string[];
  /** The expected set (M4.1); entries with state `missing` keep the summary off green. */
  expected?: readonly ExpectedCheck[];
  eta?: CiSummary['eta'];
  next?: readonly string[];
  /**
   * The rollup never matched the head SHA (snapshot warned CI_SHA_MISMATCH). Its checks belong to
   * another commit, so none are reported and the state is `pending`.
   */
  shaMismatch?: boolean;
}

export function countChecks(checks: readonly Check[], ignored = 0): CiCounts {
  const counts: CiCounts = { pass: 0, fail: 0, pending: 0, skipped: 0, cancelled: 0, neutral: 0, ignored };
  for (const c of checks) counts[c.bucket]++;
  return counts;
}

export const isRed = (c: Pick<Check, 'bucket'>): boolean => c.bucket === 'fail' || c.bucket === 'cancelled';

export function ciState(
  checks: readonly Check[],
  missing: number,
  shaMismatch = false,
): Pick<CiSummary, 'state' | 'phase'> {
  if (shaMismatch) return { state: 'pending', phase: 'registering' };
  if (checks.length === 0) return { state: missing > 0 ? 'pending' : 'no-checks', phase: 'registering' };
  const pending = checks.some((c) => c.bucket === 'pending');
  const phase = missing > 0 ? 'partial' : pending ? 'running' : 'settled';
  if (checks.some(isRed)) return { state: 'red', phase };
  return { state: pending || missing > 0 ? 'pending' : 'green', phase };
}

export function summariseCi(i: SummariseInput): CiSummary {
  const checks = i.shaMismatch ? [] : i.checks;
  const ignored = i.shaMismatch ? [] : [...(i.ignored ?? [])];
  const expectedMissing = (i.expected ?? []).filter((e) => e.state === 'missing');
  const failing: FailingCheck[] = checks.filter(isRed).map((c) => ({ ...c, sameOnMain: null, flake: null }));
  const pending: PendingCheck[] = checks
    .filter((c) => c.bucket === 'pending')
    .map((c) => ({ name: c.name, workflow: c.workflow, status: c.status, required: c.required }));
  return {
    headSha: i.headSha,
    forHeadSha: true,
    ...ciState(checks, expectedMissing.length, i.shaMismatch === true),
    counts: countChecks(checks, ignored.length),
    failing,
    pending,
    ignored,
    expectedMissing,
    eta: i.eta ?? null,
    next: [...(i.next ?? [])],
  };
}
