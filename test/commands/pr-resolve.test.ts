// ghx pr resolve (03 M11.3): append-only status events. addressed needs a commit in the PR (expanded to the
// full SHA); note-required statuses; an inline finding gets a thread reply plus a best-effort
// resolveReviewThread (THREAD_RESOLVE_FAILED only warns); ALREADY_IN_STATUS posts nothing; an untrusted
// id is ID_NOT_FOUND; dry-run; and a round trip through the fold.
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
import {
  HEAD,
  OLD_HEAD,
  PR_URL,
  REF,
  reply,
  sequence,
  type WriteSceneOptions,
  writeScene,
} from './pr-comment-scene.ts';

type Node = Record<string, unknown> & { body: string };
const WORKED = JSON.parse(
  readFileSync(join(import.meta.dirname, '../fixtures/feedback/worked-example-3301.input.json'), 'utf8'),
) as {
  reviews: Node[];
  reviewThreads: { isResolved: boolean; isOutdated: boolean; path: string; comments: { nodes: Node[] } }[];
};
const conn = (nodes: unknown[]) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });
const member = { __typename: 'User', login: 'thegoldenmule' };

/** A manual precondition comment, from a MEMBER or (untrusted) a CONTRIBUTOR. */
function preconditionComment(id: string, association: string, dbId: number, extra = ''): Node {
  return {
    databaseId: dbId,
    author: association === 'MEMBER' ? member : { __typename: 'User', login: 'drive-by' },
    authorAssociation: association,
    body: `**Merge precondition:** Ops signs off.\n\n<!-- ghx:v1 {"condition":{"text":"Ops signs off.","type":"manual"},"gen":"ghx/0.1.0","id":"${id}","kind":"precondition","t":"comment"} -->${extra}`,
    createdAt: '2026-10-21T15:00:00Z',
    lastEditedAt: null,
    url: `${PR_URL}#issuecomment-${dbId}`,
  };
}

/** The worked example after the review and before the fix: two open inline findings, unresolved threads. */
function prState(o: { extraComments?: Node[]; resolvedThread?: boolean } = {}): NonNullable<WriteSceneOptions['pr']> {
  return {
    reviews: conn([WORKED.reviews[0]]),
    reviewThreads: conn(
      WORKED.reviewThreads.map((t, i) => ({
        id: `PRRT_thread${i}`,
        isResolved: o.resolvedThread ?? false,
        isOutdated: false,
        path: t.path,
        line: null,
        comments: conn([t.comments.nodes[0]]),
      })),
    ),
    comments: conn([preconditionComment('c_a1b2c3', 'MEMBER', 2401000001), ...(o.extraComments ?? [])]),
  };
}

const run = (s: { gh: FakeGh }, args: string[]) => runInProcess(['pr', 'resolve', REF, ...args], { gh: s.gh });

test('02 §14.3: addressed on an inline finding: thread reply with the full SHA, then the thread resolved', async () => {
  const s = writeScene({ pr: prState() });
  const r = await run(s, ['f_h4x8pz', '--status', 'addressed', '--commit', '9f2c4e1']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(sequence(s.gh), ['config', 'q1', 'commits', 'reply', 'resolve']);
  const replyCall = s.gh.calls.find((c) => c.argv.some((a) => a.endsWith('/replies')));
  assert.ok(replyCall?.argv.includes('repos/powerhouse-inc/powerhouse/pulls/3301/comments/1834567890/replies'));
  const body = String(s.sent.reply?.[0]?.body);
  assert.match(
    body,
    new RegExp(
      `^Addressed in 9f2c4e1\\.\\n\\n<!-- ghx:v1 \\{"gen":"ghx/[^"]+","id":"c_[0-9a-hjkmnp-tv-z]{6}","kind":"resolve","t":"comment","targets":\\[\\{"commit":"${HEAD}","id":"f_h4x8pz","status":"addressed"\\}\\]\\} -->$`,
    ),
  );
  assert.match(String(s.gh.calls.at(-1)?.stdin), /"threadId":"PRRT_thread0"/);
  assert.deepEqual(r.json.events, [
    {
      id: 'f_h4x8pz',
      from: 'open',
      to: 'addressed',
      commentId: r.json.events[0].commentId,
      url: r.json.events[0].url,
      threadResolved: true,
    },
  ]);
  assert.equal(r.json.warnings, undefined);
});

test('addressed needs a commit reachable from the head and not from the base (resolve.commit_not_in_pr)', async () => {
  const s = writeScene({ pr: prState(), commits: [OLD_HEAD, HEAD] });
  const r = await run(s, ['f_h4x8pz', '--status', 'addressed', '--commit', 'c0ffee1']);
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  assert.equal(r.json.error.code, 'VALIDATION');
  assert.equal(r.json.error.details.issues[0].code, 'resolve.commit_not_in_pr');
  assert.deepEqual(sequence(s.gh), ['config', 'q1', 'commits']);

  const missing = writeScene({ pr: prState() });
  const r2 = await run(missing, ['f_h4x8pz', '--status', 'addressed']);
  assert.equal(r2.json.error.details.issues[0].code, 'resolve.commit_required');
  assert.deepEqual(sequence(missing.gh), []);

  const ambiguous = writeScene({
    pr: prState(),
    commits: [`${'d'.repeat(8)}${'1'.repeat(32)}`, `${'d'.repeat(8)}${'2'.repeat(32)}`],
  });
  const r3 = await run(ambiguous, ['f_h4x8pz', '--status', 'addressed', '--commit', 'ddddddd']);
  assert.equal(r3.json.error.details.issues[0].code, 'resolve.commit_ambiguous');
});

test('wontfix, deferred, met and withdrawn need --note; one line of ≤200 chars', async () => {
  for (const [id, status] of [
    ['f_n2c6rv', 'wontfix'],
    ['f_n2c6rv', 'deferred'],
    ['c_a1b2c3', 'met'],
    ['c_a1b2c3', 'withdrawn'],
  ]) {
    const s = writeScene({ pr: prState() });
    const r = await run(s, [id as string, '--status', status as string]);
    assert.equal(r.json.error?.details.issues[0].code, 'resolve.note_required', status);
    assert.deepEqual(sequence(s.gh), []);
  }
  const long = await run(writeScene({ pr: prState() }), ['f_n2c6rv', '--status', 'wontfix', '--note', 'x'.repeat(201)]);
  assert.equal(long.json.error.code, 'VALIDATION');
  const ok = await run(writeScene({ pr: prState() }), ['f_n2c6rv', '--status', 'wontfix', '--note', 'x'.repeat(200)]);
  assert.equal(ok.exitCode, EXIT.OK, ok.stdout);
});

test('a finding takes finding statuses only; a precondition takes met, withdrawn or unmet', async () => {
  const s = writeScene({ pr: prState() });
  const r = await run(s, ['c_a1b2c3', '--status', 'addressed', '--commit', '9f2c4e1']);
  assert.equal(r.json.error.details.issues[0].code, 'resolve.status_not_allowed');
  const r2 = await run(writeScene({ pr: prState() }), ['f_h4x8pz', '--status', 'met', '--note', 'x']);
  assert.equal(r2.json.error.details.issues[0].code, 'resolve.status_not_allowed');
});

test('a manual precondition is set met with one issue comment, led by its id', async () => {
  const s = writeScene({ pr: prState() });
  const r = await run(s, ['c_a1b2c3', '--status', 'met', '--note', 'Ops confirmed the window.']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(sequence(s.gh), ['config', 'q1', 'post-comment']);
  assert.match(
    String(s.sent['post-comment']?.[0]?.body),
    /^`c_a1b2c3` Met: Ops confirmed the window\.\n\n<!-- ghx:v1 /,
  );
  assert.equal(r.json.events[0].from, 'unknown');
  assert.equal(r.json.events[0].threadResolved, null);
});

test('several ids: each inline finding gets its own reply; open unresolves a resolved thread', async () => {
  const addressed: Node = {
    databaseId: 2401000008,
    author: member,
    authorAssociation: 'MEMBER',
    body: `x\n\n<!-- ghx:v1 {"gen":"ghx/0.1.0","id":"c_p9z4r3","kind":"resolve","t":"comment","targets":[{"commit":"${HEAD}","id":"f_h4x8pz","status":"addressed"},{"commit":"${HEAD}","id":"f_n2c6rv","status":"addressed"}]} -->`,
    createdAt: '2026-10-21T17:00:00Z',
    lastEditedAt: null,
    url: `${PR_URL}#issuecomment-2401000008`,
  };
  const s = writeScene({ pr: prState({ resolvedThread: true, extraComments: [addressed] }) });
  const r = await run(s, ['f_n2c6rv', 'f_h4x8pz', '--status', 'open', '--note', 'The fix was reverted.']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(sequence(s.gh), ['config', 'q1', 'reply', 'unresolve', 'reply', 'unresolve']);
  assert.deepEqual(
    r.json.events.map((e: { id: string; threadResolved: boolean }) => [e.id, e.threadResolved]),
    [
      ['f_n2c6rv', false],
      ['f_h4x8pz', false],
    ],
  );
  assert.deepEqual(
    r.json.events.map((e: { from: string; to: string }) => [e.from, e.to]),
    [
      ['addressed', 'open'],
      ['addressed', 'open'],
    ],
  );
  assert.match(String(s.sent.reply?.[0]?.body), /^Reopened\. The fix was reverted\.\n\n/);
});

test('a failed resolveReviewThread only warns THREAD_RESOLVE_FAILED; the event stands', async () => {
  const s = writeScene({
    pr: prState(),
    threadMutation: {
      ...reply(200, { data: null, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] }),
      exitCode: 1,
    },
  });
  const r = await run(s, ['f_h4x8pz', '--status', 'addressed', '--commit', HEAD]);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(
    r.json.warnings.map((w: { code: string }) => w.code),
    ['THREAD_RESOLVE_FAILED'],
  );
  assert.equal(r.json.events[0].threadResolved, false);
  assert.equal(s.sent.reply?.length, 1);
});

test('setting the status an item already has warns ALREADY_IN_STATUS and posts nothing', async () => {
  const resolved = (status: string, note: string) =>
    ({
      databaseId: 2401000009,
      author: member,
      authorAssociation: 'MEMBER',
      body: `\`f_n2c6rv\` x\n\n<!-- ghx:v1 {"gen":"ghx/0.1.0","id":"c_p9z4r2","kind":"resolve","t":"comment","targets":[{"id":"f_n2c6rv","note":"${note}","status":"${status}"}]} -->`,
      createdAt: '2026-10-21T17:00:00Z',
      lastEditedAt: null,
      url: `${PR_URL}#issuecomment-2401000009`,
    }) as Node;
  const s = writeScene({ pr: prState({ extraComments: [resolved('wontfix', 'Logged upstream.')] }) });
  const r = await run(s, ['f_n2c6rv', '--status', 'wontfix', '--note', 'Still logged upstream.']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(r.json.events, []);
  assert.deepEqual(
    r.json.warnings.map((w: { code: string }) => w.code),
    ['ALREADY_IN_STATUS'],
  );
  assert.deepEqual(sequence(s.gh), ['config', 'q1']);
});

test('an untrusted or unknown id is ID_NOT_FOUND (5), with the known ids', async () => {
  const forged = preconditionComment('c_zz9zz9', 'CONTRIBUTOR', 2401000005);
  const s = writeScene({ pr: prState({ extraComments: [forged] }) });
  const r = await run(s, ['c_zz9zz9', '--status', 'withdrawn', '--note', 'not needed']);
  assert.equal(r.exitCode, EXIT.NOT_FOUND, r.stdout);
  assert.equal(r.json.error.code, 'ID_NOT_FOUND');
  assert.deepEqual(r.json.error.details.missing, ['c_zz9zz9']);
  assert.deepEqual(r.json.error.details.known, ['f_h4x8pz', 'f_n2c6rv', 'c_a1b2c3']);
  assert.match(r.json.error.hint, /ghx pr feedback powerhouse-inc\/powerhouse#3301 --open/);
  assert.deepEqual(sequence(s.gh), ['config', 'q1']);
  const r2 = await run(writeScene({ pr: prState() }), ['f_zzzzzz', '--status', 'open']);
  assert.equal(r2.json.error.code, 'ID_NOT_FOUND');
});

test('--dry-run reads and renders, halts at the first POST: no mutation', async () => {
  const s = writeScene({ pr: prState() });
  const r = await run(s, ['f_h4x8pz', 'f_n2c6rv', '--status', 'addressed', '--commit', '9f2c4e1', '--dry-run']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.dryRun, true);
  assert.equal(r.json.preview.replies.length, 2);
  assert.deepEqual(sequence(s.gh), ['config', 'q1', 'commits']);
  assert.equal(s.sent.reply, undefined);
});

test('round trip: the reply folds into status addressed, verified against the PR commits', async () => {
  const s = writeScene({ pr: prState() });
  const r = await run(s, ['f_h4x8pz', '--status', 'addressed', '--commit', '9f2c4e1']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const threads = prState()?.reviewThreads as { nodes: { comments: { nodes: Node[] } }[] };
  const thread0 = threads.nodes[0] as { comments: { nodes: Node[] } } & Record<string, unknown>;
  const replyNode = {
    databaseId: r.json.events[0].commentId,
    author: member,
    authorAssociation: 'MEMBER',
    body: String(s.sent.reply?.[0]?.body),
    createdAt: '2026-10-22T10:00:00Z',
    path: 'packages/reactor/src/client/reactor-client.ts',
    url: r.json.events[0].url,
    replyTo: { databaseId: 1834567890 },
  };
  const fold = foldFeedback(
    {
      issueComments: [],
      reviews: [WORKED.reviews[0] as never],
      reviewThreads: [
        {
          ...thread0,
          isResolved: true,
          comments: { nodes: [...thread0.comments.nodes, replyNode] },
        } as never,
        threads.nodes[1] as never,
      ],
      viewerLogin: 'thegoldenmule',
      headSha: HEAD,
      config: snapshotConfig(),
    },
    { commits: new Map([[HEAD, true]]) },
  );
  const f = fold.feedback.findings.find((x) => x.id === 'f_h4x8pz');
  assert.equal(f?.status, 'addressed');
  assert.equal(f?.statusEvent?.commit, HEAD);
  assert.equal(f?.statusEvent?.verified, true);
  assert.deepEqual(fold.openFindings, ['f_n2c6rv']);
  assert.equal(fold.feedback.comments[0]?.kind, 'resolve');
  assert.equal(fold.feedback.comments[0]?.body, 'Addressed in 9f2c4e1.');
});

test('smoke/pr-resolve: the example halts in dry-run, and the fixture query matches the builder', async () => {
  const gh = FakeGh.fromScenario('smoke/pr-resolve');
  const r = await runInProcess(
    ['pr', 'resolve', 'octo/demo#7', 'f_h4x8pz', '--status', 'addressed', '--commit', 'bbbbbbb', '--dry-run'],
    { gh },
  );
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.dryRun, true);
  assert.match(r.json.preview.replies[0].body, /^Addressed in bbbbbbb\./);
  const fixture = JSON.parse(readFileSync(join(GH_FIXTURE_ROOT, 'smoke/pr-resolve/002-q1.json'), 'utf8'));
  const built = buildGraphqlArgs(
    Q1_QUERY,
    { owner: 'octo', name: 'demo', number: 7, after: null },
    { repo: { host: 'github.com', owner: 'octo', name: 'demo' } },
  );
  assert.equal(argvKey(fixture.argv), argvKey(built.args));
});
