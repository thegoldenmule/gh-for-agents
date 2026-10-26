import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { isGhxError } from '../../../src/core/errors.ts';
import { encode } from '../../../src/meta/codec.ts';
import * as schemas from '../../../src/meta/schemas.ts';
import {
  BlockV1,
  CommentBlock,
  encodeBlock,
  FindingBlock,
  PrBlock,
  ReviewBlock,
  readBlocks,
  readPrBlock,
} from '../../../src/meta/schemas.ts';
import { prMetaOf } from '../../../src/pr/status/output.ts';
import { assertExportable } from '../schemas/_exportable.ts';

const body = (f: string) => readFileSync(join(import.meta.dirname, '../../fixtures/bodies', f), 'utf8');
const SHA_A = '4b1e7d20c9a35f8e61d24b07c3a9e5f1d8b62c47';
const SHA_B = '9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d';

// 02 §14.1–14.3.
const pr: PrBlock = {
  t: 'pr',
  id: 'p_k3m9qa',
  gen: 'ghx/0.1.0',
  rev: 1,
  title: 'fix(reactor): bind documentId when signing actions on the write path',
  description: 'The primary write path signed actions without binding documentId.',
  testing: [{ kind: 'unit', command: 'pnpm test -- signature', result: 'pass' }],
  risk: 'medium',
  riskNote: 'Clients that sign without a documentId now get a verification error.',
  components: ['reactor', 'shared'],
  revertPolicy: 'revert-safe',
  refs: { closes: ['#2894'] },
};
const review: ReviewBlock = {
  t: 'review',
  id: 'r_7tq2wd',
  gen: 'ghx/0.1.0',
  verdict: 'request-changes',
  summary: 'deleteDocument still signs without a documentId.',
  commit: SHA_A,
  findings: ['f_h4x8pz', 'f_n2c6rv'],
};
const finding: FindingBlock = {
  t: 'finding',
  id: 'f_h4x8pz',
  gen: 'ghx/0.1.0',
  review: 'r_7tq2wd',
  severity: 'high',
  path: 'packages/reactor/src/client/reactor-client.ts',
  line: 1071,
  side: 'RIGHT',
  alsoAt: [{ path: 'packages/reactor/src/client/reactor-client.ts', line: 1111 }],
  title: 'deleteDocument still signs without documentId',
  body: 'deleteDocument builds its action through the legacy helper.',
  commit: SHA_A,
};
const resolve: CommentBlock = {
  t: 'comment',
  id: 'c_w5j1ve',
  gen: 'ghx/0.1.0',
  kind: 'resolve',
  targets: [{ id: 'f_h4x8pz', status: 'addressed', commit: SHA_B }],
};

test('every exported schema exports to JSON Schema', () => {
  assert.ok(assertExportable(schemas) >= 12);
});

test('strict schemas accept the worked-example blocks', () => {
  for (const [s, v] of [
    [PrBlock, pr],
    [ReviewBlock, review],
    [FindingBlock, finding],
    [CommentBlock, resolve],
  ] as const) {
    assert.ok(s.safeParse(v).success, v.t);
    assert.ok(BlockV1.safeParse(v).success, v.t);
  }
  for (const c of [
    { kind: 'note' },
    { kind: 'precondition', condition: { type: 'pr-merged', ref: '#3184' } },
    { kind: 'status', state: 'rebased', refs: ['#1'] },
    { kind: 'supersede', by: 'o/r#2' },
  ]) {
    assert.ok(CommentBlock.safeParse({ t: 'comment', id: 'c_aaaaaa', gen: 'ghx/0.1.0', ...c }).success, c.kind);
  }
});

test('strict schemas reject unknown keys, unknown enum values and bad ids', () => {
  assert.ok(!PrBlock.safeParse({ ...pr, extra: 1 }).success);
  assert.ok(!FindingBlock.safeParse({ ...finding, status: 'open' }).success, 'a finding has no status field');
  assert.ok(!FindingBlock.safeParse({ ...finding, severity: 'critical' }).success);
  assert.ok(!ReviewBlock.safeParse({ ...review, id: 'f_7tq2wd' }).success);
  assert.ok(!CommentBlock.safeParse({ ...resolve, kind: 'mystery' }).success);
  assert.ok(!CommentBlock.safeParse({ ...resolve, targets: [] }).success);
  assert.ok(!CommentBlock.safeParse({ ...resolve, targets: [{ id: 'f_h4x8pz', status: 'addressed', x: 1 }] }).success);
});

test('encodeBlock validates strictly; an invalid block is INTERNAL', () => {
  assert.equal(encodeBlock(finding), encode(finding));
  assert.throws(
    () => encodeBlock({ ...finding, severity: 'critical' } as never),
    (e: unknown) => isGhxError(e) && e.code === 'INTERNAL',
  );
});

test('lenient read round-trips what the writer emits', () => {
  const blocks = readBlocks(`text\n\n${encodeBlock(review)}\n${encodeBlock(finding)}\n${encodeBlock(resolve)}`);
  assert.deepEqual(
    blocks.map((b) => b.status === 'ok' && b.block.t),
    ['review', 'finding', 'comment'],
  );
  for (const b of blocks) assert.equal(b.status === 'ok' && b.warnings.length, 0);
});

test('lenient read keeps unknown keys and unknown enum values, warning UNKNOWN_ENUM', () => {
  const [b] = readBlocks(encode({ ...finding, severity: 'critical', side: 'MIDDLE', future: { x: 1 } }));
  assert.equal(b?.status, 'ok');
  if (b?.status !== 'ok' || b.block.t !== 'finding') return;
  assert.equal(b.block.severity, 'critical');
  assert.deepEqual((b.block as Record<string, unknown>).future, { x: 1 });
  assert.deepEqual(
    b.warnings.map((w) => w.code),
    ['UNKNOWN_ENUM', 'UNKNOWN_ENUM'],
  );
  assert.match(b.warnings[0]?.message ?? '', /severity "critical".*treats it as high/);

  const [p] = readBlocks(encode({ ...pr, risk: 'extreme', revertPolicy: 'never' }));
  assert.equal(p?.status === 'ok' && p.warnings.length, 2);

  const [r] = readBlocks(encode({ ...resolve, targets: [{ id: 'f_h4x8pz', status: 'fixed' }] }));
  assert.match(r?.status === 'ok' ? (r.warnings[0]?.message ?? '') : '', /event is ignored/);

  const [c] = readBlocks(
    encode({ t: 'comment', id: 'c_aaaaaa', gen: 'ghx/0.2.0', kind: 'precondition', condition: { type: 'ci-green' } }),
  );
  assert.equal(c?.status, 'ok');
  assert.match(c?.status === 'ok' ? (c.warnings[0]?.message ?? '') : '', /condition\.type "ci-green"/);
});

test('an unknown t or comment kind is unknown-type with UNKNOWN_BLOCK_TYPE', () => {
  const [a, b] = readBlocks(
    `${encode({ t: 'poll', id: 'x_1', gen: 'ghx/0.9.0' })}\n${encode({ t: 'comment', id: 'c_aaaaaa', gen: 'ghx/0.9.0', kind: 'vote' })}`,
  );
  assert.equal(a?.status, 'unknown-type');
  assert.equal(a?.status === 'unknown-type' && a.kind, null);
  assert.equal(a?.status === 'unknown-type' && a.warnings[0]?.code, 'UNKNOWN_BLOCK_TYPE');
  assert.equal(b?.status === 'unknown-type' && b.kind, 'vote');
});

test('ghx:v2 is invalid with SCHEMA_NEWER and "newer schema v2"', () => {
  const [b] = readBlocks(body('structured-v2-future.md'));
  assert.deepEqual(
    b && { status: b.status, code: b.status === 'invalid' && b.code, error: b.status === 'invalid' && b.error },
    {
      status: 'invalid',
      code: 'SCHEMA_NEWER',
      error: 'newer schema v2',
    },
  );
  const [v0] = readBlocks('<!-- ghx:v0 {"t":"pr","id":"p_aaaaaa"} -->');
  assert.equal(v0?.status === 'invalid' && v0.code, 'BLOCK_INVALID');
});

test('malformed JSON and schema failures are BLOCK_INVALID with a readable error; never throws', () => {
  const [j] = readBlocks('<!-- ghx:v1 {"t":"pr",} -->');
  assert.equal(j?.status === 'invalid' && j.error, 'invalid JSON');
  // malformed-block.md has no closing brace, so the codec does not see a block at all.
  assert.deepEqual(readBlocks(body('malformed-block.md')), []);
  const [s] = readBlocks(encode({ ...finding, line: -1 }));
  assert.match(s?.status === 'invalid' ? s.error : '', /^invalid finding block: line:/);
  const [e] = readBlocks('<!-- ghx:v1 {"id":"x"} -->');
  assert.match(e?.status === 'invalid' ? e.error : '', /^invalid block: t:/);
  assert.deepEqual(readBlocks(body('no-block-human.md')), []);
  assert.deepEqual(readBlocks(body('ci-duration-watch-bot.md')), []);
});

test('readPrBlock: first valid wins, extras warn DUPLICATE_BLOCK; v2 gives SCHEMA_NEWER', () => {
  const two = `${encode(pr)}\n\n${encode({ ...pr, id: 'p_bbbbbb', rev: 2 })}`;
  const r = readPrBlock(two);
  assert.equal(r.status === 'ok' && r.block.id, 'p_k3m9qa');
  assert.deepEqual(
    r.warnings.map((w) => w.code),
    ['DUPLICATE_BLOCK'],
  );
  // two-pr-blocks.md lacks required pr fields: both are invalid, the first one is reported.
  const bad = readPrBlock(body('two-pr-blocks.md'));
  assert.equal(bad.status, 'invalid');
  const newer = readPrBlock(body('structured-v2-future.md'));
  assert.equal(newer.status === 'invalid' && newer.code, 'SCHEMA_NEWER');
  assert.deepEqual(
    newer.warnings.map((w) => w.code),
    ['SCHEMA_NEWER'],
  );
  assert.equal(readPrBlock('plain').status, 'absent');
});

test('06: the pr block takes an optional alsoTouched; prMetaOf reports it, [] when absent', () => {
  const wide = { ...pr, alsoTouched: ['connect', 'ci'] };
  assert.ok(PrBlock.safeParse(wide).success);
  assert.ok(!PrBlock.safeParse({ ...pr, alsoTouched: [] }).success);
  const read = readPrBlock(`Text.\n\n${encodeBlock(wide)}`);
  assert.equal(read.status, 'ok');
  if (read.status !== 'ok') return;
  assert.deepEqual(read.block.alsoTouched, ['connect', 'ci']);
  assert.deepEqual(prMetaOf(read.block).alsoTouched, ['connect', 'ci']);
  const plain = readPrBlock(`Text.\n\n${encodeBlock(pr)}`);
  assert.equal(plain.status, 'ok');
  if (plain.status === 'ok') assert.deepEqual(prMetaOf(plain.block).alsoTouched, []);
});
