import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isGhxError } from '../../../src/core/errors.ts';
import { seededRandom } from '../../../src/core/random.ts';
import { IdAllocator, idKind, newId } from '../../../src/meta/ids.ts';
import { Id } from '../../../src/schemas/common.ts';

test('ids are prefix plus 6 lowercase Crockford chars, never i l o u', () => {
  const r = seededRandom(1);
  for (const kind of ['pr', 'review', 'finding', 'comment'] as const) {
    for (let i = 0; i < 500; i++) {
      const id = newId(kind, r);
      assert.ok(Id.safeParse(id).success, id);
      assert.equal(id[0], { pr: 'p', review: 'r', finding: 'f', comment: 'c' }[kind]);
      assert.doesNotMatch(id.slice(2), /[ilou]/);
    }
  }
});

test('newId is deterministic under a seeded Random and skips taken ids', () => {
  const first = newId('finding', seededRandom(7));
  assert.equal(newId('finding', seededRandom(7)), first);
  assert.notEqual(newId('finding', seededRandom(7), new Set([first])), first);
});

test('IdAllocator keeps ids unique per PR across a write', () => {
  const existing = ['f_aaaaaa', 'r_bbbbbb'];
  const a = new IdAllocator(seededRandom(3), existing);
  const ids = Array.from({ length: 2000 }, (_, i) => a.next(i % 2 ? 'finding' : 'comment'));
  assert.equal(new Set([...ids, ...existing]).size, ids.length + existing.length);
});

test('a Random that cannot produce a fresh id fails as INTERNAL instead of looping', () => {
  const stuck = { next: () => 0 };
  const taken = new Set([newId('comment', stuck)]);
  assert.throws(
    () => newId('comment', stuck, taken),
    (e: unknown) => isGhxError(e) && e.code === 'INTERNAL',
  );
});

test('idKind recognises ghx ids only', () => {
  assert.equal(idKind('f_h4x8pz'), 'finding');
  assert.equal(idKind('c_w5j1ve'), 'comment');
  assert.equal(idKind('ic:2412345678'), null);
  assert.equal(idKind('f_h4x8pZ'), null);
});
