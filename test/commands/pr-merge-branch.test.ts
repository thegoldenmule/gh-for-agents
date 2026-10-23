// ghx pr merge: children and the head branch after the merge (02 §8.1 steps 9–10; 03 M8.3). The remote ref
// is deleted only when asked, for a same-repo head that no open PR is based on and that still points at the
// merged head. Every post-merge problem is a warning: the merge itself already succeeded.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT } from '../contract/exit-table.ts';
import { httpReply } from './ci-why-world.ts';
import {
  CONFIG,
  HEAD_BRANCH,
  installMerge,
  isChildren,
  isRefDelete,
  isRefGet,
  MERGE_COMMIT,
  MOVED_HEAD,
  okJson,
  REF,
  runMerge,
  slowReplies,
  workedPr,
} from './pr-merge-world.ts';

const warned = (r: { json: any }, code: string) =>
  (r.json.warnings as { code: string; message: string }[]).find((w) => w.code === code);
const deletes = (fake: ReturnType<typeof installMerge>) => fake.calls.filter((c) => isRefDelete(c.argv));

test('--delete-branch deletes the remote head ref; next waits for CI on the default branch merge commit', async () => {
  const fake = installMerge();
  const r = await runMerge(['pr', 'merge', REF, '--delete-branch'], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.deletedBranch, true);
  assert.deepEqual(r.json.children, []);
  assert.deepEqual(r.json.next, [`ghx ci wait branch:main@${MERGE_COMMIT}`]);
  const [del] = deletes(fake);
  assert.ok(del?.argv.includes(`repos/powerhouse-inc/powerhouse/git/refs/heads/${HEAD_BRANCH}`), del?.argv.join(' '));
  fake.expectCalls([isChildren, isRefGet, isRefDelete], { ordered: true });
});

test('merge.deleteBranch in config deletes without the flag; --no-delete-branch keeps it', async () => {
  const config = { ...CONFIG, merge: { method: 'merge', deleteBranch: true } };
  const yes = installMerge(undefined, { config });
  const r = await runMerge(['pr', 'merge', REF], yes);
  assert.equal(r.json.deletedBranch, true, r.stdout);
  const no = installMerge(undefined, { config });
  const kept = await runMerge(['pr', 'merge', REF, '--no-delete-branch'], no);
  assert.equal(kept.json.deletedBranch, false, kept.stdout);
  assert.equal(deletes(no).length, 0);
});

test('without --delete-branch nothing is deleted, and children are still reported', async () => {
  const fake = installMerge();
  fake.on(isChildren, okJson([{ number: 3302, base: { ref: HEAD_BRANCH } }]));
  const r = await runMerge(['pr', 'merge', REF], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.deletedBranch, false);
  assert.deepEqual(r.json.children, [{ ref: 'powerhouse-inc/powerhouse#3302', base: HEAD_BRANCH }]);
  fake.expectNoCall(isRefGet);
  fake.expectNoCall(isRefDelete);
});

test('a head that is another PR’s base is not deleted; the child is listed', async () => {
  const fake = installMerge();
  fake.on(isChildren, okJson([{ number: 3302, base: { ref: HEAD_BRANCH } }]));
  const r = await runMerge(['pr', 'merge', REF, '--delete-branch'], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.deletedBranch, false);
  assert.deepEqual(r.json.children, [{ ref: 'powerhouse-inc/powerhouse#3302', base: HEAD_BRANCH }]);
  assert.match(warned(r, 'BRANCH_NOT_DELETED')?.message ?? '', /#3302 is based on fix\/reactor-bind-document-id/);
  fake.expectNoCall(isRefDelete);
});

test('a head from a fork gives a warning and no DELETE', async () => {
  const fake = installMerge(undefined, {
    pr: workedPr({ isCrossRepository: true, headRepository: { nameWithOwner: 'someone/powerhouse' } }),
  });
  const r = await runMerge(['pr', 'merge', REF, '--delete-branch'], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.deletedBranch, false);
  assert.match(warned(r, 'BRANCH_NOT_DELETED')?.message ?? '', /someone\/powerhouse:.* is in another repository/);
  fake.expectNoCall(isRefGet);
  fake.expectNoCall(isRefDelete);
});

test('a branch pushed to after the merge is kept (its ref is not at the merged head)', async () => {
  const fake = installMerge();
  fake.on(isRefGet, okJson({ ref: `refs/heads/${HEAD_BRANCH}`, object: { sha: MOVED_HEAD, type: 'commit' } }));
  const r = await runMerge(['pr', 'merge', REF, '--delete-branch'], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.deletedBranch, false);
  assert.match(warned(r, 'BRANCH_NOT_DELETED')?.message ?? '', /at d00dfee, not the merged head 9f2c4e1/);
  fake.expectNoCall(isRefDelete);
});

test('a branch GitHub already deleted is BRANCH_ALREADY_DELETED, not an error', async () => {
  const fake = installMerge();
  fake.on(isRefGet, {
    exitCode: 1,
    stdout: httpReply('HTTP/2.0 404 Not Found', '{"message":"Not Found"}'),
    stderr: 'gh: Not Found (HTTP 404)\n',
  });
  const r = await runMerge(['pr', 'merge', REF, '--delete-branch'], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.deletedBranch, false);
  assert.ok(warned(r, 'BRANCH_ALREADY_DELETED'));
  fake.expectNoCall(isRefDelete);
});

test('a failed DELETE is a warning; the merge still reports success (exit 0)', async () => {
  const fake = installMerge();
  fake.on(isRefDelete, {
    exitCode: 1,
    stdout: httpReply('HTTP/2.0 403 Forbidden', '{"message":"Resource not accessible by integration"}'),
    stderr: 'gh: Resource not accessible by integration (HTTP 403)\n',
  });
  const r = await runMerge(['pr', 'merge', REF, '--delete-branch'], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.merged, true);
  assert.equal(r.json.deletedBranch, false);
  assert.match(warned(r, 'BRANCH_DELETE_FAILED')?.message ?? '', /The merge itself succeeded/);
  assert.equal(deletes(fake).length, 1, 'a DELETE is never retried');
});

test('children that cannot be re-read fall back to the snapshot and keep the branch (fail closed)', async () => {
  const fake = installMerge();
  fake.on(isChildren, { exitCode: 1, stdout: '', stderr: 'gh: HTTP 403\n' });
  const r = await runMerge(['pr', 'merge', REF, '--delete-branch'], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.ok(warned(r, 'CHILDREN_UNKNOWN'));
  assert.match(warned(r, 'BRANCH_NOT_DELETED')?.message ?? '', /could not be read/);
  assert.equal(r.json.deletedBranch, false);
  fake.expectNoCall(isRefDelete);
});

test('runMerge never runs fake time past a slow job-log read, so the main comparison is not cut short', async () => {
  // The race behind the flaky BRANCH_ALREADY_DELETED test: fake time outran real log I/O, the 60 s comparison
  // budget expired, the shared red check lost its waiver and the merge was blocked.
  const fake = installMerge();
  slowReplies(fake, /\/actions\/jobs\/\d+\/logs$/, 300);
  const r = await runMerge(['pr', 'merge', REF, '--delete-branch'], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout.slice(0, 600));
  assert.equal(warned(r, 'DIAGNOSIS_PARTIAL'), undefined);
});
