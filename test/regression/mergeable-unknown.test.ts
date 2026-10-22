// R03 (03 §5.2). Guards [G-UNKNOWN]: `mergeable` was UNKNOWN before 20 of 52 merges (§5.2, §7 #3204).
// The snapshot retries with sleeps of 1, 2, 3, 4, 5, 5 s on the clock, settles as soon as GitHub knows,
// reports settled:false with a warning when it never does, and restarts once on a head change.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchPrSnapshot, MERGE_MERGEABLE_BUDGET_MS } from '../../src/pr/snapshot/index.ts';
import { ciEnv } from '../unit/ci/_helpers.ts';
import {
  HEAD,
  isMergeable,
  isQ1,
  isQ2,
  mergeableReply,
  q1Pr,
  q1Reply,
  q2Reply,
  REPO,
  snapshotConfig,
} from '../unit/pr/snapshot-fixture.ts';

const NEW_HEAD = 'e'.repeat(40);

function setup(
  mergeable: ReturnType<typeof mergeableReply>[],
  q1 = [q1Reply(q1Pr({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }))],
) {
  const env = ciEnv();
  env.fake.on(isQ1, q1).on(isMergeable, mergeable).on(isQ2, q2Reply());
  return env;
}

async function settle<T>(env: ReturnType<typeof setup>, p: Promise<T>): Promise<T> {
  await env.clock.advance(120_000);
  return p;
}

test('R03: UNKNOWN×3 then MERGEABLE settles after 4 queries and sleeps of 1+2+3 s', async () => {
  const env = setup([mergeableReply('UNKNOWN'), mergeableReply('UNKNOWN'), mergeableReply('MERGEABLE')]);
  const s = await settle(
    env,
    fetchPrSnapshot({ gh: env.gh, clock: env.clock, repo: REPO, number: 3301, config: snapshotConfig() }),
  );
  assert.equal(s.merge.mergeable, 'MERGEABLE');
  assert.equal(s.merge.settled, true);
  assert.equal(s.merge.mergeStateStatus, 'CLEAN');
  const mergeableQueries = env.fake.calls.filter((c) => isQ1(c.argv) || isMergeable(c.argv));
  assert.equal(mergeableQueries.length, 4);
  assert.deepEqual(
    mergeableQueries.map((c) => c.at),
    [0, 1000, 3000, 6000],
  );
  assert.deepEqual(s.warnings, []);
});

test('R03: still UNKNOWN after 20 s gives settled:false and a MERGEABLE_UNKNOWN warning', async () => {
  const env = setup([mergeableReply('UNKNOWN')]);
  const s = await settle(
    env,
    fetchPrSnapshot({ gh: env.gh, clock: env.clock, repo: REPO, number: 3301, config: snapshotConfig() }),
  );
  assert.deepEqual([s.merge.mergeable, s.merge.settled, s.merge.retries], ['UNKNOWN', false, 6]);
  assert.equal(env.fake.calls.filter((c) => isMergeable(c.argv)).at(-1)?.at, 20_000);
  assert.deepEqual(
    s.warnings.map((w) => w.code),
    ['MERGEABLE_UNKNOWN'],
  );
});

test('R03: the merge budget keeps asking until 30 s; --no-wait-mergeable never retries', async () => {
  const env = setup([mergeableReply('UNKNOWN')]);
  const s = await settle(
    env,
    fetchPrSnapshot({
      gh: env.gh,
      clock: env.clock,
      repo: REPO,
      number: 3301,
      config: snapshotConfig(),
      mergeableBudgetMs: MERGE_MERGEABLE_BUDGET_MS,
    }),
  );
  assert.equal(s.merge.retries, 8);
  assert.equal(env.fake.calls.filter((c) => isMergeable(c.argv)).at(-1)?.at, 30_000);

  const env2 = setup([mergeableReply('MERGEABLE')]);
  const s2 = await fetchPrSnapshot({
    gh: env2.gh,
    clock: env2.clock,
    repo: REPO,
    number: 3301,
    config: snapshotConfig(),
    waitMergeable: false,
  });
  assert.deepEqual([s2.merge.mergeable, s2.merge.settled, s2.merge.retries], ['UNKNOWN', false, 0]);
  env2.fake.expectNoCall(isMergeable);
});

test('R03: a head change mid-retry restarts the read once, then reports', async () => {
  const unknownAt = (head: string) =>
    q1Reply(q1Pr({ headRefOid: head, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }));
  const env = setup(
    [mergeableReply('UNKNOWN', { head: NEW_HEAD }), mergeableReply('MERGEABLE', { head: NEW_HEAD })],
    [unknownAt(HEAD), unknownAt(NEW_HEAD)],
  );
  const s = await settle(
    env,
    fetchPrSnapshot({ gh: env.gh, clock: env.clock, repo: REPO, number: 3301, config: snapshotConfig() }),
  );
  assert.equal(s.head.sha, NEW_HEAD);
  assert.deepEqual([s.merge.mergeable, s.merge.settled], ['MERGEABLE', true]);
  assert.equal(env.fake.calls.filter((c) => isQ1(c.argv)).length, 2);

  // A second head change is reported, not chased.
  const env2 = setup([mergeableReply('UNKNOWN', { head: 'f'.repeat(40) })], [unknownAt(HEAD), unknownAt(NEW_HEAD)]);
  const s2 = await settle(
    env2,
    fetchPrSnapshot({ gh: env2.gh, clock: env2.clock, repo: REPO, number: 3301, config: snapshotConfig() }),
  );
  assert.equal(s2.merge.settled, false);
  assert.deepEqual(
    s2.warnings.map((w) => w.code),
    ['HEAD_CHANGED'],
  );
  assert.equal(env2.fake.calls.filter((c) => isQ1(c.argv)).length, 2);
});

test('R03: a merged PR reads UNKNOWN without retrying', async () => {
  const env = setup([mergeableReply('UNKNOWN')], [q1Reply(q1Pr({ state: 'MERGED', mergeable: 'UNKNOWN' }))]);
  const s = await fetchPrSnapshot({ gh: env.gh, clock: env.clock, repo: REPO, number: 3301, config: snapshotConfig() });
  assert.equal(s.merge.settled, false);
  env.fake.expectNoCall(isMergeable);
});
