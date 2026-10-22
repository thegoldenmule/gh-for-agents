// fetchPrSnapshot over scripted Q1/Q2 replies (03 M6.3). Drives createGh over FakeGh directly: no command yet.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snapshotSummary } from '../../../src/ci/snapshot.ts';
import { isGhxError } from '../../../src/core/errors.ts';
import type { FeedbackInput } from '../../../src/feedback/fold.ts';
import { encode } from '../../../src/meta/codec.ts';
import { fetchPrSnapshot, loadSnapshotFeedback } from '../../../src/pr/snapshot/index.ts';
import { connectionPageQuery, Q1_QUERY } from '../../../src/pr/snapshot/query.ts';
import { ciEnv, ok } from '../ci/_helpers.ts';
import { readJson } from '../feedback/_fixture.ts';
import {
  checkRun,
  HEAD,
  isPrCommits,
  isQ1,
  isQ2,
  OLD_HEAD,
  prCommitsReply,
  q1Pr,
  q1Reply,
  q2Reply,
  REPO,
  snapshotConfig,
} from './snapshot-fixture.ts';

const fetch = (env: ReturnType<typeof ciEnv>, extra: Partial<Parameters<typeof fetchPrSnapshot>[0]> = {}) =>
  fetchPrSnapshot({ gh: env.gh, clock: env.clock, repo: REPO, number: 3301, config: snapshotConfig(), ...extra });

const page = (nodes: unknown[], next: string | null = null) => ({
  pageInfo: { hasNextPage: next !== null, endCursor: next },
  nodes,
});

test('Q1 embeds CI_COMMIT_FIELDS and every connection the fold reads', () => {
  for (const s of [
    'statusCheckRollup',
    'isRequired(pullRequestNumber:$number)',
    'reviewThreads(first:100)',
    'timelineItems(',
  ]) {
    assert.ok(Q1_QUERY.includes(s), s);
  }
  assert.ok(Q1_QUERY.includes('AUTOMATIC_BASE_CHANGE_SUCCEEDED_EVENT'));
  assert.ok(Q1_QUERY.includes('author{__typename login}'));
});

test('a green PR costs 2 GraphQL calls (Q1 + Q2) and maps every field', async () => {
  const env = ciEnv();
  env.fake.on(isQ1, q1Reply()).on(isQ2, q2Reply({ children: { nodes: [] } }));
  const s = await fetch(env);
  assert.equal(s.queries, 2);
  assert.equal(env.fake.calls.length, 2);
  assert.equal(s.ref, 'powerhouse-inc/powerhouse#3301');
  assert.deepEqual(s.author, { login: 'thegoldenmule', isViewer: true, isBot: false, association: 'MEMBER' });
  assert.deepEqual(s.base, { ref: 'main', sha: s.base.sha, isDefault: true });
  assert.equal(s.head.sha, HEAD);
  assert.deepEqual(s.merge, {
    mergeable: 'MERGEABLE',
    settled: true,
    mergeStateStatus: 'CLEAN',
    reviewDecision: null,
    mergedAt: null,
    mergeCommit: null,
    retries: 0,
  });
  assert.deepEqual(s.repoSettings, {
    mergeCommitAllowed: true,
    squashMergeAllowed: true,
    rebaseMergeAllowed: false,
    deleteBranchOnMerge: false,
  });
  assert.equal(s.ci.forHeadSha, true);
  assert.equal(snapshotSummary(s.ci).state, 'green');
  assert.equal(s.meta.status, 'absent');
  assert.deepEqual(s.stack, { parent: null, declaredParent: null, children: [], baseChanges: [] });
  assert.deepEqual(s.warnings, []);
  assert.equal(s.fetchedAt, '2026-10-22T12:00:00.000Z');
  env.fake.expectNoMutations();
});

test('[G-SHA] a rollup for another commit is re-queried once, then reported pending with CI_SHA_MISMATCH', async () => {
  const stale = q1Reply(q1Pr({}, { rollupOid: OLD_HEAD }));
  const env = ciEnv();
  env.fake.on(isQ1, [stale, q1Reply()]).on(isQ2, q2Reply());
  const s = await fetch(env);
  assert.equal(s.ci.forHeadSha, true);
  assert.equal(s.queries, 3);

  const env2 = ciEnv();
  env2.fake.on(isQ1, stale).on(isQ2, q2Reply());
  const s2 = await fetch(env2);
  assert.equal(s2.ci.forHeadSha, false);
  assert.deepEqual(s2.ci.checks, []);
  assert.deepEqual(
    s2.warnings.map((w) => w.code),
    ['CI_SHA_MISMATCH'],
  );
  const sum = snapshotSummary(s2.ci);
  assert.equal(sum.state, 'pending');
  assert.equal(sum.headSha, HEAD);
});

test('connections with hasNextPage are followed with a per-connection query', async () => {
  const c = (id: number) => ({
    databaseId: id,
    author: { __typename: 'User', login: 'maria-dev' },
    authorAssociation: 'MEMBER',
    body: `comment ${id}`,
    createdAt: `2026-10-21T16:0${id}:00Z`,
    url: `https://github.com/powerhouse-inc/powerhouse/pull/3301#issuecomment-${id}`,
  });
  const env = ciEnv();
  const pageQuery = connectionPageQuery('comments');
  env.fake
    .on(isQ1, q1Reply(q1Pr({ comments: page([c(1)], 'CUR1') })))
    .on(
      (argv) => argv.includes(`query=${pageQuery}`) && argv.includes('after=CUR1'),
      [ok({ data: { repository: { pullRequest: { comments: page([c(2)]) } } } })],
    )
    .on(isQ2, q2Reply());
  const s = await fetch(env);
  assert.deepEqual(
    s.feedback.feedback.comments.map((x) => x.id),
    ['ic:1', 'ic:2'],
  );
  assert.equal(s.queries, 3);
});

test('feedback past MAX_PAGES sets feedbackTruncated, so merge policy fails closed', async () => {
  const c = {
    databaseId: 1,
    author: { __typename: 'User', login: 'maria-dev' },
    authorAssociation: 'MEMBER',
    body: 'comment',
    createdAt: '2026-10-21T16:01:00Z',
    url: 'https://github.com/powerhouse-inc/powerhouse/pull/3301#issuecomment-1',
  };
  const env = ciEnv();
  const pageQuery = connectionPageQuery('comments');
  env.fake
    .on(isQ1, q1Reply(q1Pr({ comments: page([c], 'CUR') })))
    .on(
      (argv) => argv.includes(`query=${pageQuery}`),
      [ok({ data: { repository: { pullRequest: { comments: page([c], 'CUR') } } } })],
    )
    .on(isQ2, q2Reply());
  const s = await fetch(env);
  assert.equal(s.feedbackTruncated, true);
  assert.ok(s.warnings.some((w) => w.code === 'FEEDBACK_TRUNCATED'));
  const clean = ciEnv();
  clean.fake.on(isQ1, q1Reply()).on(isQ2, q2Reply());
  assert.equal((await fetch(clean)).feedbackTruncated, false);
});

test('a missing PR is PR_NOT_FOUND', async () => {
  const env = ciEnv();
  env.fake.on(isQ1, q1Reply(null));
  await assert.rejects(fetch(env), (e) => isGhxError(e) && e.code === 'PR_NOT_FOUND');
});

/** The 02 §14.3 worked example as Q1 connections. */
function workedExamplePr() {
  const input = readJson('worked-example-3301.input.json') as {
    issueComments: unknown[];
    reviews: unknown[];
    reviewThreads: { comments: { nodes: unknown[] } }[];
  };
  return q1Pr({
    comments: page(input.issueComments),
    reviews: page(input.reviews),
    reviewThreads: page(input.reviewThreads.map((t, i) => ({ ...t, id: `T${i}`, comments: page(t.comments.nodes) }))),
  });
}

test('02 §14.5: the worked example folds to the golden feedback, verifying f_h4x8pz against the PR commits', async () => {
  const env = ciEnv();
  env.fake
    .on(isQ1, q1Reply(workedExamplePr()))
    .on(isQ2, q2Reply())
    .on(isPrCommits, prCommitsReply([OLD_HEAD, HEAD]));
  const s = await fetch(env);
  const golden = readJson('worked-example-3301.golden.json') as Record<string, unknown>;
  assert.deepEqual(
    { feedback: s.feedback.feedback, openFindings: s.feedback.openFindings, preconditions: s.feedback.preconditions },
    golden,
  );
  assert.equal(s.queries, 3);
});

test('an addressed commit that left the PR (force-push) reopens the finding', async () => {
  const env = ciEnv();
  env.fake
    .on(isQ1, q1Reply(workedExamplePr()))
    .on(isQ2, q2Reply())
    .on(isPrCommits, prCommitsReply([OLD_HEAD]));
  const s = await fetch(env);
  const f = s.feedback.feedback.findings.find((x) => x.id === 'f_h4x8pz');
  assert.deepEqual([f?.status, f?.statusEvent?.verified], ['open', false]);
  assert.ok(s.feedback.warnings.some((w) => w.code === 'EVENT_COMMIT_UNREACHABLE'));
});

test('PR commits read for another head leave the event unverified (fail closed downstream)', async () => {
  const env = ciEnv();
  env.fake
    .on(isQ1, q1Reply(workedExamplePr()))
    .on(isQ2, q2Reply())
    .on(isPrCommits, prCommitsReply([OLD_HEAD, HEAD], { head: 'e'.repeat(40) }));
  const s = await fetch(env);
  const f = s.feedback.feedback.findings.find((x) => x.id === 'f_h4x8pz');
  assert.deepEqual([f?.status, f?.statusEvent?.verified], ['addressed', null]);
});

test('preconditions: a pr-merged ref is evaluated from its Q2 alias', async () => {
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
  const env = ciEnv();
  env.fake
    .on(isQ1, q1Reply(q1Pr({ comments: page([comment]) })))
    .on(
      isQ2,
      q2Reply({ ref0: { number: 3184, state: 'MERGED', mergedAt: '2026-10-21T15:30:00Z', mergeCommit: null } }),
    );
  const s = await fetch(env);
  assert.deepEqual(
    s.feedback.preconditions.map((p) => [p.id, p.status, p.evidence]),
    [['c_p7q8r9', 'met', '#3184 merged at 2026-10-21T15:30:00Z']],
  );
  const q2 = env.fake.calls.find((c) => isQ2(c.argv));
  assert.match(q2?.argv.find((a) => a.startsWith('query=')) ?? '', /ref0:pullRequest\(number:3184\)/);
});

test('loadSnapshotFeedback verifies every blocking-severity addressed commit, then caps the rest at 10', async () => {
  const sha = (i: number) => i.toString(16).padStart(40, '0');
  const findings = Array.from({ length: 12 }, (_, i) => ({
    t: 'finding',
    id: `f_${'abcdefghjkmn'[i]}00000`,
    gen: 'ghx/0.1.0',
    review: 'r_7tq2wd',
    // The high one comes last, so a plain first-10 cap would leave it unverified.
    severity: i === 11 ? 'high' : 'low',
    path: 'a.ts',
    line: i + 1,
    title: `finding ${i}`,
    body: 'b',
    commit: HEAD,
  }));
  const review = encode({
    t: 'review',
    id: 'r_7tq2wd',
    gen: 'ghx/0.1.0',
    verdict: 'comment',
    summary: 's',
    commit: HEAD,
    findings: findings.map((f) => f.id),
  });
  const resolves = encode({
    t: 'comment',
    id: 'c_w5j1ve',
    gen: 'ghx/0.1.0',
    kind: 'resolve',
    targets: findings.map((f, i) => ({ id: f.id, status: 'addressed', commit: sha(i + 1) })),
  });
  const author = { __typename: 'User', login: 'thegoldenmule' };
  const input: FeedbackInput = {
    issueComments: [
      {
        databaseId: 2,
        author,
        authorAssociation: 'MEMBER',
        body: resolves,
        createdAt: '2026-10-21T16:00:00Z',
        url: 'https://x/2',
      },
    ],
    reviews: [
      {
        databaseId: 1,
        author,
        authorAssociation: 'MEMBER',
        body: `${review}\n${findings.map((f) => encode(f)).join('\n')}`,
        createdAt: '2026-10-21T15:00:00Z',
        submittedAt: '2026-10-21T15:00:00Z',
        state: 'COMMENTED',
        commit: { oid: HEAD },
        url: 'https://x/1',
      },
    ],
    reviewThreads: [],
    viewerLogin: 'thegoldenmule',
    headSha: HEAD,
    config: { trust: snapshotConfig().trust, bots: snapshotConfig().bots },
  };
  const asked: string[] = [];
  const r = await loadSnapshotFeedback(
    input,
    {
      async commitInPr(s) {
        asked.push(s);
        return true;
      },
      async condition() {
        return { status: 'unknown', evidence: '' };
      },
    },
    'high',
  );
  assert.equal(asked.length, 11);
  assert.equal(asked[0], sha(12));
  const high = r.feedback.findings.find((f) => f.severity === 'high');
  assert.equal(high?.statusEvent?.verified, true);
  assert.equal(r.feedback.findings.filter((f) => f.statusEvent?.verified === null).length, 1);
});

test('rollup pages beyond the first are read with the CI module query; a push between pages is a mismatch', async () => {
  const env = ciEnv();
  const first = q1Pr({}, { contexts: [checkRun('a', 'SUCCESS', { id: 1 })] });
  (
    first.commits.nodes[0] as { commit: { statusCheckRollup: { contexts: unknown } } }
  ).commit.statusCheckRollup.contexts = page([checkRun('a', 'SUCCESS', { id: 1 })], 'C1');
  const rollupPage = (head: string) =>
    ok({
      data: {
        repository: {
          defaultBranchRef: { name: 'main' },
          pullRequest: {
            headRefOid: head,
            commits: {
              nodes: [
                { commit: { oid: head, statusCheckRollup: { contexts: page([checkRun('b', 'FAILURE', { id: 2 })]) } } },
              ],
            },
          },
        },
      },
    });
  const isRollupPage = (argv: string[]) => argv.includes('after=C1');
  env.fake.on(isQ1, q1Reply(first)).on(isRollupPage, rollupPage(HEAD)).on(isQ2, q2Reply());
  const s = await fetch(env);
  assert.deepEqual(
    s.ci.checks.map((c) => c.name),
    ['a', 'b'],
  );
  assert.equal(snapshotSummary(s.ci).state, 'red');

  const env2 = ciEnv();
  env2.fake
    .on(isQ1, q1Reply(first))
    .on(isRollupPage, rollupPage('e'.repeat(40)))
    .on(isQ2, q2Reply());
  const s2 = await fetch(env2);
  assert.equal(s2.ci.forHeadSha, false);
  assert.ok(s2.warnings.some((w) => w.code === 'CI_SHA_MISMATCH'));
});
