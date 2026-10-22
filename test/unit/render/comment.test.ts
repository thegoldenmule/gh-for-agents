// Comment and resolve renderings, golden (02 §7.1, §7.3, §14.3; 03 §5.1). The 02 §14.3 bodies are pinned to
// test/fixtures/feedback/worked-example-3301.input.json, which holds them with the codec's sorted keys.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type FindingBlock, type ReviewBlock, readBlocks } from '../../../src/meta/schemas.ts';
import {
  renderCommentBody,
  renderResolveComment,
  renderResolveReply,
  resolveSentence,
} from '../../../src/render/comment.ts';
import { findingCount, renderInlineFinding, renderReviewBody } from '../../../src/render/review.ts';

const GEN = 'ghx/0.1.0';
const FULL = '9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d';

const WORKED = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../fixtures/feedback/worked-example-3301.input.json'), 'utf8'),
) as {
  reviews: { body: string }[];
  reviewThreads: { comments: { nodes: { body: string }[] } }[];
};
const threadBody = (i: number, j: number) => WORKED.reviewThreads[i]?.comments.nodes[j]?.body ?? '';

test('resolve-reply: the 02 §14.3 thread reply, byte for byte', () => {
  const body = renderResolveReply({
    t: 'comment',
    id: 'c_w5j1ve',
    gen: GEN,
    kind: 'resolve',
    targets: [{ id: 'f_h4x8pz', status: 'addressed', commit: FULL }],
  });
  assert.equal(body, threadBody(0, 1));
  assert.ok(body.startsWith('Addressed in 9f2c4e1.\n\n<!-- ghx:v1 '));
});

test('precondition-comment: pr-merged, release-includes and manual leads', () => {
  const merged = renderCommentBody({
    t: 'comment',
    id: 'c_a1b2c3',
    gen: GEN,
    kind: 'precondition',
    condition: { type: 'pr-merged', ref: '#3184' },
  });
  assert.equal(
    merged,
    '**Merge precondition:** merge only after #3184 is merged.\n\n' +
      '<!-- ghx:v1 {"condition":{"ref":"#3184","type":"pr-merged"},"gen":"ghx/0.1.0","id":"c_a1b2c3","kind":"precondition","t":"comment"} -->',
  );
  const release = renderCommentBody(
    {
      t: 'comment',
      id: 'c_a1b2c3',
      gen: GEN,
      kind: 'precondition',
      condition: { type: 'release-includes', ref: 'o/r#12' },
    },
    'Switchboard reads the new field.',
  );
  assert.match(
    release,
    /^\*\*Merge precondition:\*\* merge only after a release includes o\/r#12\.\n\nSwitchboard reads the new field\.\n\n<!-- ghx:v1 /,
  );
  const manual = renderCommentBody({
    t: 'comment',
    id: 'c_a1b2c3',
    gen: GEN,
    kind: 'precondition',
    condition: { type: 'manual', text: 'Ops confirms the migration window.' },
  });
  assert.match(manual, /^\*\*Merge precondition:\*\* Ops confirms the migration window\.\n\n<!-- ghx:v1 /);
});

test('supersede-comment and status-comment', () => {
  assert.equal(
    renderCommentBody({ t: 'comment', id: 'c_a1b2c3', gen: GEN, kind: 'supersede', by: '#3250' }),
    'Superseded by #3250.\n\n<!-- ghx:v1 {"by":"#3250","gen":"ghx/0.1.0","id":"c_a1b2c3","kind":"supersede","t":"comment"} -->',
  );
  assert.equal(
    renderCommentBody(
      { t: 'comment', id: 'c_a1b2c3', gen: GEN, kind: 'status', state: 'rebased', refs: ['#3184', '#3185'] },
      'Rebased onto main after #3184 merged.',
    ),
    '**Status:** rebased. Rebased onto main after #3184 merged.\n\nRefs: #3184, #3185\n\n' +
      '<!-- ghx:v1 {"gen":"ghx/0.1.0","id":"c_a1b2c3","kind":"status","refs":["#3184","#3185"],"state":"rebased","t":"comment"} -->',
  );
  const note = renderCommentBody({ t: 'comment', id: 'c_a1b2c3', gen: GEN, kind: 'note' }, 'a --> b <script>');
  assert.match(note, /^a --> b <script>\n\n<!-- ghx:v1 \{[^<>]*\} -->$/);
  const blocks = readBlocks(note);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.status, 'ok');
});

test('resolve sentences for every status, and the issue-comment form leads each line with the id', () => {
  const s = (status: string, extra: Record<string, string> = {}) =>
    resolveSentence({ id: 'f_h4x8pz', status: status as never, ...extra });
  assert.equal(
    s('addressed', { commit: FULL, note: 'Also covered the batch path.' }),
    'Addressed in 9f2c4e1. Also covered the batch path.',
  );
  assert.equal(s('wontfix', { note: 'Kept for compatibility.' }), "Won't fix: Kept for compatibility.");
  assert.equal(s('deferred', { note: 'Next sprint.', tracking: '#2901' }), 'Deferred: Next sprint. (tracking #2901)');
  assert.equal(s('open'), 'Reopened.');
  assert.equal(s('met', { note: 'Released in 4.2.0.' }), 'Met: Released in 4.2.0.');
  assert.equal(s('withdrawn', { note: 'Not needed.' }), 'Withdrawn: Not needed.');
  assert.equal(s('unmet', { note: 'Rolled back.' }), 'Unmet. Rolled back.');

  const body = renderResolveComment({
    t: 'comment',
    id: 'c_m3k8tv',
    gen: GEN,
    kind: 'resolve',
    targets: [
      { id: 'f_n2c6rv', status: 'wontfix', note: 'The id is logged one frame up.' },
      { id: 'c_a1b2c3', status: 'met', note: 'Ops confirmed.' },
    ],
  });
  assert.equal(
    body.split('\n\n')[0],
    "`f_n2c6rv` Won't fix: The id is logged one frame up.\n`c_a1b2c3` Met: Ops confirmed.",
  );
});

test('an invalid block is a ghx bug (INTERNAL), never a body', () => {
  assert.throws(
    () => renderCommentBody({ t: 'comment', id: 'c_bad', gen: GEN, kind: 'note' }, 'x'),
    (e: Error & { code?: string }) => e.code === 'INTERNAL',
  );
});

const OLD = '4b1e7d20c9a35f8e61d24b07c3a9e5f1d8b62c47';
const HIGH: FindingBlock = {
  t: 'finding',
  id: 'f_h4x8pz',
  gen: GEN,
  review: 'r_7tq2wd',
  severity: 'high',
  path: 'packages/reactor/src/client/reactor-client.ts',
  line: 1071,
  side: 'RIGHT',
  alsoAt: [{ path: 'packages/reactor/src/client/reactor-client.ts', line: 1111 }],
  title: 'deleteDocument still signs without documentId',
  body: 'deleteDocument builds its action through the legacy helper, which never passes documentId to signAction, so a delete signature still verifies on any document.',
  commit: OLD,
};
const LOW: FindingBlock = {
  t: 'finding',
  id: 'f_n2c6rv',
  gen: GEN,
  review: 'r_7tq2wd',
  severity: 'low',
  path: 'packages/shared/document-model/crypto.ts',
  line: 179,
  side: 'RIGHT',
  alsoAt: [],
  title: 'Rejection error does not name the documentId',
  body: 'The thrown error says "signature not bound" without the expected and actual documentId, which makes client logs hard to trace.',
  commit: OLD,
};
const REVIEW: ReviewBlock = {
  t: 'review',
  id: 'r_7tq2wd',
  gen: GEN,
  verdict: 'request-changes',
  summary: 'The signing fix covers createDocument and addActions, but deleteDocument still signs without a documentId.',
  scope: '8 files on fix/reactor-bind-document-id plus the sign/verify call graph',
  commit: OLD,
  findings: ['f_h4x8pz', 'f_n2c6rv'],
};

test('review-body: the 02 §14.3 review body (both findings inline), byte for byte', () => {
  assert.equal(renderReviewBody(REVIEW, [HIGH, LOW], []), WORKED.reviews[0]?.body);
});

test('inline-finding-alsoat: the 02 §14.3 inline comments, byte for byte', () => {
  assert.equal(renderInlineFinding(HIGH), threadBody(0, 0));
  assert.equal(renderInlineFinding(LOW), threadBody(1, 0));
});

test('review-body-3-findings: body-only finding blocks follow the review block, one per line', () => {
  const MED: FindingBlock = {
    ...LOW,
    id: 'f_q7w3xa',
    severity: 'medium',
    line: 40,
    endLine: 44,
    title: 'Range finding',
  };
  const review = { ...REVIEW, scope: undefined, findings: ['f_h4x8pz', 'f_n2c6rv', 'f_q7w3xa'] } as ReviewBlock;
  delete (review as { scope?: string }).scope;
  const body = renderReviewBody(review, [HIGH, LOW, MED], [LOW, MED]);
  const parts = body.split('\n\n');
  assert.equal(parts[0], '**ghx review** · request-changes · 3 findings (1 high, 1 medium, 1 low)');
  assert.equal(parts[1], REVIEW.summary);
  assert.equal(
    parts[2],
    '1. **[high]** `packages/reactor/src/client/reactor-client.ts:1071` deleteDocument still signs without documentId\n' +
      '2. **[low]** `packages/shared/document-model/crypto.ts:179` Rejection error does not name the documentId\n' +
      '3. **[medium]** `packages/shared/document-model/crypto.ts:40-44` Range finding',
  );
  const blocks = (parts[3] ?? '').split('\n');
  assert.equal(blocks.length, 3);
  assert.deepEqual(
    readBlocks(parts[3] ?? '').map((b) => (b.status === 'ok' ? `${b.block.t}:${b.block.id}` : b.status)),
    ['review:r_7tq2wd', 'finding:f_n2c6rv', 'finding:f_q7w3xa'],
  );
  assert.equal(findingCount([]), '0 findings');
  assert.equal(findingCount([HIGH]), '1 finding (1 high, 0 medium, 0 low)');
});

test('a RIGHT-side suggestion renders as a suggestion fence; a LEFT one stays in the block', () => {
  const withS = renderInlineFinding({ ...LOW, suggestion: 'throw new Error(`unbound`);\n```' });
  assert.match(withS, /\n\n````suggestion\nthrow new Error\(`unbound`\);\n```\n````\n\n<!-- ghx:v1 /);
  const left = renderInlineFinding({ ...LOW, side: 'LEFT', suggestion: 'x' });
  assert.doesNotMatch(left, /suggestion\n/);
  assert.match(left, /"suggestion":"x"/);
});
