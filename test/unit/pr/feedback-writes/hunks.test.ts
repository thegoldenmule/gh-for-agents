// Diff-hunk placement for inline findings (02 §7.2; 03 M11.2): inside, at the edge of, and outside a hunk;
// LEFT and RIGHT; a range across two hunks; a file without a patch.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inHunk, parseHunks } from '../../../../src/pr/feedback-writes/hunks.ts';

const PATCH = [
  '@@ -10,6 +10,8 @@ export function retry() {',
  ' a',
  '-b',
  '+b2',
  '+b3',
  '+b4',
  ' c',
  ' d',
  ' e',
  '@@ -40 +42,0 @@',
  '-gone',
  '@@ -100,3 +100,3 @@',
  ' x',
].join('\n');

test('ranges per side come from the hunk headers; a count of 0 has no lines, a missing count is 1', () => {
  assert.deepEqual(parseHunks(PATCH), {
    LEFT: [
      [10, 15],
      [40, 40],
      [100, 102],
    ],
    RIGHT: [
      [10, 17],
      [100, 102],
    ],
  });
});

test('inside, at the edges, and outside a hunk', () => {
  const h = parseHunks(PATCH);
  assert.equal(inHunk(h, 'RIGHT', 12), true);
  assert.equal(inHunk(h, 'RIGHT', 10), true);
  assert.equal(inHunk(h, 'RIGHT', 17), true);
  assert.equal(inHunk(h, 'RIGHT', 9), false);
  assert.equal(inHunk(h, 'RIGHT', 18), false);
  assert.equal(inHunk(h, 'RIGHT', 42), false, 'a pure deletion has no RIGHT lines');
  assert.equal(inHunk(h, 'LEFT', 40), true);
  assert.equal(inHunk(h, 'LEFT', 16), false);
});

test('a range must sit inside one hunk', () => {
  const h = parseHunks(PATCH);
  assert.equal(inHunk(h, 'RIGHT', 11, 17), true);
  assert.equal(inHunk(h, 'RIGHT', 16, 100), false);
  assert.equal(inHunk(h, 'RIGHT', 17, 18), false);
});

test('a file without a patch (binary or too large) has no commentable lines', () => {
  assert.deepEqual(parseHunks(undefined), { LEFT: [], RIGHT: [] });
  assert.equal(inHunk(parseHunks(undefined), 'RIGHT', 1), false);
});
