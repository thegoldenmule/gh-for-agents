// The wait state machine (03 M4.4): one row per transition rule of 02 §11.1–11.3.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { skeletonJob } from '../../../../src/ci/diagnose.ts';
import {
  decide,
  failureKey,
  initialState,
  type MachineConfig,
  type MachineState,
  markReported,
  observe,
  WAIT_DEFAULTS,
} from '../../../../src/ci/wait/machine.ts';
import type { Check, FailingJob, SameOnMainVerdict } from '../../../../src/schemas/ci.ts';
import { check, passed, SEC, T0 } from './_data.ts';

const cfg = (until: MachineConfig['until'] = 'first-failure'): MachineConfig => ({ until, ...WAIT_DEFAULTS });
const fresh = (expected: MachineState['expected'] = []): MachineState =>
  initialState({ target: 'o/r#7', boundSha: 'a'.repeat(40), boundAt: T0, expected });

const failed = (name: string, jobId: number, o: Partial<Check> = {}): Check =>
  check(name, {
    bucket: 'fail',
    status: 'completed',
    conclusion: 'failure',
    jobId,
    runId: 1,
    completedAt: new Date(T0 + 60 * SEC).toISOString(),
    ...o,
  });

const noDiag = () => undefined;
const diagWith =
  (verdict: SameOnMainVerdict) =>
  (c: Check): FailingJob => {
    const j = skeletonJob({ ...c, jobId: c.jobId ?? 1, runId: c.runId ?? 1 }, 'main');
    return { ...j, sameOnMain: { ...j.sameOnMain, verdict } };
  };

/** Run observe then decide at `sec` seconds after T0. */
function tick(
  s: MachineState,
  checks: Check[],
  sec: number,
  c = cfg(),
  diagnosis: (c: Check) => FailingJob | undefined = noDiag,
) {
  const o = observe(s, { checks, ignored: 0, eta: null, now: T0 + sec * SEC }, c);
  const d = decide(o.state, { checks, now: T0 + sec * SEC }, { cfg: c, diagnosis, stalled: [] });
  return { ...o, decision: d };
}

test('registering → no-checks exactly at the default grace (120 s), never green', () => {
  assert.equal(tick(fresh(), [], 119).decision, null);
  const d = tick(fresh(), [], 120).decision;
  assert.equal(d?.outcome, 'no-checks');
  assert.equal(d?.reason, 'grace');
});

test('checks registering inside the grace never end no-checks', () => {
  const s = tick(fresh(), [], 45).state;
  const r = tick(s, [check('test')], 130);
  assert.equal(r.decision, null);
  assert.equal(r.phase, 'running');
});

test('partial never ends green: a required check is still missing', () => {
  const s = fresh([{ name: 'e2e', workflow: null, source: 'required' }]);
  const r = tick(s, [passed('test')], 3600);
  assert.equal(r.phase, 'partial');
  assert.equal(r.decision, null);
});

test('a missing baseline check ages out after expect-grace once everything else settled, emitting expected-absent', () => {
  let s = fresh([{ name: 'e2e', workflow: null, source: 'baseline' }]);
  let r = tick(s, [passed('test')], 10);
  assert.equal(r.phase, 'partial');
  assert.equal(r.decision, null);
  s = r.state;
  r = tick(s, [passed('test')], 99);
  assert.equal(r.decision, null, 'still within the 90 s expect-grace');
  r = tick(r.state, [passed('test')], 100);
  assert.deepEqual(
    r.events.filter((e) => e.type === 'expected-absent').map((e) => e.type === 'expected-absent' && e.name),
    ['e2e'],
  );
  assert.ok(r.events.some((e) => e.type === 'phase' && e.from === 'partial' && e.to === 'settled'));
  assert.equal(r.decision?.outcome, 'green');
});

test('expect-grace counts from when CI completed, not first observation: long-settled CI ages a baseline at once', () => {
  const s = fresh([{ name: 'copilot', workflow: null, source: 'baseline' }]);
  const r = tick(s, [passed('test', 0)], 100);
  assert.deepEqual(
    r.events.filter((e) => e.type === 'expected-absent').map((e) => e.type === 'expected-absent' && e.name),
    ['copilot'],
  );
  assert.equal(r.decision?.outcome, 'green');
  assert.equal(tick(s, [passed('test', 0)], 89).decision, null, 'within 90 s of the completion it still waits');
});

test('first-failure ends on the first failure, before the rest settles', () => {
  const r = tick(fresh(), [failed('lint', 11), check('test')], 60);
  assert.deepEqual(
    r.newFailures.map((c) => c.name),
    ['lint'],
  );
  assert.equal(r.decision?.outcome, 'red');
  assert.equal(r.decision?.reason, 'first-failure');
  assert.equal(r.decision?.settled, false);
});

test('continuation: with failure A reported, a new run stops at failure B or at settle, never at A again', () => {
  const a = failed('lint', 11);
  const s = markReported(tick(fresh(), [a, check('test'), check('e2e')], 60).state, [a]);
  assert.equal(tick(s, [a, check('test'), check('e2e')], 70).decision, null, 'A alone does not end it again');
  const b = failed('test', 12);
  const atB = tick(s, [a, b, check('e2e')], 80).decision;
  assert.equal(atB?.outcome, 'red');
  assert.equal(atB?.reason, 'first-failure');
  const settle = tick(s, [a, passed('test'), passed('e2e')], 90).decision;
  assert.equal(settle?.outcome, 'red');
  assert.equal(settle?.reason, 'settled');
  assert.equal(settle?.settled, true);
});

test('a re-run of A is a new job, so a new failure', () => {
  const a = failed('lint', 11);
  const s = markReported(tick(fresh(), [a, check('test')], 60).state, [a]);
  assert.notEqual(failureKey(a), failureKey({ ...a, jobId: 99 }));
  assert.equal(tick(s, [{ ...a, jobId: 99 }, check('test')], 70).decision?.outcome, 'red');
});

test('settled mode waits past a failure until everything completes', () => {
  const c = cfg('settled');
  assert.equal(tick(fresh(), [failed('lint', 11), check('test')], 60, c).decision, null);
  assert.equal(tick(fresh(), [failed('lint', 11), passed('test')], 60, c).decision?.outcome, 'red');
});

test('cancelled counts as red', () => {
  const r = tick(
    fresh(),
    [check('test', { bucket: 'cancelled', status: 'completed', conclusion: 'cancelled', jobId: 5 })],
    60,
  );
  assert.equal(r.decision?.outcome, 'red');
});

test('all failures shared with main gives red-shared; one unshared gives red', () => {
  const two = [failed('a', 1), failed('b', 2)];
  assert.equal(tick(fresh(), two, 60, cfg(), diagWith('same-tests')).decision?.outcome, 'red-shared');
  assert.equal(tick(fresh(), two, 60, cfg(), diagWith('same-step')).decision?.outcome, 'red-shared');
  const mixed = (c: Check) => diagWith(c.name === 'a' ? 'same-tests' : 'different')(c);
  assert.equal(tick(fresh(), two, 60, cfg(), mixed).decision?.outcome, 'red');
  assert.equal(tick(fresh(), two, 60, cfg(), noDiag).decision?.outcome, 'red', 'undiagnosed is never shared');
});

test('settled green', () => {
  const d = tick(fresh(), [passed('a'), passed('b')], 60).decision;
  assert.equal(d?.outcome, 'green');
  assert.equal(d?.settled, true);
});

test('a stall ends the wait only while nothing more decisive applies', () => {
  const s = fresh();
  const stalled = [{ name: 'test', state: 'running' as const, forSec: 2000, thresholdSec: 1140, basis: 'p90+15m' }];
  const o = observe(s, { checks: [check('test')], ignored: 0, eta: null, now: T0 }, cfg());
  const d = decide(o.state, { checks: [check('test')], now: T0 }, { cfg: cfg(), diagnosis: noDiag, stalled });
  assert.equal(d?.outcome, 'stalled');
  assert.deepEqual(d?.stalled, stalled);
  const red = [failed('lint', 3), check('test')];
  const o2 = observe(s, { checks: red, ignored: 0, eta: null, now: T0 }, cfg());
  assert.equal(decide(o2.state, { checks: red, now: T0 }, { cfg: cfg(), diagnosis: noDiag, stalled })?.outcome, 'red');
});

test('mergeable mode hands a settled CI outcome to the gate', () => {
  const d = tick(fresh(), [passed('a')], 60, cfg('mergeable')).decision;
  assert.equal(d?.gate, true);
  assert.equal(d?.outcome, 'green');
  assert.equal(tick(fresh(), [failed('a', 1), check('b')], 60, cfg('mergeable')).decision, null);
});

test('check events: transitions only; a check first seen pending makes no line', () => {
  let r = tick(fresh(), [check('a'), passed('b')], 10);
  assert.deepEqual(
    r.events.filter((e) => e.type === 'check').map((e) => e.type === 'check' && [e.name, e.from, e.to]),
    [['b', 'absent', 'pass']],
  );
  r = tick(r.state, [failed('a', 4), passed('b')], 20);
  assert.deepEqual(
    r.events.filter((e) => e.type === 'check').map((e) => e.type === 'check' && [e.name, e.from, e.to]),
    [['a', 'pending', 'fail']],
  );
});

test('progress at most every 60 s when nothing else happens', () => {
  let s = tick(fresh(), [check('a')], 0).state;
  let r = tick(s, [check('a')], 59);
  assert.equal(r.events.length, 0);
  r = tick(r.state, [check('a')], 60);
  assert.deepEqual(
    r.events.map((e) => e.type),
    ['progress'],
  );
  s = r.state;
  assert.equal(tick(s, [check('a')], 100).events.length, 0);
});

test('a failure is new only once per binding', () => {
  const r1 = tick(fresh(), [failed('a', 1), check('b')], 10);
  assert.equal(r1.newFailures.length, 1);
  assert.equal(tick(r1.state, [failed('a', 1), check('b')], 20).newFailures.length, 0);
});

test('an open source (a run still going) never settles, waits with no checks, and still fails fast', () => {
  const now = T0 + 10 * 60 * SEC;
  const opts = { cfg: cfg('settled'), diagnosis: noDiag, stalled: [] };
  // Every listed job done, but the run is not: running, not settled.
  const ob = observe(fresh(), { checks: [passed('build')], ignored: 0, eta: null, now, open: true }, cfg('settled'));
  assert.equal(ob.phase, 'running');
  assert.equal(decide(ob.state, { checks: [passed('build')], now, open: true }, opts), null);
  assert.equal(decide(ob.state, { checks: [passed('build')], now }, opts)?.outcome, 'green');
  // No jobs yet, well past the grace: still waiting, not no-checks.
  const empty = observe(fresh(), { checks: [], ignored: 0, eta: null, now, open: true }, cfg());
  assert.equal(empty.phase, 'registering');
  assert.equal(decide(empty.state, { checks: [], now, open: true }, opts), null);
  assert.equal(decide(empty.state, { checks: [], now }, opts)?.outcome, 'no-checks');
  // first-failure returns on a red job while the run goes on.
  const red = [failed('unit', 5)];
  const d = decide(fresh(), { checks: red, now, open: true }, { ...opts, cfg: cfg() });
  assert.equal(d?.outcome, 'red');
  assert.equal(d?.settled, false);
});

test('a rejected workflow run (an Actions check with a run and no job) is red at once, in every mode, every time', () => {
  const rejected = failed('.github/workflows/ci.yml', 0, { jobId: null, runId: 40518894617 });
  const running = check('unit', { bucket: 'pending', status: 'in_progress', jobId: 5, runId: 2 });
  for (const until of ['first-failure', 'settled', 'mergeable'] as const) {
    const st = observe(
      fresh(),
      { checks: [rejected, running], ignored: 0, eta: null, now: T0 + SEC },
      cfg(until),
    ).state;
    const d = decide(
      st,
      { checks: [rejected, running], now: T0 + SEC },
      { cfg: cfg(until), diagnosis: noDiag, stalled: [] },
    );
    assert.equal(d?.outcome, 'red', until);
    assert.equal(d?.reason, 'workflow-invalid');
    assert.equal(d?.settled, true);
    assert.equal(d?.gate, false);
    // Already reported: a re-run returns it again instead of waiting on.
    const again = decide(
      markReported(st, [rejected]),
      { checks: [rejected, running], now: T0 + SEC },
      {
        cfg: cfg(until),
        diagnosis: noDiag,
        stalled: [],
      },
    );
    assert.equal(again?.reason, 'workflow-invalid');
  }
});
