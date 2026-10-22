import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crockford, jitter, seededRandom } from '../../../src/core/random.ts';

test('seededRandom is deterministic and in [0,1)', () => {
  const a = seededRandom(42);
  const b = seededRandom(42);
  for (let i = 0; i < 100; i++) {
    const x = a.next();
    assert.equal(x, b.next());
    assert.ok(x >= 0 && x < 1);
  }
});

test('jitter stays within ±fraction', () => {
  const r = seededRandom(1);
  for (let i = 0; i < 200; i++) {
    const v = jitter(1_000, 0.1, r);
    assert.ok(v >= 900 && v <= 1_100, String(v));
  }
  assert.equal(jitter(1_000, 0, r), 1_000);
});

test('crockford ids use the 02 §1.4 alphabet', () => {
  const id = crockford(6, seededRandom(7));
  assert.match(id, /^[0-9a-hjkmnp-tv-z]{6}$/);
});
