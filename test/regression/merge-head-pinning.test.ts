// R01 (03 §5.2). Guards the unpinned merges: only 8 of 52 pinned the head (gh-usage-findings §4.3) [G-SHA].
// A stale --expect-head is caught before any PUT; and when the branch moves between the read and the merge,
// the PUT pinned to the evaluated head gets GitHub's 409, which is HEAD_MOVED (exit 9) and never retried.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HEAD,
  installMerge,
  isPullGet,
  isPut,
  MOVED_HEAD,
  okJson,
  openPull,
  put409,
  puts,
  REF,
  runMerge,
} from '../commands/pr-merge-world.ts';
import { EXIT } from '../contract/exit-table.ts';

test('R01a: a stale --expect-head is HEAD_MOVED (exit 9) with details.{expected,actual}, and no PUT', async () => {
  const fake = installMerge();
  const r = await runMerge(['pr', 'merge', REF, '--expect-head', '4b1e7d2'], fake);
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.equal(r.json.error.code, 'HEAD_MOVED');
  assert.equal(r.json.error.details.expected, '4b1e7d2');
  assert.equal(r.json.error.details.actual, HEAD);
  assert.match(r.json.error.message, /Head is 9f2c4e1, expected 4b1e7d2/);
  assert.equal(r.json.error.details.plan.headSha, HEAD, 'every check still ran; the plan is in details');
  fake.expectNoCall(isPut);
  fake.expectNoMutations();
});

test('R01b: the head moves after the read; the PUT pinned to H1 gets 409 → HEAD_MOVED, not retried, not merged', async () => {
  const fake = installMerge();
  fake.on(isPut, put409());
  fake.on(isPullGet, okJson(openPull('clean', MOVED_HEAD)));
  const r = await runMerge(['pr', 'merge', REF, '--expect-head', HEAD.slice(0, 7)], fake);
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.equal(r.json.error.code, 'HEAD_MOVED');
  // Exactly one PUT, pinned to the head the snapshot evaluated.
  assert.deepEqual(puts(fake), [{ sha: HEAD, merge_method: 'merge' }]);
  assert.deepEqual([r.json.error.details.expected, r.json.error.details.actual], [HEAD, MOVED_HEAD]);
  assert.equal(r.json.error.details.status, 409);
  assert.match(r.json.error.details.github, /Head branch was modified/);
  assert.equal(r.json.merged, undefined, 'never reported as merged');
  // R01c: the hint names pr status and the new SHA.
  assert.match(r.json.error.hint, /ghx pr status powerhouse-inc\/powerhouse#3301/);
  assert.match(r.json.error.hint, /--expect-head d00dfee/);
});

test('R01b: a 409 whose re-read fails is still HEAD_MOVED, with the new head unknown', async () => {
  const fake = installMerge();
  fake.on(isPut, put409());
  fake.on(isPullGet, { exitCode: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)\n' });
  const r = await runMerge(['pr', 'merge', REF], fake);
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.equal(r.json.error.code, 'HEAD_MOVED');
  assert.equal(r.json.error.details.actual, null);
  assert.equal(puts(fake).length, 1);
});
