// pr status's hard 16 KB bound (04 wave 4 review decisions): once body blanking is not enough, whole
// comment entries go (resolved and oldest first), then bots, then settled findings; open findings,
// unverified addressed findings, preconditions and merge.* are never dropped.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { byteLength, DEFAULT_MAX_BYTES } from '../../../src/core/output.ts';
import type { BotItem, Comment, Finding } from '../../../src/feedback/schemas.ts';
import { PrStatusOutput } from '../../../src/pr/status/schema.ts';
import { fitStatus } from '../../../src/pr/status/truncate.ts';

const GOLDEN = PrStatusOutput.parse(
  JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'golden', 'pr-status-3301.json'), 'utf8')),
);

const URL = 'https://github.com/powerhouse-inc/powerhouse/pull/3301';

function comment(i: number, threadResolved: boolean | null): Comment {
  return {
    id: `ic:${100000 + i}`,
    source: threadResolved === null ? 'issue' : 'inline',
    author: { login: `reviewer-${i % 7}`, isViewer: false, isBot: false, association: 'MEMBER' },
    at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
    body: `${i} ${'word '.repeat(200)}`,
    truncated: false,
    structured: false,
    kind: null,
    path: threadResolved === null ? null : `packages/reactor/src/file-${i}.ts`,
    line: threadResolved === null ? null : i,
    threadResolved,
    inReplyTo: null,
    edited: false,
    blockError: null,
    url: `${URL}#issuecomment-${100000 + i}`,
  };
}

function bot(i: number): BotItem {
  return {
    id: `bot:${i}`,
    source: 'issue',
    author: 'coderabbitai[bot]',
    at: new Date(Date.UTC(2026, 9, 2, 0, i)).toISOString(),
    marker: null,
    summary: `bot ${i} ${'note '.repeat(60)}`,
    path: null,
    line: null,
    url: `${URL}#issuecomment-${200000 + i}`,
  };
}

/** The worked example with 300 comments (every third a resolved thread, every third an open one) and 40 bots. */
function bigPr(): PrStatusOutput {
  const doc = structuredClone(GOLDEN);
  const comments = Array.from({ length: 300 }, (_, i) => comment(i, i % 3 === 0 ? true : i % 3 === 1 ? null : false));
  doc.feedback.comments = [...doc.feedback.comments, ...comments];
  doc.feedback.bots = [...doc.feedback.bots, ...Array.from({ length: 40 }, (_, i) => bot(i))];
  doc.feedback.counts.comments = doc.feedback.comments.length;
  doc.feedback.counts.bots = doc.feedback.bots.length;
  const settled = doc.feedback.findings[0] as Finding;
  const unverified: Finding = {
    ...settled,
    id: 'f_unver1',
    statusEvent: { ...(settled.statusEvent as NonNullable<Finding['statusEvent']>), verified: null },
  };
  doc.feedback.findings = [...doc.feedback.findings, unverified];
  return doc;
}

test('a 300-comment PR fits under 16,384 bytes once whole entries are dropped', () => {
  const doc = bigPr();
  assert.ok(byteLength(JSON.stringify(doc)) > 100_000, 'the input is far over the bound');
  const out = fitStatus(doc, DEFAULT_MAX_BYTES);
  PrStatusOutput.parse(out);
  const bytes = byteLength(JSON.stringify(out));
  assert.ok(bytes <= 16_384, `${bytes} bytes`);

  const fb = out.feedback;
  assert.ok(fb.comments.length < 302, 'whole comment entries were dropped');
  assert.equal(fb.counts.comments, 302, 'counts keep the fold totals');
  assert.equal(fb.counts.bots, 41);
  const dropped = 302 - fb.comments.length + (41 - fb.bots.length);
  assert.ok(fb.counts.omitted >= dropped, 'every dropped entry is counted');
  assert.ok(fb.counts.omitted <= 302 + 41 + 3, 'no item is counted twice');

  // Never dropped: open findings, unverified addressed findings, preconditions, merge.*, openFindings.
  const ids = fb.findings.map((f) => f.id);
  assert.ok(ids.includes('f_n2c6rv'), 'the open finding stays');
  assert.ok(ids.includes('f_unver1'), 'an unverified addressed finding counts as open and stays');
  assert.deepEqual(out.merge, doc.merge);
  assert.deepEqual(out.preconditions, doc.preconditions);
  assert.deepEqual(out.openFindings, doc.openFindings);

  const hint = out.warnings.find((w) => w.code === 'FEEDBACK_OMITTED');
  assert.ok(hint);
  assert.match(hint.message, new RegExp(`^${fb.counts.omitted} `));
  assert.match(hint.message, /whole entries dropped/);
  assert.match(hint.message, /ghx pr feedback powerhouse-inc\/powerhouse#3301/);
});

test('drop order: resolved threads first, then other comments oldest first; open threads outlast them', () => {
  const out = fitStatus(bigPr(), DEFAULT_MAX_BYTES);
  const kept = new Set(out.feedback.comments.map((c) => c.id));
  const all = bigPr().feedback.comments.filter((c) => c.id.startsWith('ic:1'));
  const resolved = all.filter((c) => c.threadResolved === true);
  const open = all.filter((c) => c.threadResolved === false);
  const keptResolved = resolved.filter((c) => kept.has(c.id)).length;
  const keptOpen = open.filter((c) => kept.has(c.id)).length;
  assert.ok(keptResolved <= keptOpen, `resolved kept ${keptResolved}, open kept ${keptOpen}`);
  // Within a tier, the newest survive.
  const keptIdx = open.map((c) => kept.has(c.id));
  const first = keptIdx.indexOf(true);
  if (first >= 0) assert.ok(keptIdx.slice(first).every(Boolean), 'oldest first within a tier');
});

test('a document already under the bound loses no entries', () => {
  const out = fitStatus(GOLDEN, DEFAULT_MAX_BYTES);
  assert.equal(out.feedback.counts.omitted, 0);
  assert.equal(out.feedback.comments.length, GOLDEN.feedback.comments.length);
  assert.equal(
    out.warnings.find((w) => w.code === 'FEEDBACK_OMITTED'),
    undefined,
  );
});
