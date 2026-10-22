// The mergeable backoff (03 §5.1 mergeable.test.ts): 1, 2, 3, 4, 5, 5 s, ≤20 s (30 s for merge).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  backoffDelays,
  MERGE_MERGEABLE_BUDGET_MS,
  MERGEABLE_BUDGET_MS,
  retryMergeable,
  toMergeable,
  toMergeState,
} from '../../../src/pr/snapshot/mergeable.ts';
import { ciEnv } from '../ci/_helpers.ts';
import { HEAD, isMergeable, mergeableReply, REPO } from './snapshot-fixture.ts';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

test('the schedule is 1, 2, 3, 4, 5, 5 s for 20 s, continuing at 5 s to 30 s for merge', () => {
  assert.deepEqual(backoffDelays(MERGEABLE_BUDGET_MS), [1000, 2000, 3000, 4000, 5000, 5000]);
  assert.equal(sum(backoffDelays(MERGEABLE_BUDGET_MS)), 20_000);
  assert.deepEqual(backoffDelays(MERGE_MERGEABLE_BUDGET_MS), [1000, 2000, 3000, 4000, 5000, 5000, 5000, 5000]);
  assert.equal(sum(backoffDelays(MERGE_MERGEABLE_BUDGET_MS)), 30_000);
  assert.deepEqual(backoffDelays(5500), [1000, 2000]);
});

test('unknown future values read as UNKNOWN, never as mergeable', () => {
  assert.equal(toMergeable('MAYBE'), 'UNKNOWN');
  assert.equal(toMergeState('QUEUED'), 'UNKNOWN');
  assert.equal(toMergeState('DIRTY'), 'DIRTY');
});

async function run(replies: ReturnType<typeof mergeableReply>[], budgetMs?: number) {
  const env = ciEnv();
  env.fake.on(isMergeable, replies);
  const p = retryMergeable({
    gh: env.gh,
    clock: env.clock,
    repo: REPO,
    number: 3301,
    headSha: HEAD,
    ...(budgetMs ? { budgetMs } : {}),
  });
  await env.clock.advance(60_000);
  return { r: await p, at: env.fake.calls.map((c) => c.at) };
}

test('a PR that closes mid-retry stops the retry', async () => {
  const { r } = await run([mergeableReply('UNKNOWN', { state: 'MERGED' })]);
  assert.equal(r.kind, 'not-open');
  assert.equal(r.queries, 1);
});

test('the merge budget makes 8 re-queries; the last at t=30 s', async () => {
  const { r, at } = await run([mergeableReply('UNKNOWN')], MERGE_MERGEABLE_BUDGET_MS);
  assert.equal(r.kind, 'unknown');
  assert.deepEqual(at, [1000, 3000, 6000, 10_000, 15_000, 20_000, 25_000, 30_000]);
});

test('CONFLICTING settles the retry with the new mergeStateStatus', async () => {
  const { r } = await run([mergeableReply('UNKNOWN'), mergeableReply('CONFLICTING', { mergeState: 'DIRTY' })]);
  assert.deepEqual(r.kind === 'settled' && [r.mergeable, r.mergeStateStatus, r.queries], ['CONFLICTING', 'DIRTY', 2]);
});

test('a known mergeable with an UNKNOWN mergeStateStatus keeps retrying until the state is known', async () => {
  const { r } = await run([
    mergeableReply('MERGEABLE', { mergeState: 'UNKNOWN' }),
    mergeableReply('MERGEABLE', { mergeState: 'BEHIND' }),
  ]);
  assert.deepEqual(r.kind === 'settled' && [r.mergeable, r.mergeStateStatus, r.queries], ['MERGEABLE', 'BEHIND', 2]);
});

test('a mergeStateStatus that stays UNKNOWN ends `unknown`, carrying the known mergeable', async () => {
  const { r } = await run([mergeableReply('MERGEABLE', { mergeState: 'UNKNOWN' })]);
  assert.equal(r.kind, 'unknown');
  assert.equal(r.kind === 'unknown' && r.mergeable, 'MERGEABLE');
  assert.equal(r.queries, 6);
});
