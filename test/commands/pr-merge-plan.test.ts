// ghx pr merge: the plan and --dry-run (02 §8.1 steps 1–6, §8.4; 03 M8.1). Every check runs and every
// violation is reported together; the plan's request is the exact PUT; --dry-run never mutates.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encode } from '../../src/meta/codec.ts';
import { EXIT } from '../contract/exit-table.ts';
import { FakeGh } from '../helpers/fake-gh.ts';
import { runInProcess } from '../helpers/harness.ts';
import { isPrCommits, isQ1, isQ2, prCommitsReply, q1Reply, q2Reply } from '../unit/pr/snapshot-fixture.ts';
import { CONFIG, HEAD, installMerge, isPut, OLD_HEAD, REF, runMerge, workedPr } from './pr-merge-world.ts';

const page = (nodes: unknown[]) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });
const codes = (r: { json: any }) => (r.json.error.details.plan.blockers as { code: string }[]).map((b) => b.code);

test('--dry-run: every check runs, the plan carries the exact PUT, and nothing is mutated', async () => {
  const fake = installMerge();
  const r = await runMerge(['pr', 'merge', REF, '--dry-run'], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.dryRun, true);
  const plan = r.json.preview.plan;
  assert.equal(r.json.preview.wouldMerge, true);
  assert.equal(plan.allowed, true);
  assert.equal(plan.headSha, HEAD);
  assert.deepEqual(plan.request, {
    method: 'PUT',
    path: 'repos/powerhouse-inc/powerhouse/pulls/3301/merge',
    body: { sha: HEAD, merge_method: 'merge' },
  });
  // The halted call is exactly the plan's request: same path, same body.
  const [halted] = r.json.wouldRun;
  assert.ok(halted.argv.includes('PUT') && halted.argv.includes(plan.request.path), halted.argv.join(' '));
  assert.deepEqual(JSON.parse(halted.stdin), plan.request.body);
  assert.ok(!halted.argv.includes('pr'), 'never gh pr merge');
  // All 18 checks are reported, the red check waived as shared with main.
  assert.equal(plan.checks.length, 18);
  assert.deepEqual(
    plan.waivers.map((w: { code: string }) => w.code),
    ['CI_RED'],
  );
  assert.ok(
    r.json.warnings.some((w: { code: string }) => w.code === 'FINDINGS_OPEN'),
    'the low finding warns',
  );
  fake.expectNoMutations();
  fake.expectNoCall(isPut);
});

test('smoke scenario: examples[0] --dry-run replays and halts at the PUT pinned to the head', async () => {
  const fake = FakeGh.fromScenario('smoke/pr-merge');
  const r = await runInProcess(
    ['pr', 'merge', '3301', '-R', 'powerhouse-inc/powerhouse', '--expect-head', '9f2c4e1', '--dry-run'],
    { gh: fake },
  );
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(JSON.parse(r.json.wouldRun[0].stdin).sha, HEAD);
  assert.equal(r.json.preview.plan.checks.find((c: { code: string }) => c.code === 'HEAD_MOVED').status, 'pass');
  fake.expectNoMutations();
});

test('--dry-run with pull-only access: NO_MERGE_PERMISSION blocks (exit 6), wouldMerge never true', async () => {
  const fake = installMerge();
  fake.on(isQ1, q1Reply(workedPr(), { viewerPermission: 'READ' }));
  const r = await runMerge(['pr', 'merge', REF, '--dry-run'], fake);
  assert.equal(r.exitCode, EXIT.POLICY, r.stdout);
  assert.equal(r.json.error.code, 'MERGE_BLOCKED');
  assert.deepEqual(codes(r), ['NO_MERGE_PERMISSION']);
  const blocker = r.json.error.details.plan.blockers[0];
  assert.equal(blocker.overridable, false);
  assert.match(blocker.message, /READ/);
  fake.expectNoMutations();
  fake.expectNoCall(isPut);
});

test('several violations are reported together; any policy-class blocker exits 6', async () => {
  const fake = installMerge(undefined, {
    pr: workedPr({ isDraft: true, author: { __typename: 'User', login: 'other-dev' } }),
    config: { ...CONFIG, merge: { method: 'merge', blockOnSeverity: 'low' } },
  });
  const r = await runMerge(['pr', 'merge', REF], fake);
  assert.equal(r.exitCode, EXIT.POLICY, r.stdout);
  assert.equal(r.json.error.code, 'MERGE_BLOCKED');
  assert.deepEqual(codes(r), ['PR_DRAFT', 'AUTHOR_NOT_VIEWER', 'FINDINGS_OPEN']);
  assert.equal(r.json.error.details.exitClass, 'policy');
  assert.match(r.json.error.message, /3 blockers: PR_DRAFT, AUTHOR_NOT_VIEWER, FINDINGS_OPEN/);
  fake.expectNoCall(isPut);
});

test('only state-class blockers exit 9 (BEHIND_BASE)', async () => {
  const fake = installMerge(undefined, { pr: workedPr({ mergeStateStatus: 'BEHIND' }) });
  const r = await runMerge(['pr', 'merge', REF], fake);
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.deepEqual(codes(r), ['BEHIND_BASE']);
  assert.equal(r.json.error.details.exitClass, 'state');
  assert.match(r.json.error.hint, /git fetch origin main && git merge origin\/main && git push/);
  fake.expectNoCall(isPut);
});

test('FINDINGS_OPEN: an open finding at merge.blockOnSeverity blocks (exit 6), lower ones only warn', async () => {
  const fake = installMerge(undefined, { config: { ...CONFIG, merge: { method: 'merge', blockOnSeverity: 'low' } } });
  const r = await runMerge(['pr', 'merge', REF], fake);
  assert.equal(r.exitCode, EXIT.POLICY, r.stdout);
  assert.deepEqual(codes(r), ['FINDINGS_OPEN']);
  assert.match(r.json.error.details.plan.blockers[0].message, /f_n2c6rv \(low\) is open/);
  fake.expectNoCall(isPut);
});

test('FINDINGS_OPEN fails closed: a high finding addressed in an unverified commit counts as open', async () => {
  const fake = installMerge();
  // PR commits read for another head: the addressed commit stays verified:null (04 decision).
  fake.on(isPrCommits, prCommitsReply([OLD_HEAD, HEAD], { head: 'e'.repeat(40) }));
  const r = await runMerge(['pr', 'merge', REF], fake);
  assert.equal(r.exitCode, EXIT.POLICY, r.stdout);
  assert.deepEqual(codes(r), ['FINDINGS_OPEN']);
  assert.match(
    r.json.error.details.plan.blockers[0].message,
    /f_h4x8pz \(high\) is marked addressed .* could not be verified/,
  );
  fake.expectNoCall(isPut);
});

test('PRECONDITION_UNMET: a pr-merged precondition on an open PR blocks', async () => {
  const precondition = encode({
    t: 'comment',
    id: 'c_p7q8r9',
    gen: 'ghx/0.1.0',
    kind: 'precondition',
    condition: { type: 'pr-merged', ref: '#3184' },
  });
  const comment = {
    databaseId: 77,
    author: { __typename: 'User', login: 'thegoldenmule' },
    authorAssociation: 'MEMBER',
    body: `Merge after #3184.\n\n${precondition}`,
    createdAt: '2026-10-21T15:00:00Z',
    url: 'https://github.com/powerhouse-inc/powerhouse/pull/3301#issuecomment-77',
  };
  const fake = installMerge(undefined, { pr: workedPr({ comments: page([comment]) }) });
  fake.on(
    isQ2,
    q2Reply({ children: { nodes: [] }, ref0: { number: 3184, state: 'OPEN', mergedAt: null, mergeCommit: null } }),
  );
  const r = await runMerge(['pr', 'merge', REF], fake);
  assert.equal(r.exitCode, EXIT.POLICY, r.stdout);
  assert.deepEqual(codes(r), ['PRECONDITION_UNMET']);
  assert.match(r.json.error.hint, /ghx pr resolve .* --status met/);
  fake.expectNoCall(isPut);
});

test('a closed PR is PR_NOT_OPEN (state, exit 9)', async () => {
  const fake = installMerge(undefined, { pr: workedPr({ state: 'CLOSED' }) });
  const r = await runMerge(['pr', 'merge', REF], fake);
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.ok(codes(r).includes('PR_NOT_OPEN'));
  fake.expectNoCall(isPut);
});

test('overrides: an unknown code or a missing --reason is VALIDATION before any gh call', async () => {
  for (const argv of [
    ['--override', 'NOT_A_CODE', '--reason', 'x'],
    ['--override', 'FINDINGS_OPEN'],
    ['--override', 'CI_PENDING', '--reason', 'user asked'],
  ]) {
    const fake = installMerge();
    const r = await runMerge(['pr', 'merge', REF, ...argv], fake);
    assert.equal(r.exitCode, EXIT.USAGE, `${argv.join(' ')}: ${r.stdout}`);
    assert.equal(r.json.error.code, 'VALIDATION');
    assert.equal(fake.calls.length, 0, 'no gh call');
  }
});

test('an override that had no effect warns OVERRIDE_UNUSED and the merge still proceeds', async () => {
  const fake = installMerge();
  const r = await runMerge(
    ['pr', 'merge', REF, '--override', 'CHANGES_REQUESTED', '--reason', 'user asked', '--dry-run'],
    fake,
  );
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.dryRun, true);
  assert.ok(r.json.warnings.some((w: { code: string }) => w.code === 'OVERRIDE_UNUSED'));
  assert.deepEqual(r.json.preview.plan.overrides, []);
});

test('no .github/ghx.json is CONFIG_MISSING (exit 3) and nothing is merged', async () => {
  const fake = installMerge(undefined, { config: null });
  const r = await runMerge(['pr', 'merge', REF], fake);
  assert.equal(r.exitCode, EXIT.CONFIG, r.stdout);
  assert.equal(r.json.error.code, 'CONFIG_MISSING');
  fake.expectNoCall(isPut);
  fake.expectNoCall(isQ1);
});

test('the viewer reads from Q1: a PR by the viewer passes AUTHOR_NOT_VIEWER', async () => {
  const fake = installMerge();
  fake.on(isQ1, q1Reply(workedPr()));
  const r = await runMerge(['pr', 'merge', REF, '--dry-run'], fake);
  const check = r.json.preview.plan.checks.find((c: { code: string }) => c.code === 'AUTHOR_NOT_VIEWER');
  assert.deepEqual([check.status, check.message], ['pass', 'author thegoldenmule is you']);
});
