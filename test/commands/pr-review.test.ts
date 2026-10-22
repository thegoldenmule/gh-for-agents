// ghx pr review (03 M11.2): self-review downgrade, hunk placement (FINDING_NOT_INLINE), path_not_in_pr,
// HEAD_MOVED, a 422 with no retry, dry-run, comment-id mapping, and a round trip through the fold.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { foldFeedback } from '../../src/feedback/fold.ts';
import { buildGraphqlArgs } from '../../src/gh/graphql.ts';
import { Q1_QUERY } from '../../src/pr/snapshot/query.ts';
import { EXIT } from '../contract/exit-table.ts';
import { FakeGh } from '../helpers/fake-gh.ts';
import { argvKey, GH_FIXTURE_ROOT } from '../helpers/fixture-match.ts';
import { runInProcess } from '../helpers/harness.ts';
import { snapshotConfig } from '../unit/pr/snapshot-fixture.ts';
import { HEAD, OLD_HEAD, PR_URL, REF, REVIEW_DB_ID, reply, sequence, writeScene } from './pr-comment-scene.ts';

const ARGV = ['pr', 'review', REF, '--input', '-'];
const run = (gh: FakeGh, input: unknown = REVIEW, extra: string[] = []) =>
  runInProcess([...ARGV, ...extra], { gh, stdin: JSON.stringify(input) });

/** 02 §14.3's review.json. */
const REVIEW = {
  verdict: 'request-changes',
  summary: 'The signing fix covers createDocument and addActions, but deleteDocument still signs without a documentId.',
  scope: '8 files on fix/reactor-bind-document-id plus the sign/verify call graph',
  findings: [
    {
      severity: 'high',
      path: 'packages/reactor/src/client/reactor-client.ts',
      line: 1071,
      alsoAt: [{ path: 'packages/reactor/src/client/reactor-client.ts', line: 1111 }],
      title: 'deleteDocument still signs without documentId',
      body: 'deleteDocument builds its action through the legacy helper, which never passes documentId to signAction, so a delete signature still verifies on any document.',
    },
    {
      severity: 'low',
      path: 'packages/shared/document-model/crypto.ts',
      line: 179,
      title: 'Rejection error does not name the documentId',
      body: 'The thrown error says "signature not bound" without the expected and actual documentId, which makes client logs hard to trace.',
    },
  ],
};

type Posted = {
  commit_id: string;
  event: string;
  body: string;
  comments: { path: string; body: string; line: number; side: string; start_line?: number }[];
};

test('self-review (02 §14.3): posted as COMMENT with verdictDowngraded, pinned to the head, ids mapped', async () => {
  const s = writeScene();
  const r = await run(s.gh);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(sequence(s.gh), ['q1', 'files', 'pull', 'post-review', 'review-comments']);
  const posted = s.sent['post-review']?.[0] as Posted;
  assert.equal(posted.event, 'COMMENT');
  assert.equal(posted.commit_id, HEAD);
  assert.deepEqual(
    posted.comments.map((c) => [c.path, c.line, c.side, c.start_line]),
    [
      ['packages/reactor/src/client/reactor-client.ts', 1071, 'RIGHT', undefined],
      ['packages/shared/document-model/crypto.ts', 179, 'RIGHT', undefined],
    ],
  );
  assert.ok(posted.body.startsWith('**ghx review** · request-changes · 2 findings (1 high, 0 medium, 1 low)\n\n'));
  assert.ok(posted.comments[0]?.body.startsWith('**[high] deleteDocument still signs without documentId**\n\n'));
  assert.match(posted.comments[0]?.body ?? '', /Also at: `packages\/reactor\/src\/client\/reactor-client\.ts:1111`/);

  const out = r.json;
  assert.equal(out.ref, REF);
  assert.match(out.id, /^r_[0-9a-hjkmnp-tv-z]{6}$/);
  assert.equal(out.githubReviewId, REVIEW_DB_ID);
  assert.equal(out.verdict, 'request-changes');
  assert.equal(out.postedAs, 'COMMENT');
  assert.equal(out.verdictDowngraded, true);
  assert.equal(out.commit, HEAD);
  assert.deepEqual(
    out.warnings.map((w: { code: string }) => w.code),
    ['VERDICT_DOWNGRADED'],
  );
  assert.equal(out.findings.length, 2);
  for (const [i, f] of out.findings.entries()) {
    assert.match(f.id, /^f_[0-9a-hjkmnp-tv-z]{6}$/);
    assert.equal(f.inline, true);
    assert.equal(f.commentId, 1834567890 + i);
    assert.equal(f.url, `${PR_URL}#discussion_r${1834567890 + i}`);
    assert.ok(posted.comments[i]?.body.includes(`"id":"${f.id}"`));
  }
  assert.deepEqual(
    out.findings.map((f: { severity: string }) => f.severity),
    ['high', 'low'],
  );
});

test("someone else's PR keeps the verdict: REQUEST_CHANGES, no warning", async () => {
  const s = writeScene({ viewer: 'maria-dev' });
  const r = await run(s.gh);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal((s.sent['post-review']?.[0] as Posted | undefined)?.event, 'REQUEST_CHANGES');
  assert.equal(r.json.postedAs, 'REQUEST_CHANGES');
  assert.equal(r.json.verdictDowngraded, false);
  assert.equal(r.json.warnings, undefined);
});

test('a comment verdict on your own PR is not a downgrade', async () => {
  const s = writeScene();
  const r = await run(s.gh, { ...REVIEW, verdict: 'comment' });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.verdictDowngraded, false);
  assert.equal(r.json.warnings, undefined);
});

test('placement outside a hunk, and on a file without a patch, goes in the body with FINDING_NOT_INLINE', async () => {
  const s = writeScene({ viewer: 'maria-dev' });
  const input = {
    verdict: 'comment',
    summary: 'Two placements.',
    findings: [
      { ...REVIEW.findings[1], line: 400, title: 'Outside every hunk' },
      { severity: 'medium', path: 'assets/logo.png', line: 1, title: 'Binary', body: 'No diff to anchor on.' },
      { ...REVIEW.findings[1], line: 175, endLine: 181, title: 'A range inside one hunk' },
    ],
  };
  const r = await run(s.gh, input);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const posted = s.sent['post-review']?.[0] as Posted;
  assert.deepEqual(
    posted.comments.map((c) => [c.start_line, c.line]),
    [[175, 181]],
  );
  assert.deepEqual(
    r.json.findings.map((f: { inline: boolean }) => f.inline),
    [false, false, true],
  );
  assert.deepEqual(
    r.json.warnings.map((w: { code: string }) => w.code),
    ['FINDING_NOT_INLINE', 'FINDING_NOT_INLINE'],
  );
  assert.match(r.json.warnings[0].message, /RIGHT line 400 is outside the diff hunks/);
  assert.match(r.json.warnings[1].message, /GitHub shows no diff for its file/);
  const [bodyOnly1, bodyOnly2] = r.json.findings;
  assert.equal(bodyOnly1.commentId, null);
  assert.equal(bodyOnly1.url, `${PR_URL}#pullrequestreview-${REVIEW_DB_ID}`);
  const blockLines = posted.body.split('\n').filter((l) => l.startsWith('<!-- ghx:v1 '));
  assert.equal(blockLines.length, 3, 'the review block plus one per body-only finding');
  assert.ok(blockLines[1]?.includes(`"id":"${bodyOnly1.id}"`));
  assert.ok(blockLines[2]?.includes(`"id":"${bodyOnly2.id}"`));
});

test('a path not in the diff is VALIDATION finding.path_not_in_pr, and nothing is posted', async () => {
  const s = writeScene();
  const r = await run(s.gh, { ...REVIEW, findings: [{ ...REVIEW.findings[1], path: 'src/elsewhere.ts' }] });
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  assert.equal(r.json.error.details.issues[0].code, 'finding.path_not_in_pr');
  assert.deepEqual(sequence(s.gh), ['q1', 'files']);
});

test('offline rules fail before any gh call', async () => {
  const s = writeScene();
  const r = await run(s.gh, { ...REVIEW, verdict: 'approve' });
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  assert.equal(r.json.error.details.issues[0].code, 'review.approve_with_high');
  assert.deepEqual(sequence(s.gh), []);
});

test('a stale --expect-head is HEAD_MOVED (9) with expected/actual; nothing is posted', async () => {
  const s = writeScene();
  const r = await run(s.gh, REVIEW, ['--expect-head', OLD_HEAD.slice(0, 7)]);
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.equal(r.json.error.code, 'HEAD_MOVED');
  assert.deepEqual(r.json.error.details, { expected: OLD_HEAD.slice(0, 7), actual: HEAD });
  assert.match(r.json.error.hint, /ghx pr status powerhouse-inc\/powerhouse#3301.*--expect-head 9f2c4e1/);
  assert.deepEqual(sequence(s.gh), ['q1']);

  const ok = writeScene();
  const r2 = await run(ok.gh, REVIEW, ['--expect-head', HEAD.slice(0, 7)]);
  assert.equal(r2.exitCode, EXIT.OK, r2.stdout);
  assert.equal((ok.sent['post-review']?.[0] as Posted | undefined)?.commit_id, HEAD);
});

test('a head that moves while the files are read is HEAD_MOVED (9); nothing is posted', async () => {
  const s = writeScene({ pullHead: 'c'.repeat(40) });
  const r = await run(s.gh, REVIEW);
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.equal(r.json.error.code, 'HEAD_MOVED');
  assert.deepEqual(r.json.error.details, { expected: HEAD, actual: 'c'.repeat(40) });
  assert.deepEqual(sequence(s.gh), ['q1', 'files', 'pull']);
  assert.equal(s.sent['post-review'], undefined);
});

test('a 422 is REVIEW_REJECTED (7), with no silent retry', async () => {
  const s = writeScene({
    reviewPost: reply(
      422,
      { message: 'Unprocessable Entity', errors: ['Line could not be resolved'] },
      'Unprocessable Entity',
    ),
  });
  const r = await run(s.gh);
  assert.equal(r.exitCode, EXIT.GH_FAILED, r.stdout);
  assert.equal(r.json.error.code, 'REVIEW_REJECTED');
  assert.match(r.json.error.message, /Line could not be resolved/);
  assert.deepEqual(sequence(s.gh), ['q1', 'files', 'pull', 'post-review']);
});

test('a failed comment read-back after the POST only warns; commentId is null', async () => {
  const s = writeScene({ reviewComments: reply(404, { message: 'Not Found' }, 'Not Found') });
  const r = await run(s.gh);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.ok(r.json.warnings.some((w: { code: string }) => w.code === 'REVIEW_COMMENTS_UNMAPPED'));
  assert.deepEqual(
    r.json.findings.map((f: { commentId: unknown }) => f.commentId),
    [null, null],
  );
});

test('a PR that is not open is PR_NOT_OPEN (9)', async () => {
  const s = writeScene({ pr: { state: 'MERGED' } });
  const r = await run(s.gh);
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.equal(r.json.error.code, 'PR_NOT_OPEN');
});

test('--dry-run reads and renders, halts at the POST: no mutation', async () => {
  const s = writeScene();
  const r = await run(s.gh, REVIEW, ['--dry-run']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.dryRun, true);
  assert.equal(r.json.preview.postedAs, 'COMMENT');
  assert.equal(r.json.preview.request.commit_id, HEAD);
  assert.equal(r.json.preview.request.comments.length, 2);
  assert.deepEqual(sequence(s.gh), ['q1', 'files', 'pull']);
  assert.equal(s.sent['post-review'], undefined);
});

test('round trip: the posted review and its inline comments fold into a structured review with open findings', async () => {
  const s = writeScene({ viewer: 'thegoldenmule' });
  const r = await run(s.gh, {
    ...REVIEW,
    findings: [...REVIEW.findings, { ...REVIEW.findings[1], line: 400, title: 'Body-only' }],
  });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const posted = s.sent['post-review']?.[0] as Posted;
  const author = { __typename: 'User', login: 'thegoldenmule' };
  const fold = foldFeedback({
    issueComments: [],
    reviews: [
      {
        databaseId: REVIEW_DB_ID,
        author,
        authorAssociation: 'MEMBER',
        body: posted.body,
        state: 'COMMENTED',
        submittedAt: '2026-10-22T10:00:00Z',
        createdAt: '2026-10-22T10:00:00Z',
        commit: { oid: HEAD },
        url: r.json.url,
      },
    ],
    reviewThreads: posted.comments.map((c, i) => ({
      isResolved: false,
      isOutdated: false,
      path: c.path,
      line: c.line,
      comments: {
        nodes: [
          {
            databaseId: 1834567890 + i,
            author,
            authorAssociation: 'MEMBER',
            body: c.body,
            createdAt: '2026-10-22T10:00:00Z',
            path: c.path,
            line: c.line,
            url: `${PR_URL}#discussion_r${1834567890 + i}`,
            pullRequestReview: { databaseId: REVIEW_DB_ID },
          },
        ],
      },
    })),
    viewerLogin: 'thegoldenmule',
    headSha: HEAD,
    config: snapshotConfig(),
  });
  assert.deepEqual(fold.warnings, []);
  const review = fold.feedback.reviews[0];
  assert.equal(review?.id, r.json.id);
  assert.equal(review?.structured, true);
  assert.equal(review?.verdict, 'request-changes');
  assert.equal(review?.verdictDowngraded, true);
  assert.deepEqual(
    fold.feedback.findings.map((f) => [f.id, f.inline, f.status, f.severity]),
    r.json.findings.map((f: { id: string; inline: boolean; severity: string }) => [f.id, f.inline, 'open', f.severity]),
  );
  assert.deepEqual(
    fold.openFindings,
    r.json.findings.map((f: { id: string }) => f.id),
  );
  assert.equal(fold.feedback.counts.findingsTotal, 3);
});

test('smoke/pr-review: the example halts in dry-run, and the fixture query matches the builder', async () => {
  const gh = FakeGh.fromScenario('smoke/pr-review');
  const example = (await import('../../src/commands/pr/review.ts')).default.examples?.[0];
  const r = await runInProcess(['pr', 'review', 'octo/demo#7', '--input', '-', '--dry-run'], {
    gh,
    stdin: JSON.stringify(example?.input),
  });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.dryRun, true);
  assert.equal(r.json.preview.request.comments.length, 1);
  const fixture = JSON.parse(readFileSync(join(GH_FIXTURE_ROOT, 'smoke/pr-review/001-q1.json'), 'utf8'));
  const built = buildGraphqlArgs(
    Q1_QUERY,
    { owner: 'octo', name: 'demo', number: 7, after: null },
    { repo: { host: 'github.com', owner: 'octo', name: 'demo' } },
  );
  assert.equal(argvKey(fixture.argv), argvKey(built.args));
});
