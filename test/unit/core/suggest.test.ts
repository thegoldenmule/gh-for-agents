import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editDistance, suggest } from '../../../src/core/suggest.ts';

test('Damerau-Levenshtein counts a transposition as one edit', () => {
  assert.equal(editDistance('stauts', 'status'), 1);
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.equal(editDistance('', 'abc'), 3);
  assert.equal(editDistance('same', 'same'), 0);
});

test('suggest ranks by distance and caps the count', () => {
  assert.deepEqual(suggest('--jsno', ['--json', '--repo', '--input']), ['--json']);
  assert.deepEqual(suggest('componets', ['components', 'checks', 'merge']), ['components']);
  assert.deepEqual(suggest('zzz', ['status', 'merge']), []);
  assert.deepEqual(suggest('a', ['b', 'c', 'd', 'e'], { max: 2 }), ['b', 'c']);
});

test('a prefix of a longer candidate is suggested', () => {
  assert.deepEqual(suggest('stat', ['status', 'create']), ['status']);
});

test('exact matches are not suggestions; matching is case-insensitive', () => {
  assert.deepEqual(suggest('Status', ['status', 'statuz']), ['statuz']);
});
