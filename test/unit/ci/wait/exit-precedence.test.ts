// The multi-target aggregate (02 §6.1; 03 M4.9): the first exit that applies in
// 10 > 14 > 13 > 12 > 15 > 11 > 0, for every pair of outcomes, with numbers read from exit-table.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregate, OUTCOME_EXIT } from '../../../../src/ci/wait/summary.ts';
import type { Outcome } from '../../../../src/schemas/ci.ts';
import { EXIT } from '../../../contract/exit-table.ts';

const ORDER = [
  EXIT.CI_RED,
  EXIT.CI_STALLED,
  EXIT.NO_CHECKS,
  EXIT.SUPERSEDED,
  EXIT.CI_PENDING_RESUME,
  EXIT.CI_RED_SHARED,
  EXIT.OK,
];
const BY_OUTCOME: Record<Exclude<Outcome, 'interrupted'>, number> = {
  red: EXIT.CI_RED,
  stalled: EXIT.CI_STALLED,
  'no-checks': EXIT.NO_CHECKS,
  superseded: EXIT.SUPERSEDED,
  closed: EXIT.SUPERSEDED,
  pending: EXIT.CI_PENDING_RESUME,
  'red-shared': EXIT.CI_RED_SHARED,
  green: EXIT.OK,
};
const outcomes = Object.keys(BY_OUTCOME) as (keyof typeof BY_OUTCOME)[];

test('each outcome maps to its 02 §6.1 exit', () => {
  for (const o of outcomes) assert.equal(OUTCOME_EXIT[o], BY_OUTCOME[o], o);
});

for (const a of outcomes) {
  for (const b of outcomes) {
    test(`${a} + ${b}`, () => {
      const want = ORDER.find((code) => code === BY_OUTCOME[a] || code === BY_OUTCOME[b]);
      const got = aggregate([{ outcome: a }, { outcome: b }]);
      assert.equal(got.exitCode, want);
      assert.equal(BY_OUTCOME[got.outcome as keyof typeof BY_OUTCOME], want);
    });
  }
}

test('a single target keeps its own outcome', () => {
  for (const o of outcomes) assert.deepEqual(aggregate([{ outcome: o }]).outcome, o);
});
