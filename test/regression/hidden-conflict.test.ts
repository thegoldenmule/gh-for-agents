// R05 (03 §5.2). Guards the #3198 conflict that `| tail -1` hid (gh-usage-findings §3.3): a conflict is a
// structured MERGE_BLOCKED with the blocker MERGE_CONFLICT (exit 9) and the exact fetch/merge/push hint,
// whether the read sees it or GitHub refuses the PUT with 405. stdout is one JSON line, so no tail hides it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  installMerge,
  isPullGet,
  isPut,
  okJson,
  openPull,
  put405,
  puts,
  REF,
  runMerge,
  workedPr,
} from '../commands/pr-merge-world.ts';
import { EXIT } from '../contract/exit-table.ts';

const HINT = 'git fetch origin main && git merge origin/main';
const oneLine = (stdout: string) => assert.equal(stdout.trim().split('\n').length, 1, stdout);

test('R05: a CONFLICTING/DIRTY read is MERGE_BLOCKED with MERGE_CONFLICT (exit 9) and no PUT', async () => {
  const fake = installMerge(undefined, { pr: workedPr({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }) });
  const r = await runMerge(['pr', 'merge', REF], fake);
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.equal(r.json.error.code, 'MERGE_BLOCKED');
  assert.deepEqual(
    r.json.error.details.plan.blockers.map((b: { code: string }) => b.code),
    ['MERGE_CONFLICT'],
  );
  assert.ok(r.json.error.hint.includes(HINT), r.json.error.hint);
  oneLine(r.stdout);
  fake.expectNoCall(isPut);
});

test('R05 race: the read says MERGEABLE, the PUT gets 405, the re-read says dirty → MERGE_CONFLICT', async () => {
  const fake = installMerge();
  fake.on(isPut, put405());
  fake.on(isPullGet, okJson(openPull('dirty')));
  const r = await runMerge(['pr', 'merge', REF], fake);
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.equal(r.json.error.code, 'MERGE_BLOCKED');
  const plan = r.json.error.details.plan;
  assert.equal(plan.allowed, false);
  assert.deepEqual(
    plan.blockers.map((b: { code: string }) => b.code),
    ['MERGE_CONFLICT'],
  );
  assert.equal(plan.checks.find((c: { code: string }) => c.code === 'MERGE_CONFLICT').status, 'fail');
  assert.equal(plan.blockers[0].details.status, 405);
  assert.equal(plan.blockers[0].details.github, 'Pull Request is not mergeable');
  assert.ok(r.json.error.hint.includes(HINT), r.json.error.hint);
  oneLine(r.stdout);
  assert.equal(puts(fake).length, 1, 'a 405 is never retried');
});

test('R05 race: a 405 whose re-read says blocked is BLOCKED_BY_PROTECTION (exit 9)', async () => {
  const fake = installMerge();
  fake.on(isPut, put405());
  fake.on(isPullGet, okJson(openPull('blocked')));
  const r = await runMerge(['pr', 'merge', REF], fake);
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.deepEqual(
    r.json.error.details.plan.blockers.map((b: { code: string }) => b.code),
    ['BLOCKED_BY_PROTECTION'],
  );
  assert.match(
    r.json.error.details.plan.blockers[0].message,
    /GitHub refused the merge: Pull Request is not mergeable/,
  );
  oneLine(r.stdout);
  assert.equal(puts(fake).length, 1);
});
