// Regression: `ghx pr land` spun for 12 h on a PR whose checks had all passed (tally#27). The wait's
// expected set was bound from one checkout's config (the PR's worktree, split job names) and stored; the
// merge gate re-derived its own from the cwd checkout, a main 39 commits behind, whose ci.expected still
// named the retired single job. The machine settled green, the gate saw CI_PENDING for a config-sourced
// check that would never report, gateVerdict kept answering null, and an attended background wait has no
// time bound. Fixed by one check set (the gate judges the wait's bound definitions: ci-summary.ts
// boundExpected), a bounded gate (gateVerdict ends `stalled`), and WAIT_CONFIG_CHANGED (driver bind).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ignoreRuleFor } from '../../../../src/ci/checks.ts';
import { ciState } from '../../../../src/ci/summary.ts';
import {
  addRequired,
  buildExpectedSet,
  type ConfigExpectedEntry,
  configExpected,
  expectedState,
} from '../../../../src/ci/wait/expected.ts';
import { decide, initialState, observe, WAIT_DEFAULTS } from '../../../../src/ci/wait/machine.ts';
import { createGateClocks, GATE_MIN_HOLD_MS, type GateClock, gateVerdict } from '../../../../src/ci/wait/mergeable.ts';
import { detectStalls, stallConfig } from '../../../../src/ci/wait/stall.ts';
import { ciConfigFingerprint } from '../../../../src/ci/wait/state.ts';
import { boundExpected } from '../../../../src/pr/ci-summary.ts';
import { MIN, passed, T0 } from './_data.ts';

const H = 'a'.repeat(40);
const PATHS = ['.goreleaser.yaml', 'release/**', '.github/workflows/snapshot.yml'];
const CI = ['lint', 'ui'];
const SPLIT = ['packaging snapshot / build', 'packaging snapshot / sign'];

/** The PR's worktree: the split names. It bound the wait state. */
const headConfig: ConfigExpectedEntry[] = [
  ...CI.map((name) => ({ name, workflow: 'CI' })),
  ...SPLIT.map((name) => ({ name, workflow: 'Snapshot', paths: PATHS })),
];
/** The stale main checkout: the retired single job. The gate used to derive its set from this. */
const staleConfig: ConfigExpectedEntry[] = [
  ...CI.map((name) => ({ name, workflow: 'CI' })),
  { name: 'packaging snapshot', workflow: 'Snapshot', paths: PATHS },
];
const changed = ['.github/workflows/snapshot.yml'];
const SETTLED = T0 + 6 * MIN;
const checks = [...CI.map((n) => passed(n, 5)), ...SPLIT.map((n) => passed(n, 6, { workflow: 'Snapshot' }))];

const defsFrom = (config: ConfigExpectedEntry[], ignore: string[] = []) =>
  buildExpectedSet({ required: [], config: configExpected(config, changed), baseline: null, ignore });

/** A gateVerdict input: CI_PENDING failing (or passing), with the CI view's missing and pending checks. */
function gateRead(o: { pending?: boolean; missing?: string[]; ciPending?: string[]; unknown?: boolean } = {}) {
  const ciPending = o.pending ?? true;
  const fails = [...(ciPending ? ['CI_PENDING'] : []), ...(o.unknown ? ['MERGEABLE_UNKNOWN'] : [])];
  return {
    snapshot: {
      state: 'OPEN',
      ref: 'o/r#27',
      head: { sha: H },
      merge: { mergeable: o.unknown ? 'UNKNOWN' : 'MERGEABLE' },
    },
    ci: {
      truncated: false,
      failing: [],
      pending: (o.ciPending ?? []).map((name) => ({ name, workflow: 'CI', status: 'queued', required: false })),
      expectedMissing: (o.missing ?? []).map((name) => ({
        name,
        workflow: 'Snapshot',
        source: 'config',
        state: 'missing',
      })),
    },
    evaluation: {
      ready: fails.length === 0,
      plan: {
        checks: fails.map((code) => ({ code, status: 'fail', message: '' })),
        blockers: fails.map((code) => ({ code })),
        waivers: [],
      },
    },
  } as unknown as Parameters<typeof gateVerdict>[0];
}

const clock = (o: Partial<GateClock> = {}): GateClock => ({
  now: SETTLED + 11 * MIN,
  settledSince: SETTLED,
  missingMs: 10 * MIN,
  heldMs: GATE_MIN_HOLD_MS,
  ...o,
});

test('the wait machine settles (gate: true) on the set it bound', () => {
  const cfg = { until: 'mergeable' as const, ...WAIT_DEFAULTS };
  let st = initialState({ target: 'o/r#27', boundSha: H, boundAt: T0, expected: defsFrom(headConfig) });
  st = observe(st, { checks, ignored: 0, eta: null, now: T0 + 10 * MIN }, cfg).state;
  const d = decide(st, { checks, now: T0 + 10 * MIN }, { cfg, diagnosis: () => undefined, stalled: [] });
  assert.equal(d?.outcome, 'green');
  assert.equal(d?.gate, true);
});

test('the stale config expects a config-sourced check that never reports, and it never ages out', () => {
  const defs = defsFrom(staleConfig);
  const exp = expectedState(defs, checks, ['packaging snapshot']);
  const missing = exp.filter((e) => e.state === 'missing');
  assert.deepEqual(missing, [{ name: 'packaging snapshot', workflow: 'Snapshot', source: 'config', state: 'missing' }]);
  assert.deepEqual(ciState(checks, missing.length), { state: 'pending', phase: 'partial' });
  // The stall rule covers a missing config check (only baseline ones are excluded) once it sees it.
  const stalled = detectStalls({
    checks,
    jobs: [],
    baselines: {},
    timeouts: {},
    expected: exp,
    now: SETTLED + 11 * MIN,
    config: stallConfig(),
  });
  assert.deepEqual(
    stalled.map((s) => [s.name, s.state, s.basis]),
    [['packaging snapshot', 'missing', 'ci.stall.missingMinutes']],
  );
});

test('one check set: the gate judges the bound definitions, so a stale cwd config cannot add a check', () => {
  const exp = boundExpected(defsFrom(headConfig), checks, [], true);
  assert.deepEqual(
    exp.filter((e) => e.state === 'missing'),
    [],
  );
});

test('boundExpected without agedOut applies the grace rule to missing baseline checks only', () => {
  const defs = buildExpectedSet({
    required: [],
    config: [{ name: 'lint', workflow: 'CI' }],
    baseline: { source: 'previous-head', sha: H, confidence: 'high', names: ['lint', 'gone'] },
  });
  const state = (graceOver: boolean, cs = checks) =>
    boundExpected(defs, cs, undefined, graceOver).find((e) => e.name === 'gone')?.state;
  assert.equal(state(false), 'missing');
  assert.equal(state(true), 'absent');
  assert.equal(
    state(
      true,
      checks.filter((c) => c.name !== 'lint'),
    ),
    'missing',
    'a missing config check holds it',
  );
  const cfg = buildExpectedSet({ required: [], config: [{ name: 'gone', workflow: 'CI' }], baseline: null });
  assert.equal(boundExpected(cfg, checks, undefined, true)[0]?.state, 'missing', 'config checks never age');
});

test('gate: a missing check past missingMinutes after settle, held for GATE_MIN_HOLD_MS, ends stalled', () => {
  const r = gateRead({ missing: ['packaging snapshot'] });
  assert.equal(gateVerdict(r, H), null, 'no clock: keep polling (the old behaviour)');
  assert.equal(gateVerdict(r, H, clock({ now: SETTLED + 2 * MIN })), null, 'within missingMinutes');
  assert.equal(gateVerdict(r, H, clock({ heldMs: GATE_MIN_HOLD_MS - 1 })), null, 'not held long enough yet');
  assert.equal(gateVerdict(r, H, clock({ settledSince: null })), null, 'the gate’s view has pending checks');
  const v = gateVerdict(r, H, clock());
  assert.equal(v?.outcome, 'stalled');
  assert.equal(v?.reason, 'expected-missing');
  assert.deepEqual(v?.merge.blockers, ['CI_PENDING']);
  assert.deepEqual(v?.next, ['ghx pr status o/r#27']);
  assert.deepEqual(
    v?.stalled?.map((s) => [s.name, s.state, s.forSec, s.thresholdSec, s.basis]),
    [['packaging snapshot', 'missing', 660, 600, 'ci.stall.missingMinutes']],
  );
});

test('gate: a check still pending in its own view keeps it polling, however long (review finding 2)', () => {
  // --check filters the wait's checks, never the gate's: an unselected running check is not a stall.
  for (const now of [SETTLED + 11 * MIN, SETTLED + 10 * 60 * MIN]) {
    assert.equal(gateVerdict(gateRead({ ciPending: ['e2e'] }), H, clock({ now })), null);
    assert.equal(gateVerdict(gateRead({ ciPending: ['e2e'], missing: ['x'] }), H, clock({ now })), null);
  }
});

test('gate: a stuck UNKNOWN ends stalled with nothing to rerun', () => {
  const unknown = gateRead({ pending: false, unknown: true });
  assert.equal(gateVerdict(unknown, H, clock({ heldMs: 0 })), null, 'a fresh UNKNOWN is polled');
  assert.equal(gateVerdict(unknown, H, clock({ now: SETTLED + 9 * MIN })), null, 'within missingMinutes');
  const v = gateVerdict(unknown, H, clock());
  assert.equal(v?.outcome, 'stalled');
  assert.equal(v?.reason, 'mergeable-unknown');
  assert.deepEqual(v?.stalled, []);
});

test('gate: ready stays green whatever the clock says', () => {
  assert.equal(gateVerdict(gateRead({ pending: false }), H, clock())?.outcome, 'green');
});

test('the config fingerprint is stable and follows ci.expected and ci.ignore', () => {
  const a = ciConfigFingerprint({ expected: headConfig, ignore: [] });
  assert.equal(a, ciConfigFingerprint({ expected: [...headConfig], ignore: [] }));
  assert.notEqual(a, ciConfigFingerprint({ expected: staleConfig, ignore: [] }));
  assert.notEqual(a, ciConfigFingerprint({ expected: headConfig, ignore: ['packaging snapshot'] }));
  assert.match(a, /^[0-9a-f]{16}$/);
});

test('ci.ignore with the exact name drops the expectation from every source, and only that name', () => {
  assert.deepEqual(
    expectedState(defsFrom(staleConfig, ['packaging snapshot']), checks).filter((e) => e.state === 'missing'),
    [],
  );
  const viaBaseline = buildExpectedSet({
    required: [],
    config: [],
    baseline: { source: 'previous-head', sha: H, confidence: 'high', names: ['packaging snapshot', 'lint'] },
    ignore: ['packaging snapshot'],
  });
  assert.deepEqual(
    viaBaseline.map((d) => d.name),
    ['lint'],
  );
  assert.equal(
    ignoreRuleFor({ name: 'packaging snapshot / build', workflow: 'Snapshot' }, ['packaging snapshot']),
    undefined,
  );
});

test('gate clocks are per target: one PR’s hold and settle time never count for another (review finding 6)', () => {
  const c = createGateClocks();
  const A = 'o/r#12@a';
  const B = 'o/r#13@b';
  assert.equal(c.clock(A, T0, true, 10 * MIN).heldMs, 0);
  c.answered(A, T0, null);
  const a = c.clock(A, T0 + 30 * MIN, true, 10 * MIN);
  assert.deepEqual([a.settledSince, a.heldMs], [T0, 30 * MIN]);
  const b = c.clock(B, T0 + 30 * MIN, true, 10 * MIN);
  assert.deepEqual([b.settledSince, b.heldMs], [T0 + 30 * MIN, 0], 'B starts its own clocks');
  // A pending check resets the settle clock; an answer resets the hold.
  assert.equal(c.clock(A, T0 + 31 * MIN, false, 10 * MIN).settledSince, null);
  c.answered(A, T0 + 31 * MIN, {
    outcome: 'green',
    reason: 'mergeable',
    merge: { mergeable: 'MERGEABLE', ready: true, blockers: [], waivers: [] },
  });
  assert.equal(c.clock(A, T0 + 32 * MIN, true, 10 * MIN).heldMs, 0);
});

test('the gate bound runs on the local clock: a GitHub completedAt from a skewed clock cannot shorten it (finding 7)', () => {
  // Checks that GitHub stamped hours "ago" (local clock ahead) still get the full missingMinutes after the
  // gate first sees them settled.
  const c = createGateClocks();
  const k = 'o/r#27@h';
  const first = c.clock(k, T0, true, 10 * MIN);
  c.answered(k, T0, null);
  const r = gateRead({ missing: ['packaging snapshot'] });
  assert.equal(gateVerdict(r, H, first), null);
  assert.equal(gateVerdict(r, H, c.clock(k, T0 + 9 * MIN, true, 10 * MIN)), null);
  assert.equal(gateVerdict(r, H, c.clock(k, T0 + 11 * MIN, true, 10 * MIN))?.reason, 'expected-missing');
});

test('gate clocks take the earlier of their own and a saved first-settled time; an unsettled view clears it', () => {
  const c = createGateClocks();
  const k = 'o/r#7@h';
  assert.equal(c.clock(k, T0 + 9 * MIN, true, 10 * MIN, T0 + 3 * MIN).settledSince, T0 + 3 * MIN, 'a re-run keeps it');
  assert.equal(c.clock(k, T0 + 10 * MIN, true, 10 * MIN, null).settledSince, T0 + 3 * MIN);
  assert.equal(c.clock(k, T0 + 11 * MIN, false, 10 * MIN, T0 + 3 * MIN).settledSince, null, 'pending again');
  assert.equal(c.clock(k, T0 + 12 * MIN, true, 10 * MIN, null).settledSince, T0 + 12 * MIN, 'starts over');
});

test('gate: a pending check the stall rules call stalled ends it (gate-stalled) once held', () => {
  const stalledPending = [
    { name: 'deploy', state: 'queued' as const, forSec: 1900, thresholdSec: 1800, basis: 'ci.stall.queuedMinutes' },
  ];
  const r = gateRead({ ciPending: ['deploy'] });
  assert.equal(gateVerdict(r, H, clock({ settledSince: null, stalledPending, heldMs: 0 })), null);
  const v = gateVerdict(r, H, clock({ settledSince: null, stalledPending }));
  assert.equal(v?.reason, 'gate-stalled');
  assert.deepEqual(v?.stalled, stalledPending);
});

test('addRequired only adds required names, never removes or duplicates, and honours ci.ignore', () => {
  const defs = defsFrom(headConfig);
  const out = addRequired(defs, ['lint', 'build', 'notify'], ['notify']);
  assert.deepEqual(out.slice(0, defs.length), defs);
  assert.deepEqual(out.slice(defs.length), [{ name: 'build', workflow: null, source: 'required' }]);
});
