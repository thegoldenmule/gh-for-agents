// Resume (02 §11.1; 03 M4.6): state on disk keyed by repo + target + bound SHA. A re-run of the
// identical command pays no repeated baseline or diagnosis calls, and a known terminal state returns
// at once after one conditional (304) tick.
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createShutdown } from '../../src/core/signals.ts';
import { EXIT } from '../contract/exit-table.ts';
import { FakeClock, flush } from '../helpers/fake-clock.ts';
import { GitHubSim, type SimCall, type SimJob, sha, startWait, wait } from './ci-wait-world.ts';

const H = sha('a');
const H2 = sha('b');
const MIN = 60_000;

const path = (c: SimCall) => c.argv.find((a) => a.startsWith('repos/'))?.split('?')[0] ?? c.argv[1] ?? '';
/** Reads that belong to setup or diagnosis, never to a steady-state poll. */
const SETUP =
  /\/rules\/branches\/|\/branches\/main$|\/pulls\/7\/commits$|\/pulls$|\/actions\/workflows\/|\/actions\/jobs\/|\/actions\/runs|\/contents\/\.github\/workflows\//;

function world(extra: SimJob[] = []) {
  const clock = new FakeClock();
  const a: SimJob = { id: 31, runId: 600, name: 'unit', status: 'in_progress', startedAt: 0 };
  const b: SimJob = { id: 32, runId: 600, name: 'e2e', status: 'in_progress', startedAt: 0 };
  const sim = new GitHubSim(clock, { pr: { state: 'open', head: H }, checks: { [H]: [a, b, ...extra] } });
  return { clock, sim, a, b };
}

const set = (sim: GitHubSim, at: number, jobs: SimJob[]) =>
  sim.at(at, (s) => {
    s.checks[H] = jobs;
    return s;
  });

test('kill mid-wait after baselines and a diagnosis; the re-run repeats none of it and resumes with 304s', async () => {
  const { clock, sim, a, b } = world();
  const failedA = { ...a, status: 'completed' as const, conclusion: 'failure', completedAt: 2 * MIN };
  set(sim, 2 * MIN, [failedA, b]);
  set(sim, 40 * MIN, [failedA, { ...b, status: 'completed', conclusion: 'success', completedAt: 40 * MIN }]);
  const shutdown = createShutdown();
  const run1 = startWait(sim, ['o/r#7', '--until', 'settled'], { shutdown });
  await clock.advance(10 * MIN);
  shutdown.trigger('SIGTERM');
  await clock.runUntil(run1.isDone, { stepMs: 1_000, maxMs: 10_000 });
  const r1 = await run1.p;
  assert.equal(r1.exitCode, EXIT.SIGTERM, r1.stdout);
  assert.equal(r1.json.outcome, 'interrupted');
  assert.equal(r1.json.exitCode, EXIT.SIGTERM);
  assert.equal(r1.json.results[0].diagnosis.jobs[0].jobId, 31, 'the diagnosis so far is in the summary');
  assert.deepEqual(r1.json.results[0].next, ['ghx ci wait o/r#7 --until settled']);
  assert.ok(sim.callsTo(/\/actions\/jobs\/31\/logs$/).length === 1);

  const n = sim.calls.length;
  const r2 = await wait(sim, ['o/r#7', '--until', 'settled'], { artifacts: run1.artifacts });
  assert.equal(r2.exitCode, EXIT.CI_RED, r2.stdout);
  assert.equal(r2.json.resumed, true);
  const later = sim.calls.slice(n);
  assert.deepEqual(
    later.filter((c) => SETUP.test(path(c))).map((c) => path(c)),
    [],
    'no baseline, ETA, expected-set, job-log or compare-main call',
  );
  assert.equal(later.find((c) => path(c) === 'repos/o/r/pulls/7')?.status, 304);
  assert.equal(r2.json.results[0].diagnosis.jobs[0].jobId, 31, 'the stored diagnosis is reused');
});

test('a known terminal state returns at once: one 304 tick, no other poll, no sleep', async () => {
  const { sim, a, b } = world();
  set(sim, 0, [
    { ...a, status: 'completed', conclusion: 'failure', completedAt: 0 },
    { ...b, status: 'completed', conclusion: 'success', completedAt: 0 },
  ]);
  const first = await wait(sim, ['o/r#7']);
  assert.equal(first.exitCode, EXIT.CI_RED);
  const n = sim.calls.length;
  const run2 = startWait(sim, ['o/r#7'], { artifacts: first.artifacts });
  await flush(20);
  const r2 = await run2.p;
  assert.equal(run2.isDone(), true);
  assert.equal(r2.exitCode, EXIT.CI_RED);
  assert.equal(r2.json.resumed, true);
  const later = sim.calls.slice(n).filter((c) => !path(c).endsWith('/contents/.github/ghx.json'));
  assert.deepEqual(
    later.map((c) => [path(c), c.status]),
    [
      ['repos/o/r/pulls/7', 304],
      [`repos/o/r/commits/${H}/check-runs`, 304],
      [`repos/o/r/commits/${H}/status`, 304],
    ],
  );
  assert.equal(sim.clock.pendingTimers(), 0);
});

test('a re-run after `ci rerun` on the same SHA waits for the new attempt instead of replaying the old red', async () => {
  const { clock, sim, a, b } = world();
  const settledRed = [
    { ...a, status: 'completed' as const, conclusion: 'failure', completedAt: 0 },
    { ...b, status: 'completed' as const, conclusion: 'success', completedAt: 0 },
  ];
  set(sim, 0, settledRed);
  const first = await wait(sim, ['o/r#7']);
  assert.equal(first.exitCode, EXIT.CI_RED);
  const t = clock.monotonic();
  set(sim, t + 1, [{ ...a, id: 41, status: 'in_progress', startedAt: t }, settledRed[1] as SimJob]);
  set(sim, t + 5 * MIN, [
    { ...a, id: 41, status: 'completed', conclusion: 'success', completedAt: t + 5 * MIN },
    settledRed[1] as SimJob,
  ]);
  await clock.advance(1);
  const second = await wait(sim, ['o/r#7'], { artifacts: first.artifacts });
  assert.equal(second.exitCode, EXIT.OK, second.stdout);
  assert.equal(second.json.resumed, true);
});

test('head moved since run 1: run 2 binds the new SHA fresh; the old state stays on disk', async () => {
  const { clock, sim, a, b } = world();
  set(sim, 0, [{ ...a, status: 'completed', conclusion: 'failure', completedAt: 0 }, b]);
  const first = await wait(sim, ['o/r#7']);
  assert.equal(first.exitCode, EXIT.CI_RED);
  const t = clock.monotonic() + 1;
  sim.at(t, (s) => ({
    ...s,
    pr: { ...s.pr, head: H2 },
    checks: {
      ...s.checks,
      [H2]: [{ id: 51, runId: 700, name: 'unit', status: 'completed', conclusion: 'success', completedAt: t }],
    },
  }));
  await clock.advance(1);
  const second = await wait(sim, ['o/r#7'], { artifacts: first.artifacts });
  assert.equal(second.exitCode, EXIT.OK, second.stdout);
  assert.equal(second.json.results[0].headSha, H2);
  assert.equal(second.json.resumed, false);
  assert.equal(second.json.results[0].restarts, 0, 'a new process does not count a restart');
  const dir = join(first.artifacts, 'github.com', 'o', 'r', 'ci-wait');
  const files = readdirSync(dir);
  assert.ok(files.includes(`pr-7-${H}.json`) && files.includes(`pr-7-${H2}.json`), files.join(','));
});

test('a corrupt state file is a miss with WAIT_STATE_DISCARDED, and the wait starts fresh', async () => {
  const { clock, sim, a, b } = world();
  const shutdown = createShutdown();
  const run1 = startWait(sim, ['o/r#7'], { shutdown });
  await clock.advance(MIN);
  shutdown.trigger('SIGINT');
  await clock.runUntil(run1.isDone, { stepMs: 1_000, maxMs: 10_000 });
  assert.equal((await run1.p).exitCode, EXIT.SIGINT);
  writeFileSync(join(run1.artifacts, 'github.com', 'o', 'r', 'ci-wait', `pr-7-${H}.json`), '{"v":1,"machine":');
  set(sim, clock.monotonic(), [
    { ...a, status: 'completed', conclusion: 'success', completedAt: 0 },
    { ...b, status: 'completed', conclusion: 'success', completedAt: 0 },
  ]);
  const r2 = await wait(sim, ['o/r#7'], { artifacts: run1.artifacts });
  assert.equal(r2.exitCode, EXIT.OK, r2.stdout);
  assert.equal(r2.json.resumed, false);
  assert.ok(r2.json.warnings.some((w: { code: string }) => w.code === 'WAIT_STATE_DISCARDED'));
});

test('state older than 24 h past the last completion is ignored', async () => {
  const { clock, sim, a, b } = world();
  set(sim, 0, [
    { ...a, status: 'completed', conclusion: 'success', completedAt: 0 },
    { ...b, status: 'completed', conclusion: 'success', completedAt: 0 },
  ]);
  const first = await wait(sim, ['o/r#7']);
  assert.equal(first.exitCode, EXIT.OK);
  await clock.advance(24 * 60 * MIN + 60_000);
  const second = await wait(sim, ['o/r#7'], { artifacts: first.artifacts });
  assert.equal(second.json.resumed, false);
});

test('concurrent runs of one target each poll on their own and both finish (04: the lock covers one load or save)', async () => {
  const { clock, sim, a, b } = world();
  set(sim, 5 * MIN, [
    { ...a, status: 'completed', conclusion: 'success', completedAt: 5 * MIN },
    { ...b, status: 'completed', conclusion: 'success', completedAt: 5 * MIN },
  ]);
  const one = startWait(sim, ['o/r#7']);
  const two = startWait(sim, ['o/r#7'], { artifacts: one.artifacts });
  await clock.runUntil(() => one.isDone() && two.isDone(), { stepMs: 1_000, maxMs: 20 * MIN });
  const [r1, r2] = [await one.p, await two.p];
  assert.equal(r1.exitCode, EXIT.OK);
  assert.equal(r2.exitCode, EXIT.OK);
  assert.ok(r1.json.results[0].elapsedSec >= 5 * 60 && r2.json.results[0].elapsedSec >= 5 * 60);
});

test('an interrupt during the ETA read leaves the workflow to be sampled again on resume', async () => {
  const { clock, sim, a, b } = world();
  let hang = true;
  sim.override(
    (argv) => hang && argv.some((x) => x.includes('/actions/workflows/')),
    () => ({ status: 0, exitCode: 0, stdout: '', stderr: '', hang: true }),
  );
  const shutdown = createShutdown();
  const run1 = startWait(sim, ['o/r#7'], { shutdown });
  await clock.advance(MIN);
  assert.equal(run1.isDone(), false, 'stuck in the ETA read');
  shutdown.trigger('SIGTERM');
  await clock.runUntil(run1.isDone, { stepMs: 1_000, maxMs: 10_000 });
  assert.equal((await run1.p).json.outcome, 'interrupted');
  hang = false;
  set(sim, clock.monotonic(), [{ ...a, status: 'completed', conclusion: 'success', completedAt: 0 }, b]);
  const n = sim.callsTo(/\/actions\/workflows\//).length;
  const run2 = startWait(sim, ['o/r#7'], { artifacts: run1.artifacts });
  await clock.advance(1_000);
  assert.ok(sim.callsTo(/\/actions\/workflows\//).length > n, 'the ETA samples are read on resume');
  set(sim, clock.monotonic(), [
    { ...a, status: 'completed', conclusion: 'success', completedAt: 0 },
    { ...b, status: 'completed', conclusion: 'success', completedAt: 0 },
  ]);
  await clock.runUntil(run2.isDone, { stepMs: 5_000, maxMs: 10 * MIN });
  assert.equal((await run2.p).exitCode, EXIT.OK);
});

test('branch:main moved since run 1: run 2 binds the new head fresh, not the stored SHA', async () => {
  const clock = new FakeClock();
  const ok = (id: number, at: number): SimJob => ({
    id,
    runId: id,
    name: 'build',
    status: 'completed',
    conclusion: 'success',
    completedAt: at,
  });
  const sim = new GitHubSim(clock, {
    pr: { state: 'open', head: H },
    branches: { main: H },
    checks: { [H]: [ok(61, 0)] },
  });
  const first = await wait(sim, ['branch:main', '-R', 'o/r']);
  assert.equal(first.exitCode, EXIT.OK, first.stdout);
  assert.equal(first.json.results[0].headSha, H);
  const t = clock.monotonic() + 1;
  sim.at(t, (s) => ({ ...s, branches: { main: H2 }, checks: { ...s.checks, [H2]: [ok(62, t)] } }));
  await clock.advance(1);
  const second = await wait(sim, ['branch:main', '-R', 'o/r'], { artifacts: first.artifacts });
  assert.equal(second.exitCode, EXIT.OK, second.stdout);
  assert.equal(second.json.results[0].headSha, H2);
  assert.equal(second.json.resumed, false);
});

test('--on-head-change stop: a head that moved between runs is bound fresh, never a superseded loop', async () => {
  const { clock, sim, a, b } = world();
  set(sim, 0, [{ ...a, status: 'completed', conclusion: 'failure', completedAt: 0 }, b]);
  const first = await wait(sim, ['o/r#7', '--on-head-change', 'stop']);
  assert.equal(first.exitCode, EXIT.CI_RED);
  const t = clock.monotonic() + 1;
  sim.at(t, (s) => ({
    ...s,
    pr: { ...s.pr, head: H2 },
    checks: {
      ...s.checks,
      [H2]: [{ id: 51, runId: 700, name: 'unit', status: 'completed', conclusion: 'success', completedAt: t }],
    },
  }));
  await clock.advance(1);
  for (let i = 0; i < 2; i++) {
    const r = await wait(sim, ['o/r#7', '--on-head-change', 'stop'], { artifacts: first.artifacts });
    assert.equal(r.exitCode, EXIT.OK, r.stdout);
    assert.equal(r.json.results[0].headSha, H2);
  }
});
