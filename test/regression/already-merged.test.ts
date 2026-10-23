// R17 (03 §5.2), #3211. Guards re-running a merge that already happened: a PR merged at the evaluated head
// is {merged:true, alreadyMerged:true}, exit 0, with nothing sent; a stale --expect-head still wins.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HEAD,
  installMerge,
  isPullGet,
  isPut,
  MERGE_COMMIT,
  MERGED_AT,
  okJson,
  pullJson,
  put405,
  puts,
  REF,
  runMerge,
  workedPr,
} from '../commands/pr-merge-world.ts';
import { EXIT } from '../contract/exit-table.ts';

const merged = () =>
  workedPr({ state: 'MERGED', mergedAt: MERGED_AT, mergeCommit: { oid: MERGE_COMMIT }, mergeable: 'UNKNOWN' });

test('R17: an already merged PR is alreadyMerged:true, exit 0, and nothing is sent', async () => {
  const fake = installMerge(undefined, { pr: merged() });
  const r = await runMerge(['pr', 'merge', REF], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.merged, true);
  assert.equal(r.json.alreadyMerged, true);
  assert.equal(r.json.mergeCommit, MERGE_COMMIT);
  assert.equal(r.json.mergedAt, MERGED_AT);
  assert.equal(r.json.headSha, HEAD);
  fake.expectNoCall(isPut);
});

test('R17: with a matching --expect-head it is still alreadyMerged; a stale one is HEAD_MOVED', async () => {
  const ok = await runMerge(
    ['pr', 'merge', REF, '--expect-head', HEAD.slice(0, 7)],
    installMerge(undefined, { pr: merged() }),
  );
  assert.equal(ok.exitCode, EXIT.OK, ok.stdout);
  assert.equal(ok.json.alreadyMerged, true);
  const fake = installMerge(undefined, { pr: merged() });
  const stale = await runMerge(['pr', 'merge', REF, '--expect-head', '4b1e7d2'], fake);
  assert.equal(stale.exitCode, EXIT.STATE, stale.stdout);
  assert.equal(stale.json.error.code, 'HEAD_MOVED');
  fake.expectNoCall(isPut);
});

test('R17 race: merged by someone else at H between the read and the PUT (405) → alreadyMerged', async () => {
  const fake = installMerge();
  fake.on(isPut, put405());
  fake.on(isPullGet, okJson(pullJson()));
  const r = await runMerge(['pr', 'merge', REF], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.alreadyMerged, true);
  assert.equal(r.json.mergeCommit, MERGE_COMMIT);
  assert.equal(puts(fake).length, 1);
});

test('R17 race: a 405 re-read merged at H without a merge commit yet is polled, not a failure', async () => {
  const fake = installMerge();
  fake.on(isPut, put405());
  fake.on(isPullGet, [okJson(pullJson({ merge_commit_sha: null })), okJson(pullJson())]);
  const r = await runMerge(['pr', 'merge', REF], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.alreadyMerged, true);
  assert.equal(r.json.mergeCommit, MERGE_COMMIT);
});

test('R17: --dry-run on an already merged PR is a dry-run result with nothing to run, not a merge success', async () => {
  const fake = installMerge(undefined, { pr: merged() });
  const r = await runMerge(['pr', 'merge', REF, '--dry-run'], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.dryRun, true);
  assert.deepEqual(r.json.wouldRun, []);
  assert.equal(r.json.merged, undefined);
  assert.deepEqual([r.json.preview.alreadyMerged, r.json.preview.mergeCommit], [true, MERGE_COMMIT]);
  fake.expectNoMutations();
  // With --delete-branch it halts at the DELETE it would send.
  const del = await runMerge(
    ['pr', 'merge', REF, '--dry-run', '--delete-branch'],
    installMerge(undefined, { pr: merged() }),
  );
  assert.equal(del.json.dryRun, true, del.stdout);
  assert.ok(del.json.wouldRun[0].argv.includes('DELETE'), JSON.stringify(del.json.wouldRun));
});
