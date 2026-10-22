import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { boundText, byteLength, createWritableSink, serializeJson, truncateBytes } from '../../../src/core/output.ts';

test('boundText keeps the head by default and reports truncation', () => {
  const r = boundText('a\nb\nc\nd\n', { maxLines: 2, maxBytes: 100 });
  assert.deepEqual(r, { excerpt: 'a\nb', truncated: true, totalLines: 4 });
});

test('boundText can keep the tail', () => {
  const r = boundText('a\nb\nc\nd', { maxLines: 2, maxBytes: 100, keep: 'tail' });
  assert.deepEqual(r, { excerpt: 'c\nd', truncated: true, totalLines: 4 });
});

test('boundText enforces the byte bound without splitting characters', () => {
  const r = boundText('é'.repeat(10), { maxLines: 10, maxBytes: 5 });
  assert.equal(r.truncated, true);
  assert.ok(byteLength(r.excerpt) <= 5);
  assert.equal(r.excerpt, 'éé');
  const t = boundText(`x\n${'é'.repeat(10)}`, { maxLines: 10, maxBytes: 5, keep: 'tail' });
  assert.ok(byteLength(t.excerpt) <= 5);
  assert.ok(!t.excerpt.includes('�'));
});

test('boundText of short text is untouched', () => {
  assert.deepEqual(boundText('ok', { maxLines: 5, maxBytes: 50 }), { excerpt: 'ok', truncated: false, totalLines: 1 });
  assert.deepEqual(boundText('', { maxLines: 5, maxBytes: 50 }), { excerpt: '', truncated: false, totalLines: 0 });
});

test('truncateBytes', () => {
  assert.equal(truncateBytes('abc', 10), 'abc');
  assert.equal(truncateBytes('😀😀', 5), '😀');
});

test('serializeJson is compact unless pretty', () => {
  assert.equal(serializeJson({ a: [1] }), '{"a":[1]}');
  assert.equal(serializeJson({ a: 1 }, true), '{\n  "a": 1\n}');
});

class FakeStream extends EventEmitter {
  written: string[] = [];
  pending: ((err?: Error | null) => void)[] = [];
  write(chunk: string, cb: (err?: Error | null) => void): boolean {
    this.written.push(chunk);
    this.pending.push(cb);
    return true;
  }
}

test('writable sink resolves only when the write callback fires', async () => {
  const s = new FakeStream();
  const sink = createWritableSink(s);
  let done = false;
  const p = sink.writeLine('{"a":1}').then(() => {
    done = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false);
  s.pending.shift()?.();
  await p;
  assert.equal(done, true);
  assert.deepEqual(s.written, ['{"a":1}\n']);
});

test('EPIPE closes the sink quietly and fires onClosed once', async () => {
  const s = new FakeStream();
  let closedCalls = 0;
  const sink = createWritableSink(s, () => closedCalls++);
  const p = sink.writeLine('x');
  const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  s.pending.shift()?.(epipe);
  await p;
  s.emit('error', epipe);
  assert.equal(sink.closed, true);
  assert.equal(closedCalls, 1);
  await sink.writeLine('dropped');
  assert.equal(s.written.length, 1);
});
