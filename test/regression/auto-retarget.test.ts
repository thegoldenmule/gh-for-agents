// R09 (03 §5.2). Guards [G-RETARGET]: #3194 and #3195 were auto-retargeted when their parent merged, and
// agents dug through the timeline to notice (§4.1, §2.4). The snapshot reports the change in
// stack.baseChanges, and declaredParent (from the pr block) no longer matches the actual parent.
// The policy engine warns BASE_CHANGED for a base change under 24 h old.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snapshotSummary } from '../../src/ci/snapshot.ts';
import { encode } from '../../src/meta/codec.ts';
import { evaluateMerge } from '../../src/policy/merge.ts';
import { fetchPrSnapshot, type PrSnapshot } from '../../src/pr/snapshot/index.ts';
import { ciEnv } from '../unit/ci/_helpers.ts';
import { config } from '../unit/policy/_helpers.ts';
import { isQ1, isQ2, q1Pr, q1Reply, q2Reply, REPO, snapshotConfig } from '../unit/pr/snapshot-fixture.ts';

const block = encode({
  t: 'pr',
  id: 'p_k3m9qa',
  gen: 'ghx/0.1.0',
  rev: 1,
  title: 'feat(reactor): mr-08d',
  description: 'x',
  testing: [{ kind: 'unit', command: 'pnpm test', result: 'pass' }],
  risk: 'low',
  components: ['reactor'],
  revertPolicy: 'coordinated',
  revertWith: ['#3184'],
  refs: { stackedOn: '#3184' },
});

async function retargetedSnapshot(timeline: unknown[]): Promise<PrSnapshot> {
  const env = ciEnv();
  env.fake
    .on(
      isQ1,
      q1Reply(
        q1Pr({
          body: `Stacked on mr-08c.\n\n${block}`,
          timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: timeline },
        }),
      ),
    )
    .on(isQ2, q2Reply({ children: { nodes: [] } }));
  return fetchPrSnapshot({ gh: env.gh, clock: env.clock, repo: REPO, number: 3301, config: snapshotConfig() });
}

const AUTO_EVENT = {
  __typename: 'AutomaticBaseChangeSucceededEvent',
  createdAt: '2026-10-22T08:00:00Z',
  oldBase: 'feat/mr-08c',
  newBase: 'main',
};

test('R09: AUTOMATIC_BASE_CHANGE_SUCCEEDED_EVENT gives an automatic baseChange; declaredParent ≠ parent', async () => {
  const s = await retargetedSnapshot([AUTO_EVENT]);
  assert.deepEqual(s.stack.baseChanges, [
    { from: 'feat/mr-08c', to: 'main', at: '2026-10-22T08:00:00Z', automatic: true },
  ]);
  assert.equal(s.stack.declaredParent, 'powerhouse-inc/powerhouse#3184');
  assert.equal(s.stack.parent, null);
  assert.notEqual(s.stack.declaredParent, s.stack.parent);
});

test('R09: a manual BASE_REF_CHANGED_EVENT gives automatic:false', async () => {
  const s = await retargetedSnapshot([
    {
      __typename: 'BaseRefChangedEvent',
      createdAt: '2026-10-22T08:00:00Z',
      previousRefName: 'feat/mr-08c',
      currentRefName: 'main',
    },
  ]);
  assert.deepEqual(s.stack.baseChanges, [
    { from: 'feat/mr-08c', to: 'main', at: '2026-10-22T08:00:00Z', automatic: false },
  ]);
});

test('R09: a base change under 24 h old is a merge warning, not a blocker; after 24 h it is quiet', async () => {
  const s = await retargetedSnapshot([AUTO_EVENT]);
  const at = (iso: string) =>
    evaluateMerge({
      snapshot: s,
      ci: snapshotSummary(s.ci),
      feedback: s.feedback,
      config: config(),
      now: Date.parse(iso),
    });
  const fresh = at('2026-10-22T09:15:00Z');
  assert.equal(fresh.ready, true);
  const w = fresh.warnings.find((x) => x.code === 'BASE_CHANGED');
  assert.match(w?.message ?? '', /feat\/mr-08c to main .*automatic retarget/);
  assert.ok(!at('2026-10-23T09:00:00Z').warnings.some((x) => x.code === 'BASE_CHANGED'));
});
