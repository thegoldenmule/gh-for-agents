// R07 (03 §5.2). Guards feedback_only_own_prs.md (gh-usage-findings §4.3): ghx refuses to merge someone
// else's PR (AUTHOR_NOT_VIEWER, exit 6) unless the user asked, recorded as --override with a --reason.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installMerge, isPut, puts, REF, runMerge } from '../commands/pr-merge-world.ts';
import { workedPr } from '../commands/pr-status-world.ts';
import { EXIT } from '../contract/exit-table.ts';

const otherDev = () => workedPr({ author: { __typename: 'User', login: 'other-dev' } });

test("R07: someone else's PR is MERGE_BLOCKED with AUTHOR_NOT_VIEWER (exit 6) and no PUT", async () => {
  const fake = installMerge(undefined, { pr: otherDev() });
  const r = await runMerge(['pr', 'merge', REF], fake);
  assert.equal(r.exitCode, EXIT.POLICY, r.stdout);
  assert.equal(r.json.error.code, 'MERGE_BLOCKED');
  const [blocker] = r.json.error.details.plan.blockers;
  assert.deepEqual([blocker.code, blocker.overridable], ['AUTHOR_NOT_VIEWER', true]);
  assert.match(blocker.message, /authored by other-dev, not you \(thegoldenmule\)/);
  assert.match(r.json.error.hint, /--override AUTHOR_NOT_VIEWER --reason/);
  fake.expectNoCall(isPut);
});

test('R07: --override AUTHOR_NOT_VIEWER --reason proceeds and records the override in the plan', async () => {
  const fake = installMerge(undefined, { pr: otherDev() });
  const r = await runMerge(
    ['pr', 'merge', REF, '--override', 'AUTHOR_NOT_VIEWER', '--reason', 'user asked in chat'],
    fake,
  );
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.merged, true);
  assert.deepEqual(r.json.plan.overrides, [{ code: 'AUTHOR_NOT_VIEWER', reason: 'user asked in chat' }]);
  const check = r.json.plan.checks.find((c: { code: string }) => c.code === 'AUTHOR_NOT_VIEWER');
  assert.equal(check.status, 'overridden');
  assert.equal(puts(fake).length, 1);
});

test('R07: the override without --reason is VALIDATION (exit 2) before any gh call', async () => {
  const fake = installMerge(undefined, { pr: otherDev() });
  const r = await runMerge(['pr', 'merge', REF, '--override', 'AUTHOR_NOT_VIEWER'], fake);
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  assert.equal(r.json.error.code, 'VALIDATION');
  assert.equal(r.json.error.details.issues[0].code, 'override.reason_required');
  assert.equal(fake.calls.length, 0);
});
