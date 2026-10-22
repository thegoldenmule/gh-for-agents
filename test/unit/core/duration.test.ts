import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDuration, parseDuration } from '../../../src/core/duration.ts';

test('parses units and compounds', () => {
  assert.deepEqual(parseDuration('90s'), { ok: true, ms: 90_000 });
  assert.deepEqual(parseDuration('10m'), { ok: true, ms: 600_000 });
  assert.deepEqual(parseDuration('2h'), { ok: true, ms: 7_200_000 });
  assert.deepEqual(parseDuration('1h30m'), { ok: true, ms: 5_400_000 });
  assert.deepEqual(parseDuration('500ms'), { ok: true, ms: 500 });
  assert.deepEqual(parseDuration('1.5m'), { ok: true, ms: 90_000 });
  assert.deepEqual(parseDuration(' 2H '), { ok: true, ms: 7_200_000 });
});

test('rejects bare numbers and junk', () => {
  for (const bad of ['', '90', '10x', 'm', '1h 30m', 'abc', '5s5']) {
    const r = parseDuration(bad);
    assert.equal(r.ok, false, bad);
  }
});

test('formats compactly', () => {
  assert.equal(formatDuration(500), '500ms');
  assert.equal(formatDuration(90_000), '1m30s');
  assert.equal(formatDuration(7_200_000), '2h');
  assert.equal(formatDuration(0), '0ms');
  assert.equal(formatDuration(1_000), '1s');
});
