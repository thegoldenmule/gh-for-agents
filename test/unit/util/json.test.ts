import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lineColumnAt, parseJsonWithPosition, stableStringify } from '../../../src/util/json.ts';

test('stableStringify sorts keys at every depth and drops undefined', () => {
  assert.equal(
    stableStringify({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined } }),
    '{"a":{"d":[{"y":2,"z":1}]},"b":1}',
  );
  assert.equal(stableStringify({ b: 1, a: 2 }, 2), '{\n  "a": 2,\n  "b": 1\n}');
});

test('stableStringify throws on cycles', () => {
  const o: Record<string, unknown> = {};
  o.self = o;
  assert.throws(() => stableStringify(o), /circular/);
});

test('parseJsonWithPosition returns the value on success, ignoring a BOM', () => {
  assert.deepEqual(parseJsonWithPosition('﻿{"a":1}'), { ok: true, value: { a: 1 } });
});

test('parse errors carry 1-based line and column', () => {
  const r = parseJsonWithPosition('{\n  "a": 1,\n  }\n');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.line, 3);
    assert.equal(r.column, 3);
    assert.ok(r.message.length > 0);
  }
});

test('truncated JSON reports the end position', () => {
  const r = parseJsonWithPosition('{"a":');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.line, 1);
});

test('lineColumnAt', () => {
  assert.deepEqual(lineColumnAt('ab\ncd', 4), { line: 2, column: 2 });
});
