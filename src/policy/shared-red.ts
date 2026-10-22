// The CI_RED waiver (02 §8.2 row 11, §1.5; 03 §5.1). One definition of "shared with main" serves ci wait
// (red-shared, exit 11), pr status and pr merge, so a red that ci wait calls shared is mergeable here too:
// every failing check must carry a `same-tests` or `same-step` verdict. `different`, `main-green`,
// `no-main-run`, `not-compared` and an uncompared (null) check all block. `merge.sharedRed: off` never waives.
// `tests` and `step` waive the same verdicts: compare-main only yields `same-step` when neither side has
// test names, so there is no looser step-only match to opt into.
import type { FailingCheck, SameOnMainVerdict } from '../schemas/ci.ts';

export type SharedRedMode = 'tests' | 'step' | 'off';

export const SHARED_VERDICTS: readonly SameOnMainVerdict[] = ['same-tests', 'same-step'];

export function isShared(f: Pick<FailingCheck, 'sameOnMain'>): boolean {
  return f.sameOnMain !== null && SHARED_VERDICTS.includes(f.sameOnMain.verdict);
}

/** True when CI_RED is waived: some failure exists and every one is shared with main. */
export function sharedRedWaived(failing: readonly Pick<FailingCheck, 'sameOnMain'>[], mode: SharedRedMode): boolean {
  return mode !== 'off' && failing.length > 0 && failing.every(isShared);
}
