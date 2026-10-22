// R06 (03 §5.2). Guards the 4 unwanted squashes and the user's "Do not squash" (gh-usage-findings §4.3,
// §7): a merge commit is the default; squash or rebase needs an explicit --method that merge.allowedMethods
// and the repo setting both allow, and METHOD_NOT_ALLOWED cannot be overridden.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installMerge, isPut, puts, REF, runMerge } from '../commands/pr-merge-world.ts';
import { CONFIG, workedPr } from '../commands/pr-status-world.ts';
import { EXIT } from '../contract/exit-table.ts';
import { isQ1, q1Reply } from '../unit/pr/snapshot-fixture.ts';

const SQUASH_OK = { ...CONFIG, merge: { method: 'merge', allowedMethods: ['merge', 'squash'] } };
const blockers = (r: { json: any }) => (r.json.error.details.plan.blockers as { code: string }[]).map((b) => b.code);

test('R06: default config, --method squash is METHOD_NOT_ALLOWED (exit 6) and nothing is sent', async () => {
  const fake = installMerge();
  const r = await runMerge(['pr', 'merge', REF, '--method', 'squash'], fake);
  assert.equal(r.exitCode, EXIT.POLICY, r.stdout);
  assert.equal(r.json.error.code, 'MERGE_BLOCKED');
  assert.deepEqual(blockers(r), ['METHOD_NOT_ALLOWED']);
  assert.match(r.json.error.details.plan.blockers[0].message, /squash is not in merge.allowedMethods/);
  fake.expectNoCall(isPut);
});

test('R06: squash without --method (config merge.method squash) is METHOD_NOT_ALLOWED', async () => {
  const fake = installMerge(undefined, {
    config: { ...CONFIG, merge: { method: 'squash', allowedMethods: ['merge', 'squash'] } },
  });
  const r = await runMerge(['pr', 'merge', REF], fake);
  assert.equal(r.exitCode, EXIT.POLICY, r.stdout);
  assert.deepEqual(blockers(r), ['METHOD_NOT_ALLOWED']);
  assert.match(r.json.error.details.plan.blockers[0].message, /squash needs an explicit --method squash/);
  fake.expectNoCall(isPut);
});

test('R06: --override METHOD_NOT_ALLOWED is VALIDATION (exit 2): the code is not overridable', async () => {
  const fake = installMerge();
  const r = await runMerge(
    ['pr', 'merge', REF, '--method', 'squash', '--override', 'METHOD_NOT_ALLOWED', '--reason', 'user asked'],
    fake,
  );
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  assert.equal(r.json.error.code, 'VALIDATION');
  assert.equal(r.json.error.details.issues[0].code, 'override.not_overridable');
  fake.expectNoCall(isPut);
});

test('R06: allowedMethods [merge, squash] with --method squash sends a squash PUT titled "{title} (#N)"', async () => {
  const fake = installMerge(undefined, { config: SQUASH_OK });
  const r = await runMerge(['pr', 'merge', REF, '--method', 'squash'], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.method, 'squash');
  const [body] = puts(fake);
  assert.equal(body?.merge_method, 'squash');
  assert.equal(body?.commit_title, 'fix(reactor): bind documentId when signing actions on the write path (#3301)');
  assert.match(String(body?.commit_message), /^The primary write path in reactor-client signed actions/);
  assert.ok(!String(body?.commit_message).includes('ghx:v1'), 'the description, not the raw body');
});

test('R06: a repo with squashMergeAllowed false refuses squash even when config allows it', async () => {
  const fake = installMerge(undefined, { config: SQUASH_OK });
  fake.on(isQ1, q1Reply(workedPr(), { squashMergeAllowed: false }));
  const r = await runMerge(['pr', 'merge', REF, '--method', 'squash'], fake);
  assert.equal(r.exitCode, EXIT.POLICY, r.stdout);
  assert.deepEqual(blockers(r), ['METHOD_NOT_ALLOWED']);
  assert.match(r.json.error.details.plan.blockers[0].message, /the repo does not allow squash merges/);
  fake.expectNoCall(isPut);
});

test('R06: with no --method the PUT carries merge_method "merge" and no squash fields', async () => {
  const fake = installMerge(undefined, { config: SQUASH_OK });
  const r = await runMerge(['pr', 'merge', REF], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(puts(fake), [{ sha: r.json.headSha, merge_method: 'merge' }]);
});
