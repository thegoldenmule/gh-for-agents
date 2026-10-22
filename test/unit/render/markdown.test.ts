import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inlineCode, joinParagraphs, joinTrailer } from '../../../src/render/markdown.ts';

test('inlineCode picks a fence longer than any backtick run', () => {
  assert.equal(inlineCode('pnpm test'), '`pnpm test`');
  assert.equal(inlineCode('a `b` c'), '``a `b` c``');
  assert.equal(inlineCode('a ``b`` c'), '```a ``b`` c```');
  assert.equal(inlineCode('`x'), '`` `x ``');
});

test('joinTrailer and joinParagraphs drop empty parts', () => {
  assert.equal(joinTrailer(['a', null, '', undefined, 'b']), 'a · b');
  assert.equal(joinParagraphs(['a', null, ' ', 'b']), 'a\n\nb');
});
