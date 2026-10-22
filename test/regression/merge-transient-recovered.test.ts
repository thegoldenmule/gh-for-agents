// R16 (03 §5.2), #3214. Guards the blind retry of a merge after a transient failure: the PUT may have gone
// through, so ghx re-reads the PR first. Merged at the pinned head is a success with recoveredFromTransient
// and exactly one PUT; still open at that head gets exactly one more PUT; anything else is reported.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HEAD,
  installMerge,
  isPullGet,
  isPut,
  MERGE_COMMIT,
  MOVED_HEAD,
  okJson,
  openPull,
  pullJson,
  put502,
  putOk,
  puts,
  REF,
  runMerge,
} from '../commands/pr-merge-world.ts';
import { EXIT } from '../contract/exit-table.ts';

const somethingWentWrong = () => ({
  exitCode: 1,
  stdout: '',
  stderr:
    'gh: Something went wrong while executing your query. Please include `ABCD:1234` when reporting this issue.\n',
});

for (const [name, reply] of [
  ['a 502', put502],
  ['GraphQL "Something went wrong"', somethingWentWrong],
] as const) {
  test(`R16: ${name} on the PUT, then a re-read merged at H → success, recoveredFromTransient, one PUT`, async () => {
    const fake = installMerge();
    fake.on(isPut, reply());
    fake.on(isPullGet, okJson(pullJson()));
    const r = await runMerge(['pr', 'merge', REF], fake);
    assert.equal(r.exitCode, EXIT.OK, r.stdout);
    assert.equal(r.json.merged, true);
    assert.equal(r.json.recoveredFromTransient, true);
    assert.equal(r.json.alreadyMerged, false);
    assert.equal(r.json.mergeCommit, MERGE_COMMIT);
    assert.equal(puts(fake).length, 1, 'never re-sent');
  });
}

test('R16: a transient PUT failure re-read open at H gets exactly one more PUT', async () => {
  const fake = installMerge();
  fake.on(isPut, [put502(), putOk()]);
  fake.on(isPullGet, [okJson(openPull('clean')), okJson(pullJson())]);
  const r = await runMerge(['pr', 'merge', REF], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.recoveredFromTransient, false);
  assert.deepEqual(puts(fake), [
    { sha: HEAD, merge_method: 'merge' },
    { sha: HEAD, merge_method: 'merge' },
  ]);
});

test('R16: two transient failures with the PR still open is GH_FAILED (exit 7) after two PUTs', async () => {
  const fake = installMerge();
  fake.on(isPut, put502());
  fake.on(isPullGet, okJson(openPull('clean')));
  const r = await runMerge(['pr', 'merge', REF], fake);
  assert.equal(r.exitCode, EXIT.GH_FAILED, r.stdout);
  assert.equal(r.json.error.code, 'GH_FAILED');
  assert.equal(r.json.error.details.attempts, 2);
  assert.match(r.json.error.hint, /still open at 9f2c4e1/);
  assert.equal(puts(fake).length, 2);
});

test('R16: a transient failure whose re-read shows a new head is HEAD_MOVED, with no second PUT', async () => {
  const fake = installMerge();
  fake.on(isPut, put502());
  fake.on(isPullGet, okJson(openPull('clean', MOVED_HEAD)));
  const r = await runMerge(['pr', 'merge', REF], fake);
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.equal(r.json.error.code, 'HEAD_MOVED');
  assert.equal(puts(fake).length, 1);
});

test('R16: a transient failure whose re-read also fails is GH_FAILED with no second PUT', async () => {
  const fake = installMerge();
  fake.on(isPut, put502());
  fake.on(isPullGet, { exitCode: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)\n' });
  const r = await runMerge(['pr', 'merge', REF], fake);
  assert.equal(r.exitCode, EXIT.GH_FAILED, r.stdout);
  assert.match(r.json.error.hint, /merge state is unknown/);
  assert.equal(puts(fake).length, 1);
});

test('R16: merged at H before GitHub fills in the merge commit → polled, still recovered, one PUT', async () => {
  const fake = installMerge();
  fake.on(isPut, put502());
  fake.on(isPullGet, [okJson(pullJson({ merge_commit_sha: null })), okJson(pullJson())]);
  const r = await runMerge(['pr', 'merge', REF], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.recoveredFromTransient, true);
  assert.equal(r.json.mergeCommit, MERGE_COMMIT);
  assert.equal(puts(fake).length, 1);
});
