// ghx pr merge where the base branch has a merge queue: GitHub refuses the REST merge there ("Changes must
// be made through the merge queue"), so the PR is added to the queue instead, pinned to the evaluated head
// with enqueuePullRequest's expectedHeadOid. Never a PUT; a repo without a queue merges exactly as before.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ENQUEUE_MUTATION } from '../../src/policy/merge.ts';
import { PrMergeOutput } from '../../src/pr/merge/schema.ts';
import { EXIT } from '../contract/exit-table.ts';
import type { FakeGh } from '../helpers/fake-gh.ts';
import {
  ENQUEUED_AT,
  enqueueReply,
  graphqlRefusal,
  isEnqueue,
  isQ1,
  isQueueRead,
  PR_NODE_ID,
  QUEUE_URL,
  q1Reply,
  queueFields,
  queueReadReply,
} from '../unit/pr/snapshot-fixture.ts';
import {
  CONFIG,
  HEAD,
  installMerge,
  isPut,
  isRefDelete,
  MERGE_COMMIT,
  MERGED_AT,
  MOVED_HEAD,
  put502,
  REF,
  runMerge,
  workedPr,
} from './pr-merge-world.ts';

const REBASE = { ...CONFIG, merge: { method: 'merge', allowedMethods: ['merge', 'rebase'] } };
const codes = (r: { json: any }) => (r.json.error.details.plan.blockers as { code: string }[]).map((b) => b.code);

/** The worked example behind a merge queue (rebase): the enqueue succeeds, the PR is then queued. */
function queueWorld(o: Parameters<typeof queueFields>[0] = {}, config: unknown = REBASE): FakeGh {
  const fake = installMerge(undefined, { pr: workedPr(queueFields(o)), config });
  fake.on(isEnqueue, enqueueReply());
  fake.on(isQueueRead, queueReadReply({ entry: { state: 'QUEUED', position: 1 } }));
  return fake;
}

const enqueues = (fake: FakeGh) =>
  fake.calls.filter((c) => isEnqueue(c.argv, c.stdin)).map((c) => JSON.parse(c.stdin ?? 'null'));

test('a base branch with a merge queue: the PR is enqueued pinned to the evaluated head, never PUT; queued, exit 0', async () => {
  const fake = queueWorld();
  const r = await runMerge(['pr', 'merge', REF, '--method', 'rebase'], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const out = PrMergeOutput.parse(r.json);
  assert.equal(out.merged, false);
  assert.equal(out.queued, true);
  assert.equal(out.mergeCommit, null);
  assert.equal(out.mergedAt, null);
  assert.equal(out.method, 'rebase');
  assert.equal(out.headSha, HEAD);
  assert.deepEqual(out.queue, {
    method: 'rebase',
    url: QUEUE_URL,
    alreadyQueued: false,
    state: 'QUEUED',
    position: 1,
    enqueuedAt: ENQUEUED_AT,
  });
  assert.equal(out.plan.via, 'queue');
  assert.deepEqual(out.headBranch, { state: 'present', deletedBy: null, autoDelete: false });
  assert.deepEqual(out.next, [`ghx pr land ${REF} --method rebase`]);
  // Exactly one mutation, and it is the plan's request: the head pin travels as expectedHeadOid.
  assert.deepEqual(enqueues(fake), [
    { query: ENQUEUE_MUTATION, variables: { input: { pullRequestId: PR_NODE_ID, expectedHeadOid: HEAD } } },
  ]);
  assert.deepEqual(out.plan.request, { method: 'POST', path: 'graphql', body: enqueues(fake)[0] });
  fake.expectNoCall(isPut);
});

test('--dry-run says the merge would go through the queue and prints the exact mutation; nothing is sent', async () => {
  const fake = queueWorld();
  const r = await runMerge(
    ['pr', 'merge', REF, '--method', 'rebase', '--expect-head', HEAD.slice(0, 7), '--dry-run'],
    fake,
  );
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.dryRun, true);
  assert.equal(r.json.preview.wouldMerge, false);
  assert.equal(r.json.preview.wouldQueue, true);
  assert.equal(r.json.preview.queue.method, 'rebase');
  const plan = r.json.preview.plan;
  assert.equal(plan.via, 'queue');
  assert.equal(plan.allowed, true);
  const [halted] = r.json.wouldRun;
  assert.ok(halted.argv.includes('graphql') && !halted.argv.includes('PUT'), halted.argv.join(' '));
  assert.deepEqual(JSON.parse(halted.stdin), plan.request.body);
  assert.equal(plan.request.body.variables.input.expectedHeadOid, HEAD);
  fake.expectNoMutations();
});

test("the queue decides the method: a request for another one is METHOD_NOT_ALLOWED (exit 6), naming the queue's", async () => {
  const fake = queueWorld();
  const r = await runMerge(['pr', 'merge', REF], fake);
  assert.equal(r.exitCode, EXIT.POLICY, r.stdout);
  assert.equal(r.json.error.code, 'MERGE_BLOCKED');
  assert.deepEqual(codes(r), ['METHOD_NOT_ALLOWED']);
  const blocker = r.json.error.details.plan.blockers[0];
  assert.match(blocker.message, /the merge queue for main merges with rebase/);
  assert.equal(blocker.details.queueMethod, 'rebase');
  assert.match(r.json.error.hint, /pass --method rebase\./);
  fake.expectNoMutations();
});

test("the queue's method still needs merge.allowedMethods: the hint says to ask the user", async () => {
  const fake = queueWorld({}, CONFIG);
  const r = await runMerge(['pr', 'merge', REF, '--method', 'rebase'], fake);
  assert.equal(r.exitCode, EXIT.POLICY, r.stdout);
  assert.deepEqual(codes(r), ['METHOD_NOT_ALLOWED']);
  assert.match(r.json.error.details.plan.blockers[0].message, /rebase is not in merge\.allowedMethods/);
  fake.expectNoMutations();
});

test("the repo's merge buttons do not apply to a queue: rebase disabled on the repo, the queue rebases", async () => {
  // q1Reply's repository has rebaseMergeAllowed: false; a direct rebase merge would be refused.
  const fake = queueWorld();
  fake.on(isQ1, q1Reply(workedPr(queueFields()), { rebaseMergeAllowed: false }));
  const r = await runMerge(['pr', 'merge', REF, '--method', 'rebase'], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.queued, true);
});

test('the head moves between the check and the enqueue: GitHub refuses the pinned mutation, HEAD_MOVED (exit 9), not re-sent', async () => {
  const fake = queueWorld();
  fake.on(isEnqueue, graphqlRefusal('Head branch was modified. Review and try the merge again.'));
  fake.on(isQueueRead, queueReadReply({ head: MOVED_HEAD }));
  const r = await runMerge(['pr', 'merge', REF, '--method', 'rebase'], fake);
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.equal(r.json.error.code, 'HEAD_MOVED');
  assert.equal(r.json.error.details.expected, HEAD);
  assert.equal(r.json.error.details.actual, MOVED_HEAD);
  assert.match(r.json.error.details.github, /Head branch was modified/);
  assert.match(r.json.error.hint, new RegExp(`--expect-head ${MOVED_HEAD.slice(0, 7)}`));
  assert.equal(enqueues(fake).length, 1, 'the mutation is never repeated after a refusal');
  assert.equal(enqueues(fake)[0].variables.input.expectedHeadOid, HEAD);
});

test('a stale --expect-head is HEAD_MOVED before anything is sent', async () => {
  const fake = queueWorld();
  const r = await runMerge(['pr', 'merge', REF, '--method', 'rebase', '--expect-head', MOVED_HEAD], fake);
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.equal(r.json.error.code, 'HEAD_MOVED');
  fake.expectNoMutations();
});

test('already in the queue at the evaluated head: nothing is sent; queued with alreadyQueued', async () => {
  const fake = queueWorld({ entry: { state: 'AWAITING_CHECKS', position: 2 } });
  const r = await runMerge(['pr', 'merge', REF, '--method', 'rebase'], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const out = PrMergeOutput.parse(r.json);
  assert.equal(out.queued, true);
  assert.equal(out.queue?.alreadyQueued, true);
  assert.equal(out.queue?.state, 'AWAITING_CHECKS');
  assert.equal(out.queue?.position, 2);
  fake.expectNoMutations();
});

test('GitHub refuses the enqueue with the head unchanged: MERGE_BLOCKED (exit 9) with its message, not re-sent', async () => {
  const fake = queueWorld();
  fake.on(isEnqueue, graphqlRefusal('Pull request is not ready to be added to the merge queue'));
  fake.on(isQueueRead, queueReadReply());
  const r = await runMerge(['pr', 'merge', REF, '--method', 'rebase'], fake);
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.equal(r.json.error.code, 'MERGE_BLOCKED');
  assert.deepEqual(codes(r), ['BLOCKED_BY_PROTECTION']);
  assert.match(
    r.json.error.details.plan.blockers[0].message,
    /refused to add .* to the merge queue: Pull request is not ready/,
  );
  assert.equal(enqueues(fake).length, 1);
});

test('a transient failure is re-read, not re-sent: found in the queue, it is a success', async () => {
  const fake = queueWorld();
  fake.on(isEnqueue, put502());
  fake.on(isQueueRead, queueReadReply({ entry: { state: 'QUEUED', position: 3 } }));
  const r = await runMerge(['pr', 'merge', REF, '--method', 'rebase'], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.queued, true);
  assert.equal(r.json.queue.alreadyQueued, true);
  assert.equal(r.json.queue.position, 3);
  assert.equal(enqueues(fake).length, 1);
});

test('a transient failure with the PR still open at the head and not queued gets exactly one more attempt', async () => {
  const fake = queueWorld();
  fake.on(isEnqueue, [put502(), enqueueReply({ state: 'QUEUED', position: 1 })]);
  fake.on(isQueueRead, queueReadReply());
  const r = await runMerge(['pr', 'merge', REF, '--method', 'rebase'], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.queue.alreadyQueued, false);
  assert.equal(enqueues(fake).length, 2);
});

test('merged at the head by the time a failed enqueue is re-read: merged with alreadyMerged', async () => {
  const fake = queueWorld();
  fake.on(isEnqueue, graphqlRefusal('Pull request is already merged'));
  fake.on(isQueueRead, queueReadReply({ state: 'MERGED', mergeCommit: MERGE_COMMIT, mergedAt: MERGED_AT }));
  const r = await runMerge(['pr', 'merge', REF, '--method', 'rebase'], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const out = PrMergeOutput.parse(r.json);
  assert.equal(out.merged, true);
  assert.equal(out.queued, false);
  assert.equal(out.alreadyMerged, true);
  assert.equal(out.mergeCommit, MERGE_COMMIT);
});

test('--delete-branch while queued: the branch is kept (it is what the queue merges), with a warning', async () => {
  const fake = queueWorld();
  const r = await runMerge(['pr', 'merge', REF, '--method', 'rebase', '--delete-branch'], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.deletedBranch, false);
  assert.match(JSON.stringify(r.json.warnings), /BRANCH_NOT_DELETED.*in the merge queue/);
  fake.expectNoCall(isRefDelete);
});

test('a repo without a merge queue merges exactly as before: the PUT, merged, queue null', async () => {
  const fake = installMerge();
  const r = await runMerge(['pr', 'merge', REF], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const out = PrMergeOutput.parse(r.json);
  assert.equal(out.merged, true);
  assert.equal(out.queued, false);
  assert.equal(out.queue, null);
  assert.equal(out.plan.via, 'merge');
  assert.deepEqual(out.plan.request, {
    method: 'PUT',
    path: 'repos/powerhouse-inc/powerhouse/pulls/3301/merge',
    body: { sha: HEAD, merge_method: 'merge' },
  });
  assert.equal(out.mergeCommit, MERGE_COMMIT);
  assert.equal(enqueues(fake).length, 0);
  fake.expectCalls([isPut]);
});
