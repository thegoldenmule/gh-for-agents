// One wait per target (state.ts lease): a second ghx ci wait on the same target, repo and machine follows
// the one already polling instead of starting a second poller, and returns the same answer; it takes over
// when the leader is gone (exited, dead pid, or past the `until` it promised).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createShutdown } from '../../src/core/signals.ts';
import { EXIT } from '../contract/exit-table.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { scratchDir } from '../helpers/harness.ts';
import { GitHubSim, type SimCall, type SimJob, sha, startWait, wait } from './ci-wait-world.ts';

const H = sha('a');
const MIN = 60_000;

function world() {
  const clock = new FakeClock();
  const a: SimJob = { id: 31, runId: 600, name: 'unit', status: 'in_progress', startedAt: 0 };
  const b: SimJob = { id: 32, runId: 600, name: 'e2e', status: 'in_progress', startedAt: 0 };
  const sim = new GitHubSim(clock, { pr: { state: 'open', head: H }, checks: { [H]: [a, b] } });
  return { clock, sim, a, b };
}

const greenAt = (sim: GitHubSim, a: SimJob, b: SimJob, at: number) =>
  sim.at(at, (s) => {
    s.checks[H] = [
      { ...a, status: 'completed', conclusion: 'success', completedAt: at },
      { ...b, status: 'completed', conclusion: 'success', completedAt: at },
    ];
    return s;
  });

const path = (c: SimCall) => c.argv.find((x) => x.startsWith('repos/'))?.split('?')[0] ?? c.argv[1] ?? '';
/** Every GitHub call but the config read each process makes for itself. */
const polls = (calls: readonly SimCall[]) => calls.filter((c) => !path(c).endsWith('/contents/.github/ghx.json'));
const codes = (r: { json: { warnings?: { code: string }[] } }) => (r.json.warnings ?? []).map((w) => w.code);
const leaseDir = (artifacts: string) => join(artifacts, 'github.com', 'o', 'r', 'ci-wait');

test('two concurrent waits on one PR make one set of API polls and return the same answer', async () => {
  const solo = world();
  greenAt(solo.sim, solo.a, solo.b, 12 * MIN);
  const alone = await wait(solo.sim, ['o/r#7']);
  assert.equal(alone.exitCode, EXIT.OK, alone.stdout);

  const { clock, sim, a, b } = world();
  greenAt(sim, a, b, 12 * MIN);
  const one = startWait(sim, ['o/r#7']);
  await clock.advance(30_000);
  const two = startWait(sim, ['o/r#7'], { artifacts: one.artifacts });
  await clock.runUntil(() => one.isDone() && two.isDone(), { stepMs: 5_000, maxMs: 30 * MIN });
  const [r1, r2] = [await one.p, await two.p];
  assert.equal(r1.exitCode, EXIT.OK, r1.stdout);
  assert.equal(r2.exitCode, EXIT.OK, r2.stdout);
  assert.deepEqual(
    polls(sim.calls).map((c) => [path(c), c.at]),
    polls(solo.sim.calls).map((c) => [path(c), c.at]),
    'the same calls at the same times as one wait alone',
  );
  assert.deepEqual(r2.json.results[0].headSha, r1.json.results[0].headSha);
  assert.equal(r2.json.results[0].outcome, 'green');
  assert.ok(codes(r2).includes('WAIT_ATTACHED'), r2.stdout);
  assert.ok(!codes(r1).includes('WAIT_ATTACHED'));
});

test('the follower takes over when the leader is interrupted, and polls only from then on', async () => {
  const { clock, sim, a, b } = world();
  greenAt(sim, a, b, 15 * MIN);
  const shutdown = createShutdown();
  const one = startWait(sim, ['o/r#7'], { shutdown });
  await clock.advance(30_000);
  const two = startWait(sim, ['o/r#7'], { artifacts: one.artifacts });
  await clock.advance(2 * MIN);
  shutdown.trigger('SIGTERM');
  await clock.runUntil(one.isDone, { stepMs: 1_000, maxMs: MIN });
  assert.equal((await one.p).json.outcome, 'interrupted');
  const before = polls(sim.calls).length;
  await clock.runUntil(two.isDone, { stepMs: 5_000, maxMs: 30 * MIN });
  const r2 = await two.p;
  assert.equal(r2.exitCode, EXIT.OK, r2.stdout);
  assert.equal(r2.json.resumed, true, 'it resumed the leader’s saved state');
  assert.ok(polls(sim.calls).length > before, 'the follower polls once it leads');
});

test('a lease whose pid is dead, or that is past its until, is broken: the new wait leads', async () => {
  for (const lease of [
    { pid: 999_999, at: 0, until: Number.MAX_SAFE_INTEGER, nonce: 'deadbeef' },
    { pid: process.pid, at: 0, until: 1, nonce: 'cafebabe' },
    'not json',
  ]) {
    const { sim, a, b } = world();
    greenAt(sim, a, b, 3 * MIN);
    const artifacts = mkdtempSync(join(scratchDir(), 'wait-'));
    mkdirSync(leaseDir(artifacts), { recursive: true });
    writeFileSync(join(leaseDir(artifacts), 'pr-7.lease'), typeof lease === 'string' ? lease : JSON.stringify(lease));
    const r = await wait(sim, ['o/r#7', '--until', 'settled'], { artifacts });
    assert.equal(r.exitCode, EXIT.OK, r.stdout);
    assert.ok(codes(r).includes('WAIT_TAKEN_OVER'), `${JSON.stringify(lease)}: ${r.stdout}`);
    assert.ok(!codes(r).includes('WAIT_ATTACHED'));
  }
});

test('a follower with another question does not adopt the leader’s answer: it takes over and answers its own', async () => {
  const { clock, sim, a, b } = world();
  // unit fails at 2 min; e2e passes at 10 min. first-failure answers red at 2 min; settled waits to 10.
  sim.at(2 * MIN, (s) => {
    s.checks[H] = [{ ...a, status: 'completed', conclusion: 'failure', completedAt: 2 * MIN }, b];
    return s;
  });
  sim.at(10 * MIN, (s) => {
    s.checks[H] = [
      { ...a, status: 'completed', conclusion: 'failure', completedAt: 2 * MIN },
      { ...b, status: 'completed', conclusion: 'success', completedAt: 10 * MIN },
    ];
    return s;
  });
  const one = startWait(sim, ['o/r#7', '--no-diagnose']);
  await clock.advance(10_000);
  const two = startWait(sim, ['o/r#7', '--until', 'settled', '--no-diagnose'], { artifacts: one.artifacts });
  await clock.runUntil(() => one.isDone() && two.isDone(), { stepMs: 5_000, maxMs: 30 * MIN });
  const [r1, r2] = [await one.p, await two.p];
  assert.equal(r1.exitCode, EXIT.CI_RED, r1.stdout);
  assert.equal(r1.json.results[0].reason, 'first-failure');
  assert.equal(r2.exitCode, EXIT.CI_RED, r2.stdout);
  assert.equal(r2.json.results[0].reason, 'settled', 'its own question, answered after it took over');
  assert.ok(r2.json.results[0].elapsedSec >= 9 * 60);
});

test('a first-failure follower adopts a settled leader’s answer', async () => {
  const { clock, sim, a, b } = world();
  greenAt(sim, a, b, 6 * MIN);
  const one = startWait(sim, ['o/r#7', '--until', 'settled']);
  await clock.advance(10_000);
  const two = startWait(sim, ['o/r#7'], { artifacts: one.artifacts });
  await clock.runUntil(() => one.isDone() && two.isDone(), { stepMs: 5_000, maxMs: 30 * MIN });
  const r2 = await two.p;
  assert.equal(r2.exitCode, EXIT.OK, r2.stdout);
  assert.ok(codes(r2).includes('WAIT_ATTACHED'));
  assert.equal(r2.json.resumed, false, 'adopted, not resumed');
});

test('a follower still following at its self-return reports whom it follows', async () => {
  const { clock, sim } = world();
  const one = startWait(sim, ['o/r#7']);
  await clock.advance(10_000);
  const two = startWait(sim, ['o/r#7', '--foreground'], { artifacts: one.artifacts });
  await clock.runUntil(two.isDone, { stepMs: 5_000, maxMs: 15 * MIN });
  const r2 = await two.p;
  assert.equal(r2.exitCode, EXIT.CI_PENDING_RESUME, r2.stdout);
  assert.match(r2.json.results[0].reason, /^foreground-self-return; following pid \d+$/);
  assert.equal(one.isDone(), false, 'the leader keeps waiting');
});
