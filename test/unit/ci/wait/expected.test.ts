import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summariseCi } from '../../../../src/ci/summary.ts';
import {
  buildExpectedSet,
  configExpected,
  expectedPhase,
  expectedState,
  phaseAllowsGreen,
  pickBaseline,
  previousHeadCandidates,
  requiredChecks,
  rulesRequiredContexts,
} from '../../../../src/ci/wait/expected.ts';
import { CiSection } from '../../../../src/config/sections/ci.ts';
import { ExpectedCheck } from '../../../../src/schemas/ci.ts';
import { check, passed } from './_data.ts';

const reqRule = (contexts: string[], source = 'Repository') => ({
  type: 'required_status_checks',
  ruleset_source_type: source,
  parameters: { required_status_checks: contexts.map((context) => ({ context })) },
});

test('rules: duplicate rules collapse, org-level rulesets count, other rule types are ignored', () => {
  const rules = [
    { type: 'deletion' },
    reqRule(['build', 'lint']),
    { type: 'deletion' },
    reqRule(['lint', 'security/scan'], 'Organization'),
  ];
  assert.deepEqual(rulesRequiredContexts(rules), ['build', 'lint', 'security/scan']);
  assert.deepEqual(rulesRequiredContexts([{ type: 'required_status_checks', parameters: null }]), []);
});

test('required: rules-only, branch-only and both sources each work, deduplicated with isRequired', () => {
  assert.deepEqual(requiredChecks({ rules: ['build'], branch: null }), ['build']);
  assert.deepEqual(requiredChecks({ rules: null, branch: ['test'] }), ['test']);
  assert.deepEqual(requiredChecks({ rules: null, branch: null }), []);
  assert.deepEqual(
    requiredChecks({ rules: ['build', 'lint'], branch: ['lint', 'test'] }, [
      check('e2e', { required: true }),
      check('build', { required: true }),
      check('docs'),
    ]),
    ['build', 'lint', 'test', 'e2e'],
  );
});

test('config: a path-filtered entry is skipped when no changed file matches', () => {
  const entries = [
    { name: 'always' },
    { name: 'docs', paths: ['docs/**'] },
    { name: 'web', paths: ['web/**', '*.css'] },
  ];
  assert.deepEqual(
    configExpected(entries, ['src/a.ts']).map((e) => e.name),
    ['always'],
  );
  assert.deepEqual(
    configExpected(entries, ['docs/x/y.md', 'site.css']).map((e) => e.name),
    ['always', 'docs', 'web'],
  );
  // An unknown file list keeps every entry: it can delay green, never cause an early one.
  assert.deepEqual(
    configExpected(entries, null).map((e) => e.name),
    ['always', 'docs', 'web'],
  );
});

test('baseline: confidence order is previous head, then last merged PR, then base head', () => {
  const prev = { source: 'previous-head' as const, sha: 'p', names: ['a', 'b'] };
  const merged = { source: 'last-merged-pr' as const, sha: 'm', names: ['a', 'c'] };
  const base = { source: 'base-head' as const, sha: 'h', names: ['d'] };
  assert.deepEqual(pickBaseline([base, merged, prev]), {
    source: 'previous-head',
    sha: 'p',
    confidence: 'high',
    names: ['a', 'b'],
  });
  assert.equal(pickBaseline([base, merged])?.confidence, 'medium');
  assert.deepEqual(pickBaseline([base]), { source: 'base-head', sha: 'h', confidence: 'low', names: ['d'] });
  // Empty or unavailable sources are skipped.
  assert.equal(pickBaseline([{ ...prev, names: [] }, { ...merged, names: null }, base])?.source, 'base-head');
  assert.equal(pickBaseline([]), null);
});

test('previous-head candidates: the commits before the head, newest first, bounded', () => {
  assert.deepEqual(previousHeadCandidates(['c1', 'c2', 'c3', 'c4', 'c5'], 'c5'), ['c4', 'c3', 'c2']);
  assert.deepEqual(previousHeadCandidates(['c1', 'c2'], 'c2', 1), ['c1']);
  assert.deepEqual(previousHeadCandidates(['c1'], 'c1'), []);
  // A head missing from the list (force-push race): every listed commit is a candidate.
  assert.deepEqual(previousHeadCandidates(['c1', 'c2'], 'zz'), ['c2', 'c1']);
});

test('expected set: required beats config beats baseline; ignored and filtered checks drop out', () => {
  const defs = buildExpectedSet({
    required: ['build', 'lint'],
    config: [
      { name: 'lint', workflow: 'Lint' },
      { name: 'deploy-preview', workflow: 'Preview' },
    ],
    baseline: { source: 'base-head', sha: 'h', confidence: 'low', names: ['build', 'notify-discord', 'unit', 'e2e'] },
    ignore: ['notify-*'],
    consider: (c) => c.name !== 'e2e',
  });
  assert.deepEqual(defs, [
    { name: 'build', workflow: null, source: 'required' },
    { name: 'lint', workflow: null, source: 'required' },
    { name: 'deploy-preview', workflow: 'Preview', source: 'config' },
    { name: 'unit', workflow: null, source: 'baseline' },
  ]);
});

test('expected state: reported, missing, and absent once the caller ages a baseline check out', () => {
  const defs = buildExpectedSet({
    required: ['build'],
    config: [{ name: 'lint', workflow: 'Lint' }],
    baseline: { source: 'previous-head', sha: 'p', confidence: 'high', names: ['unit', 'docs'] },
  });
  const checks = [check('build'), check('lint', { workflow: 'Other' }), passed('unit')];
  const out = expectedState(defs, checks, ['docs', 'build']);
  for (const e of out) ExpectedCheck.parse(e);
  assert.deepEqual(
    out.map((e) => [e.name, e.state]),
    [
      ['build', 'reported'],
      // The config entry names a workflow, so a same-named check from another workflow does not count.
      ['lint', 'missing'],
      ['unit', 'reported'],
      ['docs', 'absent'],
    ],
  );
  // Aging out applies to baseline checks only: a required check never becomes absent.
  assert.equal(expectedState(defs, [], ['build'])[0]?.state, 'missing');
});

test('phase: registering, partial, running, settled', () => {
  const req = buildExpectedSet({ required: ['build'], config: [], baseline: null });
  const phase = (checks: ReturnType<typeof check>[]) => expectedPhase(checks, expectedState(req, checks));
  assert.equal(phase([]), 'registering');
  assert.equal(phase([passed('lint')]), 'partial');
  assert.equal(phase([check('build'), passed('lint')]), 'running');
  assert.equal(phase([passed('build'), passed('lint')]), 'settled');
});

test('partial is never terminal green: all reported checks pass but a required check is missing', () => {
  const defs = buildExpectedSet({ required: ['build'], config: [{ name: 'e2e' }], baseline: null });
  for (const checks of [[passed('lint')], [passed('lint'), passed('build')], [passed('e2e')]]) {
    const expected = expectedState(defs, checks);
    const phase = expectedPhase(checks, expected);
    assert.equal(phase, 'partial');
    assert.equal(phaseAllowsGreen(phase), false);
    const s = summariseCi({ headSha: 'a'.repeat(40), checks, expected });
    assert.equal(s.phase, 'partial');
    assert.equal(s.state, 'pending');
  }
  assert.equal(phaseAllowsGreen('settled'), true);
  for (const p of ['registering', 'running'] as const) assert.equal(phaseAllowsGreen(p), false);
});

test('a baseline check within its grace keeps the phase partial; aged out, it no longer blocks settle', () => {
  const defs = buildExpectedSet({
    required: [],
    config: [],
    baseline: { source: 'base-head', sha: 'h', confidence: 'low', names: ['main-only'] },
  });
  const checks = [passed('build')];
  assert.equal(expectedPhase(checks, expectedState(defs, checks)), 'partial');
  assert.equal(expectedPhase(checks, expectedState(defs, checks, ['main-only'])), 'settled');
});

test('config: ci.expected parses {name, workflow?, paths?}, is optional, and rejects a bad glob', () => {
  assert.equal(CiSection.parse({}).expected, undefined);
  const c = CiSection.parse({ expected: [{ name: 'e2e', workflow: 'E2E', paths: ['web/**'] }, { name: 'lint' }] });
  assert.deepEqual(c.expected?.[0], { name: 'e2e', workflow: 'E2E', paths: ['web/**'] });
  assert.equal(CiSection.safeParse({ expected: [{ name: 'x', paths: ['../up'] }] }).success, false);
  assert.equal(CiSection.safeParse({ expected: [{ name: 'x', extra: 1 }] }).success, false);
});
