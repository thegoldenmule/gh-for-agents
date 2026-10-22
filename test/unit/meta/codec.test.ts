import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { isGhxError } from '../../../src/core/errors.ts';
import { decode, decodeAll, encode, escapeJson, MAX_BODY_CHARS, strip, upsert } from '../../../src/meta/codec.ts';

const Any = z.record(z.string(), z.unknown());
const SCHEMAS = { 1: Any };
const body = (f: string) => readFileSync(join(import.meta.dirname, '../../fixtures/bodies', f), 'utf8');

test('exact bytes: a --> b is stored as "a --\\u003e b" (03 §1 row 8)', () => {
  assert.equal(encode({ t: 'a --> b' }), '<!-- ghx:v1 {"t":"a --\\u003e b"} -->');
  assert.equal(escapeJson('"<&>"'), '"\\u003c\\u0026\\u003e"');
});

test('keys are sorted and the block is one line', () => {
  const e = encode({ z: 1, a: { y: 2, b: 'x\ny' } });
  assert.equal(e, '<!-- ghx:v1 {"a":{"b":"x\\ny","y":2},"z":1} -->');
  assert.ok(!e.includes('\n'));
});

const NASTY = [
  '-->',
  '--!>',
  '<!--',
  '<script>alert(1)</script>',
  '&amp;',
  'line\nbreak',
  '😀 emoji',
  'sep arator',
  '}\n-->',
  '"quoted"',
];

test('round-trip of strings that would break an HTML comment; no raw < > & in the JSON', () => {
  for (const s of NASTY) {
    const data = { t: 'pr', title: s, nested: [s, { s }] };
    const block = encode(data);
    const json = block.slice('<!-- ghx:v1 '.length, -' -->'.length);
    assert.ok(!/[<>&]/.test(json), s);
    const d = decode<typeof data>(`text\n\n${block}`, SCHEMAS);
    assert.equal(d.status, 'ok', s);
    if (d.status === 'ok') assert.deepEqual(d.data, data);
  }
});

test('absent: plain bodies and other HTML comments', () => {
  assert.deepEqual(decode(body('no-block-human.md'), SCHEMAS), { status: 'absent' });
  assert.deepEqual(decode(body('ci-duration-watch-bot.md'), SCHEMAS), { status: 'absent' });
  assert.deepEqual(decodeAll('', SCHEMAS), []);
});

test('real structured body decodes; escapes in the fixture decode to the characters', () => {
  const d = decode<{ title: string }>(body('structured-v1.md'), SCHEMAS);
  assert.equal(d.status, 'ok');
  if (d.status === 'ok') {
    assert.equal(d.data.title, 'fix(reactor): bind document id before dispatch <v2> & retry');
    assert.equal(d.version, 1);
    assert.equal(body('structured-v1.md').slice(...d.range), d.raw);
  }
});

test('unknown version is invalid/unsupported-version; malformed JSON is invalid/json; never throws', () => {
  const v2 = decode(body('structured-v2-future.md'), SCHEMAS);
  assert.equal(v2.status, 'invalid');
  if (v2.status === 'invalid') {
    assert.equal(v2.reason, 'unsupported-version');
    assert.equal(v2.version, 2);
  }
  assert.deepEqual(decode(body('malformed-block.md'), SCHEMAS).status, 'absent');
  const truncated = decode('<!-- ghx:v1 {"t":"pr", "x": } -->', SCHEMAS);
  assert.equal(truncated.status === 'invalid' && truncated.reason, 'json');
});

test('schema failures are invalid/schema with issues', () => {
  const Strict = { 1: z.strictObject({ t: z.literal('pr') }) };
  const d = decode('<!-- ghx:v1 {"t":"review"} -->', Strict);
  assert.equal(d.status === 'invalid' && d.reason, 'schema');
  assert.ok(d.status === 'invalid' && Array.isArray(d.issues));
});

test('multiple blocks: decodeAll in order, decode picks the last, first-valid on request', () => {
  const b = body('two-pr-blocks.md');
  const all = decodeAll(b, SCHEMAS);
  assert.deepEqual(
    all.map((d) => d.status === 'ok' && (d.data as { title: string }).title),
    ['first', 'second'],
  );
  const last = decode<{ title: string }>(b, SCHEMAS);
  assert.equal(last.status === 'ok' && last.data.title, 'second');
  const first = decode<{ title: string }>(`<!-- ghx:v1 {"broken": } -->\n${b}`, SCHEMAS, { pick: 'first-valid' });
  assert.equal(first.status === 'ok' && first.data.title, 'first');
  const none = decode('<!-- ghx:v1 {"broken": } -->', SCHEMAS, { pick: 'first-valid' });
  assert.equal(none.status, 'invalid');
});

test('CRLF bodies and extra marker whitespace still decode', () => {
  const d = decode<{ title: string }>(body('crlf.md'), SCHEMAS);
  assert.equal(d.status === 'ok' && d.data.title, 'crlf');
});

test('strip returns the visible text only', () => {
  assert.equal(strip(body('two-pr-blocks.md')), 'Two blocks after a bad merge of edits.');
  assert.equal(strip(body('crlf.md')), 'Line one.\r\nLine two.');
  assert.equal(strip('no blocks here\n'), 'no blocks here');
  assert.ok(strip(body('no-block-human.md')).includes('<!-- ci-duration-watch -->'));
});

test('upsert appends after the footer with one blank line, replaces in place, and is idempotent', () => {
  const footer = 'Fix it.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n';
  const once = upsert(footer, { t: 'pr', rev: 1 });
  assert.equal(
    once,
    `Fix it.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n${encode({ t: 'pr', rev: 1 })}`,
  );
  assert.equal(upsert(once, { t: 'pr', rev: 1 }), once);
  const bumped = upsert(once, { t: 'pr', rev: 2 });
  assert.equal(decodeAll(bumped, SCHEMAS).length, 1);
  assert.equal(strip(bumped), strip(once));
  const two = upsert(body('two-pr-blocks.md'), { t: 'pr', title: 'third' });
  assert.deepEqual(
    decodeAll(two, SCHEMAS).map((d) => d.status === 'ok' && (d.data as { title: string }).title),
    ['first', 'third'],
  );
  assert.equal(upsert('', { a: 1 }), encode({ a: 1 }));
});

test('size guard: body plus block over 65,536 chars is META_TOO_LARGE', () => {
  assert.throws(
    () => upsert('x'.repeat(MAX_BODY_CHARS - 10), { t: 'pr' }),
    (e) => isGhxError(e, 'META_TOO_LARGE'),
  );
  assert.ok(upsert('x'.repeat(MAX_BODY_CHARS - 40), { a: 1 }).length <= MAX_BODY_CHARS);
});

test('a malformed block never swallows the human text up to the next block', () => {
  const human = 'This paragraph was written by a human and must survive.';
  const valid = encode({ t: 'pr', rev: 3 });
  const text = `Intro.\n\n<!-- ghx:v1 {"t":"pr","id":"p_k3m9qa", -->\n\n${human}\n\n${valid}\n`;
  const all = decodeAll(text, SCHEMAS);
  assert.equal(all.length, 1, 'the broken block is not a block');
  assert.equal(all[0]?.status, 'ok');
  assert.equal(all[0]?.raw, valid);
  assert.ok(strip(text).includes(human), 'strip keeps the paragraph');
  const updated = upsert(text, { t: 'pr', rev: 4 });
  assert.ok(updated.includes(human), 'upsert keeps the paragraph');
  assert.ok(updated.includes(encode({ t: 'pr', rev: 4 })));
  assert.ok(updated.includes('<!-- ghx:v1 {"t":"pr","id":"p_k3m9qa", -->'), 'the broken text is left alone');
});
