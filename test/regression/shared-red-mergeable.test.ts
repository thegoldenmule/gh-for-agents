// R08 (03 §5.2), the pr merge half. Guards "merge when main shares red", #3246 (gh-usage-findings §4.3, §7):
// a failing test that also fails on main's latest push run is waived and the merge proceeds; a different
// test, or merge.sharedRed off, blocks with CI_RED (policy, exit 6). The ci wait and pr status halves live
// with those commands.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { logReply } from '../commands/ci-why-world.ts';
import { installMerge, isPut, MERGE_COMMIT, puts, REF, runMerge } from '../commands/pr-merge-world.ts';
import { at, CONFIG, MAIN_JOB, sharedLog } from '../commands/pr-status-world.ts';
import { EXIT } from '../contract/exit-table.ts';

test('R08: the failing test also fails on main → CI_RED waived, and pr merge merges', async () => {
  const fake = installMerge();
  const r = await runMerge(['pr', 'merge', REF], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.merged, true);
  assert.equal(r.json.mergeCommit, MERGE_COMMIT);
  assert.deepEqual(
    r.json.plan.waivers.map((w: { code: string }) => w.code),
    ['CI_RED'],
  );
  assert.match(r.json.plan.waivers[0].message, /fails with the same test on main run 37950011223/);
  assert.equal(puts(fake).length, 1);
});

test('R08 counter-case: main fails a different test → CI_RED blocks (exit 6), no PUT', async () => {
  const fake = installMerge();
  fake.on(at(`/actions/jobs/${MAIN_JOB}/logs`), logReply({ text: sharedLog('reactor-api > some other test') }));
  const r = await runMerge(['pr', 'merge', REF], fake);
  assert.equal(r.exitCode, EXIT.POLICY, r.stdout);
  assert.deepEqual(
    r.json.error.details.plan.blockers.map((b: { code: string }) => b.code),
    ['CI_RED'],
  );
  fake.expectNoCall(isPut);
});

test('R08 counter-case: merge.sharedRed off → CI_RED blocks even when shared', async () => {
  const fake = installMerge(undefined, { config: { ...CONFIG, merge: { method: 'merge', sharedRed: 'off' } } });
  const r = await runMerge(['pr', 'merge', REF], fake);
  assert.equal(r.exitCode, EXIT.POLICY, r.stdout);
  assert.deepEqual(
    r.json.error.details.plan.blockers.map((b: { code: string }) => b.code),
    ['CI_RED'],
  );
  assert.match(r.json.error.hint, /merge.sharedRed is off/);
  fake.expectNoCall(isPut);
});
