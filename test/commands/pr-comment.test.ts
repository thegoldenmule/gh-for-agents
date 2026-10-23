// ghx pr comment (03 M11.1): the 02 §7.1 call sequence, the rules (--close with a precondition, refs that
// don't exist or point at this PR, supersede without --close), dry-run, and a round trip through the fold.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { foldFeedback } from '../../src/feedback/fold.ts';
import { buildGraphqlArgs } from '../../src/gh/graphql.ts';
import { isMutating } from '../../src/gh/guard.ts';
import { Q1_QUERY } from '../../src/pr/snapshot/query.ts';
import { EXIT } from '../contract/exit-table.ts';
import { FakeGh } from '../helpers/fake-gh.ts';
import { argvKey, GH_FIXTURE_ROOT } from '../helpers/fixture-match.ts';
import { runInProcess } from '../helpers/harness.ts';
import { snapshotConfig } from '../unit/pr/snapshot-fixture.ts';
import { HEAD, REF, sequence, writeScene } from './pr-comment-scene.ts';

const ARGV = ['pr', 'comment', REF, '--input', '-'];
const run = (gh: FakeGh, input: unknown, extra: string[] = []) =>
  runInProcess([...ARGV, ...extra], { gh, stdin: JSON.stringify(input) });

test('precondition: Q1, ref lookup, one POST; output carries the evaluated precondition', async () => {
  const s = writeScene({ refs: { 'powerhouse-inc/powerhouse#3184': { state: 'OPEN' } } });
  const r = await run(s.gh, { kind: 'precondition', condition: { type: 'pr-merged', ref: '#3184' } });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(sequence(s.gh), ['q1', 'refs', 'post-comment']);
  const body = String(s.sent['post-comment']?.[0]?.body);
  assert.match(body, /^\*\*Merge precondition:\*\* merge only after #3184 is merged\.\n\n<!-- ghx:v1 \{.*\} -->$/);
  assert.equal(r.json.ref, REF);
  assert.match(r.json.id, /^c_[0-9a-hjkmnp-tv-z]{6}$/);
  assert.ok(body.includes(`"id":"${r.json.id}"`));
  assert.equal(r.json.kind, 'precondition');
  assert.equal(r.json.closed, false);
  assert.deepEqual(r.json.precondition, { status: 'unmet', evidence: '#3184 is open' });
  assert.equal(typeof r.json.commentId, 'number');
  assert.match(r.json.url, /#issuecomment-\d+$/);
});

test('a note needs no ref lookup; the body travels on stdin, never in argv', async () => {
  const s = writeScene();
  const note = 'Rebased on main; `pnpm test` is green locally.\nSecond line with $HOME and "quotes".';
  const r = await run(s.gh, { kind: 'note', body: note });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(sequence(s.gh), ['q1', 'post-comment']);
  const post = s.gh.calls.find((c) => isMutating(c.argv));
  assert.ok(post && !post.argv.some((a) => a.includes('$HOME')));
  assert.ok(String(s.sent['post-comment']?.[0]?.body).startsWith(`${note}\n\n<!-- ghx:v1 `));
  assert.equal(r.json.precondition, null);
});

test('--close with a precondition is refused before any gh call', async () => {
  const s = writeScene();
  const r = await run(s.gh, { kind: 'precondition', condition: { type: 'manual', text: 'Ops signs off.' } }, [
    '--close',
  ]);
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  assert.equal(r.json.error.code, 'VALIDATION');
  assert.equal(r.json.error.details.issues[0].code, 'comment.close_with_precondition');
  assert.deepEqual(sequence(s.gh), []);
});

test('a ref to this same PR is refused, in either spelling', async () => {
  for (const by of ['#3301', 'powerhouse-inc/Powerhouse#3301']) {
    const s = writeScene();
    const r = await run(s.gh, { kind: 'supersede', by });
    assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
    assert.equal(r.json.error.details.issues[0].code, 'comment.ref_self');
    assert.deepEqual(sequence(s.gh), []);
  }
});

test('a ref that does not exist is REF_NOT_FOUND (5), and nothing is posted', async () => {
  const s = writeScene({ refs: { 'powerhouse-inc/powerhouse#3184': { state: 'OPEN' } } });
  const r = await run(s.gh, {
    kind: 'status',
    state: 'waiting',
    body: 'Waiting on both.',
    refs: ['#3184', 'o/r#9999'],
  });
  assert.equal(r.exitCode, EXIT.NOT_FOUND, r.stdout);
  assert.equal(r.json.error.code, 'REF_NOT_FOUND');
  assert.deepEqual(r.json.error.details.missing, [{ path: 'refs[1]', ref: 'o/r#9999' }]);
  assert.deepEqual(sequence(s.gh), ['q1', 'refs']);
});

test('supersede without --close warns SUPERSEDED_STILL_OPEN; with --close it PATCHes state=closed', async () => {
  const refs = { 'powerhouse-inc/powerhouse#3250': { state: 'OPEN' } };
  const open = writeScene({ refs });
  const r1 = await run(open.gh, { kind: 'supersede', by: '#3250' });
  assert.equal(r1.exitCode, EXIT.OK, r1.stdout);
  assert.deepEqual(
    r1.json.warnings.map((w: { code: string }) => w.code),
    ['SUPERSEDED_STILL_OPEN'],
  );
  const closing = writeScene({ refs });
  const r2 = await run(closing.gh, { kind: 'supersede', by: '#3250' }, ['--close']);
  assert.equal(r2.exitCode, EXIT.OK, r2.stdout);
  assert.deepEqual(sequence(closing.gh), ['q1', 'refs', 'post-comment', 'close']);
  assert.deepEqual(closing.sent.close, [{ state: 'closed' }]);
  assert.equal(r2.json.closed, true);
  assert.equal(r2.json.warnings, undefined);
});

test('a closed PR is PR_NOT_OPEN (9)', async () => {
  const s = writeScene({ pr: { state: 'CLOSED' } });
  const r = await run(s.gh, { kind: 'note', body: 'x' });
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.equal(r.json.error.code, 'PR_NOT_OPEN');
});

test('input rules: 16 lines, 1 501 chars and a ghx marker are refused; 15 lines of 1 500 chars pass', async () => {
  const bad = [Array.from({ length: 16 }, () => 'x').join('\n'), 'x'.repeat(1501), 'hello <!-- ghx:v1 {} -->'];
  for (const body of bad) {
    const r = await run(writeScene().gh, { kind: 'note', body });
    assert.equal(r.json.error?.code, 'VALIDATION', body.slice(0, 20));
  }
  const fifteen = Array.from({ length: 15 }, (_, i) => (i === 0 ? 'y'.repeat(1500 - 28) : 'y')).join('\n');
  assert.equal(fifteen.length, 1500);
  const r = await run(writeScene().gh, { kind: 'note', body: fifteen });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
});

test('--dry-run reads, renders and halts at the POST: no mutation', async () => {
  const s = writeScene({
    refs: { 'powerhouse-inc/powerhouse#3184': { state: 'MERGED', mergedAt: '2026-10-21T10:00:00Z' } },
  });
  const r = await run(s.gh, { kind: 'precondition', condition: { type: 'pr-merged', ref: '#3184' } }, ['--dry-run']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.dryRun, true);
  assert.match(r.json.preview.body, /^\*\*Merge precondition:\*\*/);
  assert.deepEqual(sequence(s.gh), ['q1', 'refs']);
  assert.equal(s.sent['post-comment'], undefined);
});

test('round trip: the posted comment folds into a structured precondition', async () => {
  const s = writeScene({ refs: { 'powerhouse-inc/powerhouse#3184': { state: 'OPEN' } } });
  const r = await run(s.gh, { kind: 'precondition', condition: { type: 'manual', text: 'Ops signs off.' } });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const fold = foldFeedback({
    issueComments: [
      {
        databaseId: r.json.commentId,
        author: { __typename: 'User', login: 'thegoldenmule' },
        authorAssociation: 'MEMBER',
        body: String(s.sent['post-comment']?.[0]?.body),
        createdAt: '2026-10-22T10:00:00Z',
        lastEditedAt: null,
        url: r.json.url,
      },
    ],
    reviews: [],
    reviewThreads: [],
    viewerLogin: 'thegoldenmule',
    headSha: HEAD,
    config: snapshotConfig(),
  });
  assert.deepEqual(fold.warnings, []);
  assert.equal(fold.feedback.comments[0]?.structured, true);
  assert.equal(fold.feedback.comments[0]?.kind, 'precondition');
  assert.equal(fold.feedback.comments[0]?.body, '**Merge precondition:** Ops signs off.');
  assert.equal(fold.preconditions[0]?.id, r.json.id);
  assert.equal(fold.preconditions[0]?.status, 'unknown');
});

test('smoke/pr-comment: the example halts in dry-run, and the fixture query matches the builder', async () => {
  const gh = FakeGh.fromScenario('smoke/pr-comment');
  const r = await runInProcess(['pr', 'comment', 'octo/demo#7', '--input', '-', '--dry-run'], {
    gh,
    stdin: JSON.stringify({ kind: 'precondition', condition: { type: 'pr-merged', ref: '#6' } }),
  });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.dryRun, true);
  const fixture = JSON.parse(readFileSync(join(GH_FIXTURE_ROOT, 'smoke/pr-comment/001-q1.json'), 'utf8'));
  const built = buildGraphqlArgs(
    Q1_QUERY,
    { owner: 'octo', name: 'demo', number: 7, after: null },
    {
      repo: { host: 'github.com', owner: 'octo', name: 'demo' },
    },
  );
  assert.equal(argvKey(fixture.argv), argvKey(built.args));
});

test("--close on another author's PR is AUTHOR_NOT_VIEWER (6) before any write; --override closes it", async () => {
  const refs = { 'powerhouse-inc/powerhouse#3250': { state: 'OPEN' } };
  const s = writeScene({ refs, viewer: 'someone-else' });
  const r = await run(s.gh, { kind: 'supersede', by: '#3250' }, ['--close']);
  assert.equal(r.exitCode, EXIT.POLICY, r.stdout);
  assert.equal(r.json.error.code, 'AUTHOR_NOT_VIEWER');
  assert.equal(r.json.error.details.author, 'thegoldenmule');
  assert.match(r.json.error.hint, /--override AUTHOR_NOT_VIEWER --reason/);
  s.gh.expectNoMutations();

  const note = writeScene({ viewer: 'someone-else' });
  const n = await run(note.gh, { kind: 'note', body: 'hi' });
  assert.equal(n.exitCode, EXIT.OK, 'commenting without --close is not guarded');

  const ok = writeScene({ refs, viewer: 'someone-else' });
  const o = await run(ok.gh, { kind: 'supersede', by: '#3250' }, [
    '--close',
    '--override',
    'AUTHOR_NOT_VIEWER',
    '--reason',
    'user asked in chat',
  ]);
  assert.equal(o.exitCode, EXIT.OK, o.stdout);
  assert.equal(o.json.closed, true);
  assert.deepEqual(o.json.overrides, [{ code: 'AUTHOR_NOT_VIEWER', reason: 'user asked in chat' }]);
});
