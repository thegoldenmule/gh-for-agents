// Stack info and Q2 (03 M6.3 stack.test.ts): declaredParent differs from the actual parent; children are listed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encode } from '../../../src/meta/codec.ts';
import { fetchPrSnapshot } from '../../../src/pr/snapshot/index.ts';
import { baseChangesOf, normalisePrRef, q2Query } from '../../../src/pr/snapshot/stack.ts';
import { ciEnv } from '../ci/_helpers.ts';
import { isQ1, isQ2, q1Pr, q1Reply, q2Reply, REPO, snapshotConfig } from './snapshot-fixture.ts';

const prBlock = (stackedOn: string) =>
  encode({
    t: 'pr',
    id: 'p_k3m9qa',
    gen: 'ghx/0.1.0',
    rev: 1,
    title: 'feat(reactor): x',
    description: 'x',
    testing: [{ kind: 'unit', command: 'pnpm test', result: 'pass' }],
    risk: 'low',
    components: ['reactor'],
    revertPolicy: 'revert-safe',
    refs: { stackedOn },
  });

const listPr = (number: number, o: { state?: string; head: string; base: string; repo?: string; draft?: boolean }) => ({
  number,
  state: o.state ?? 'OPEN',
  isDraft: o.draft ?? false,
  headRefName: o.head,
  baseRefName: o.base,
  headRepository: { nameWithOwner: o.repo ?? 'powerhouse-inc/powerhouse' },
});

test('a stacked PR: the open same-repo parent wins; children are listed; declaredParent comes from the block', async () => {
  const env = ciEnv();
  env.fake
    .on(
      isQ1,
      q1Reply(q1Pr({ baseRefName: 'feat/mr-08c', headRefName: 'feat/mr-08d', body: `x\n\n${prBlock('#3184')}` })),
    )
    .on(
      isQ2,
      q2Reply({
        parents: {
          nodes: [
            listPr(3190, { head: 'feat/mr-08c', base: 'main', repo: 'someone/fork' }),
            listPr(3185, { head: 'feat/mr-08c', base: 'main', state: 'CLOSED' }),
            listPr(3184, { head: 'feat/mr-08c', base: 'main' }),
          ],
        },
        children: { nodes: [listPr(3302, { head: 'feat/mr-08e', base: 'feat/mr-08d', draft: true })] },
      }),
    );
  const s = await fetchPrSnapshot({ gh: env.gh, clock: env.clock, repo: REPO, number: 3301, config: snapshotConfig() });
  assert.deepEqual(s.stack, {
    parent: { ref: 'powerhouse-inc/powerhouse#3184', state: 'OPEN', draft: false, headRef: 'feat/mr-08c' },
    declaredParent: 'powerhouse-inc/powerhouse#3184',
    children: [{ ref: 'powerhouse-inc/powerhouse#3302', state: 'OPEN', draft: true, headRef: 'feat/mr-08e' }],
    baseChanges: [],
  });
  const q = env.fake.calls.find((c) => isQ2(c.argv))?.argv ?? [];
  assert.ok(q.includes('base=feat/mr-08c') && q.includes('head=feat/mr-08d'));
});

test('on the default branch Q2 asks for children only; a fork head asks for nothing and Q2 is skipped', () => {
  const plain = q2Query({ repo: REPO, wantParent: false, wantChildren: true, conditionRefs: [] });
  assert.ok(!plain.query.includes('parents:') && plain.query.includes('children:'));
});

test('a fork head with no preconditions makes no Q2 call', async () => {
  const env = ciEnv();
  env.fake.on(isQ1, q1Reply(q1Pr({ isCrossRepository: true, headRepository: { nameWithOwner: 'someone/fork' } })));
  const s = await fetchPrSnapshot({ gh: env.gh, clock: env.clock, repo: REPO, number: 3301, config: snapshotConfig() });
  assert.equal(s.queries, 1);
  assert.deepEqual(s.stack.children, []);
  assert.equal(s.head.crossRepository, true);
});

test('Q2 aliases: same-repo refs inline, cross-repo refs as their own repository field, duplicates once', () => {
  const plan = q2Query({
    repo: REPO,
    wantParent: false,
    wantChildren: false,
    conditionRefs: ['#3184', 'powerhouse-inc/powerhouse#3184', 'other-org/lib.js#12'],
  });
  assert.deepEqual(
    [...plan.aliases],
    [
      ['ref0', 'powerhouse-inc/powerhouse#3184'],
      ['ref1', 'other-org/lib.js#12'],
    ],
  );
  assert.match(plan.query, /ref0:pullRequest\(number:3184\)/);
  assert.match(plan.query, /ref1:repository\(owner:"other-org",name:"lib\.js"\)\{pullRequest\(number:12\)/);
});

test('baseChanges: automatic and manual changes, oldest first; a manual echo of an automatic change is dropped', () => {
  const changes = baseChangesOf([
    {
      __typename: 'BaseRefChangedEvent',
      createdAt: '2026-10-21T10:00:00Z',
      previousRefName: 'main',
      currentRefName: 'feat/a',
    },
    {
      __typename: 'AutomaticBaseChangeSucceededEvent',
      createdAt: '2026-10-21T12:00:00Z',
      oldBase: 'feat/a',
      newBase: 'main',
    },
    {
      __typename: 'BaseRefChangedEvent',
      createdAt: '2026-10-21T12:00:01Z',
      previousRefName: 'feat/a',
      currentRefName: 'main',
    },
    { __typename: 'SomethingNew' },
  ]);
  assert.deepEqual(changes, [
    { from: 'main', to: 'feat/a', at: '2026-10-21T10:00:00Z', automatic: false },
    { from: 'feat/a', to: 'main', at: '2026-10-21T12:00:00Z', automatic: true },
  ]);
});

test('normalisePrRef', () => {
  assert.equal(normalisePrRef('#12', REPO), 'powerhouse-inc/powerhouse#12');
  assert.equal(normalisePrRef('o/r#3', REPO), 'o/r#3');
  assert.equal(normalisePrRef('nope', REPO), null);
});
