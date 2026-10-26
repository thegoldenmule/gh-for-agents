// createNetworkRules (02 §2.1 "Network checks"): pure, with the GitHub data injected.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigSchema } from '../../../../src/config/schema.ts';
import {
  type CreateNetworkData,
  canonicalRef,
  collectRefs,
  createNetworkRules,
  touchedComponents,
} from '../../../../src/pr/create/rules.ts';
import type { PrCreateInput } from '../../../../src/pr/create/schema.ts';

const config = ConfigSchema.parse({
  version: 1,
  components: {
    reactor: { paths: ['packages/reactor/**'] },
    shared: { paths: ['packages/shared/**', 'libs/common/**'] },
    docs: {},
  },
});

function input(p: Partial<PrCreateInput> = {}): PrCreateInput {
  return {
    title: 'fix(reactor): x',
    description: 'x',
    testing: [{ kind: 'unit', command: 'pnpm test', result: 'pass' }],
    risk: 'low',
    components: ['reactor'],
    revertPolicy: 'revert-safe',
    base: 'main',
    head: 'fix/x',
    ...p,
  };
}

function data(p: Partial<CreateNetworkData> = {}): CreateNetworkData {
  return { repo: 'o/r', changedFiles: ['packages/reactor/src/a.ts'], baseParent: null, missingRefs: [], ...p };
}

test('a clean PR has no issues and no warnings', () => {
  assert.deepEqual(createNetworkRules(input(), config, data()), { issues: [], warnings: [], alsoTouched: [] });
});

test('components.undeclared_touched names the component and its files', () => {
  const files = [
    'packages/reactor/a.ts',
    'libs/common/x.ts',
    'libs/common/y.ts',
    'libs/common/z.ts',
    'libs/common/w.ts',
  ];
  const r = createNetworkRules(input(), config, data({ changedFiles: files }));
  assert.deepEqual(r.issues, [
    {
      path: 'components',
      code: 'components.undeclared_touched',
      message:
        "the PR changes shared (libs/common/x.ts, libs/common/y.ts, libs/common/z.ts, +1 more); add 'shared' to components",
    },
  ]);
  assert.deepEqual(
    createNetworkRules(input({ components: ['reactor', 'shared'] }), config, data({ changedFiles: files })).issues,
    [],
  );
});

test('paths that match no component are ignored', () => {
  assert.deepEqual(
    createNetworkRules(input(), config, data({ changedFiles: ['packages/reactor/a.ts', 'README.md'] })).issues,
    [],
  );
});

test('COMPONENTS_UNUSED for a declared component with paths but no changes; none for path-less ones', () => {
  const r = createNetworkRules(input({ components: ['reactor', 'shared', 'docs'] }), config, data());
  assert.deepEqual(r.issues, []);
  assert.deepEqual(
    r.warnings.map((w) => w.code),
    ['COMPONENTS_UNUSED'],
  );
  assert.match(r.warnings[0]?.message ?? '', /belongs to shared;/);
});

test('COMPONENTS_UNCHECKED when the changed files are unknown (over 300, no checkout)', () => {
  const r = createNetworkRules(input({ components: ['shared'] }), config, data({ changedFiles: null }));
  assert.deepEqual(r.issues, []);
  assert.deepEqual(
    r.warnings.map((w) => w.code),
    ['COMPONENTS_UNCHECKED'],
  );
});

test('refs.stack_mismatch', () => {
  const stacked = input({ base: 'feat/parent', refs: { stackedOn: '#3184' } });
  assert.deepEqual(createNetworkRules(stacked, config, data({ baseParent: '#3184' })).issues, []);
  assert.deepEqual(createNetworkRules(stacked, config, data({ baseParent: 'O/R#3184' })).issues, []);
  const other = createNetworkRules(stacked, config, data({ baseParent: 'o/r#3190' })).issues;
  assert.deepEqual(
    other.map((i) => [i.path, i.code]),
    [['refs.stackedOn', 'refs.stack_mismatch']],
  );
  assert.match(other[0]?.message ?? '', /is o\/r#3190/);
  const none = createNetworkRules(stacked, config, data({ baseParent: null })).issues;
  assert.deepEqual(
    none.map((i) => i.code),
    ['refs.stack_mismatch'],
  );
  assert.deepEqual(
    createNetworkRules(input(), config, data({ baseParent: '#1' })).issues,
    [],
    'no stackedOn: nothing to compare',
  );
});

test('refs.not_found points at each missing ref', () => {
  const i = input({ refs: { closes: ['#1', '#2'], related: ['x/y#3'] }, revertWith: ['#4'] });
  const r = createNetworkRules(i, config, data({ missingRefs: new Set(['#2', '#4']) }));
  assert.deepEqual(
    r.issues.map((x) => [x.path, x.code]),
    [
      ['refs.closes[1]', 'refs.not_found'],
      ['revertWith[0]', 'refs.not_found'],
    ],
  );
});

test('collectRefs lists every ref with its path', () => {
  const refs = collectRefs({
    refs: {
      stackedOn: '#1',
      closes: ['#2'],
      related: ['#3'],
      splitFrom: '#4',
      supersedes: ['#5', '#6'],
      reverts: '#7',
    },
    revertWith: ['#8'],
  });
  assert.deepEqual(refs, [
    { path: 'refs.stackedOn', ref: '#1' },
    { path: 'refs.closes[0]', ref: '#2' },
    { path: 'refs.related[0]', ref: '#3' },
    { path: 'refs.splitFrom', ref: '#4' },
    { path: 'refs.supersedes[0]', ref: '#5' },
    { path: 'refs.supersedes[1]', ref: '#6' },
    { path: 'refs.reverts', ref: '#7' },
    { path: 'revertWith[0]', ref: '#8' },
  ]);
  assert.deepEqual(collectRefs({}), []);
});

test('canonicalRef and touchedComponents', () => {
  assert.equal(canonicalRef('#12', 'Owner/Repo'), 'owner/repo#12');
  assert.equal(canonicalRef('A/B#12', 'o/r'), 'a/b#12');
  const t = touchedComponents(['packages/shared/a.ts', 'libs/common/b.ts', 'docs/x.md'], config.components);
  assert.deepEqual([...t], [['shared', ['packages/shared/a.ts', 'libs/common/b.ts']]]);
});

// 06: wide PRs, where the diff touches more components than `components` holds.
const wide = ConfigSchema.parse({
  version: 1,
  components: Object.fromEntries(
    ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => [
      n,
      { paths: [`${n}/**`], ...(n === 'g' ? { minRisk: 'high' } : {}) },
    ]),
  ),
});
const wideFiles = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => `${n}/x.ts`);

test('wide, list full: the other touched components are alsoTouched, in config order, with a warning', () => {
  const r = createNetworkRules(
    input({ components: ['e', 'd', 'c', 'b', 'a'], risk: 'high', riskNote: 'x' }),
    wide,
    data({ changedFiles: wideFiles }),
  );
  assert.deepEqual(r.issues, []);
  assert.deepEqual(r.alsoTouched, ['f', 'g']);
  assert.deepEqual(r.warnings, [
    {
      code: 'COMPONENTS_ALSO_TOUCHED',
      message: 'The PR also touches 2 components beyond the 5 declared; recorded as alsoTouched: f, g.',
    },
  ]);
});

test('wide, list not full: one undeclared_touched issue with the count and the first three names', () => {
  const r = createNetworkRules(input({ components: ['a', 'b'] }), wide, data({ changedFiles: wideFiles }));
  assert.deepEqual(r.alsoTouched, []);
  assert.deepEqual(r.issues, [
    {
      path: 'components',
      code: 'components.undeclared_touched',
      message:
        'the PR touches 7 components, more than components can list (5); declare the 5 primary ones and ghx records the rest as alsoTouched (undeclared: c, d, e, +2 more)',
    },
  ]);
});

test('risk.below_component_floor also covers alsoTouched', () => {
  const r = createNetworkRules(
    input({ components: ['a', 'b', 'c', 'd', 'e'], risk: 'medium', riskNote: 'x' }),
    wide,
    data({ changedFiles: wideFiles }),
  );
  assert.deepEqual(r.issues, [
    {
      path: 'risk',
      code: 'risk.below_component_floor',
      message: "risk 'medium' is below the floor set by g (high), which the PR also touches, in .github/ghx.json",
    },
  ]);
});

test('touching 5 or fewer: a full list padded with an unrelated component still must declare the touched one', () => {
  const r = createNetworkRules(
    input({ components: ['a', 'b', 'c', 'd', 'f'] }),
    wide,
    data({ changedFiles: ['a/x.ts', 'b/x.ts', 'c/x.ts', 'd/x.ts', 'e/x.ts'] }),
  );
  assert.deepEqual(r.alsoTouched, []);
  assert.deepEqual(
    r.issues.map((i) => i.code),
    ['components.undeclared_touched'],
  );
  assert.match(r.issues[0]?.message ?? '', /add 'e' to components/);
  assert.deepEqual(
    r.warnings.map((w) => w.code),
    ['COMPONENTS_UNUSED'],
  );
});

test('COMPONENTS_ALSO_TOUCHED lists at most three names', () => {
  const many = ConfigSchema.parse({
    version: 1,
    components: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`c${i}`, { paths: [`c${i}/**`] }])),
  });
  const r = createNetworkRules(
    input({ components: ['c0', 'c1', 'c2', 'c3', 'c4'] }),
    many,
    data({ changedFiles: Array.from({ length: 12 }, (_, i) => `c${i}/x.ts`) }),
  );
  assert.equal(r.alsoTouched.length, 7);
  assert.match(r.warnings[0]?.message ?? '', /touches 7 components .*: c5, c6, c7, \+4 more\.$/);
});
