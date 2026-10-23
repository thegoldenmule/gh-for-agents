// Exit rows of 02 §6.1 that need a GitHub reply, through the real bin and the fake gh (exit-codes.contract
// covers the rows producible without one; 3, 6, 7, 10 and 15 have their own contract files). Static
// scenarios live in test/fixtures/gh/<name>/. The ci wait outcomes (11–14) are recorded from full
// in-process runs on the GitHub sim, so the spawned run replays exactly the calls it makes.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { createShutdown } from '../../src/core/signals.ts';
import { type Recorded, recordingRunner, writeScenario } from '../commands/ci-wait-record.ts';
import { drive, GitHubSim, type SimState, sha, startWait } from '../commands/ci-wait-world.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { scratchDir } from '../helpers/harness.ts';
import { spawnGhx } from '../helpers/spawn.ts';
import { dirs } from './ci-wait-scenario.ts';
import { EXIT } from './exit-table.ts';

const ERROR_KEYS = ['code', 'message', 'hint', 'details'];

test('exit 4 (ENV_GH_AUTH): gh answers its first call with the auth login prompt', async () => {
  const d = dirs();
  const r = await spawnGhx(['ci', 'why', '--run', '5', '-R', 'o/r'], { fakeGh: true, env: d.env('env-gh-auth') });
  assert.equal(r.exitCode, EXIT.ENV, r.stdout + r.stderr);
  const { error } = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(error), ERROR_KEYS);
  assert.equal(error.code, 'ENV_GH_AUTH');
  assert.match(error.hint, /gh auth login/);
});

test('exit 5 (RUN_NOT_FOUND): ci why --run on a run that does not exist', async () => {
  const d = dirs();
  const r = await spawnGhx(['ci', 'why', '--run', '5', '-R', 'o/r'], {
    fakeGh: true,
    env: d.env('exit-run-not-found'),
  });
  assert.equal(r.exitCode, EXIT.NOT_FOUND, r.stdout + r.stderr);
  const { error } = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(error), ERROR_KEYS);
  assert.equal(error.code, 'RUN_NOT_FOUND');
});

test('exit 9 (HEAD_MOVED): pr merge --expect-head on a PR whose head is elsewhere, before any PUT', async () => {
  const d = dirs();
  const r = await spawnGhx(['pr', 'merge', '3301', '-R', 'powerhouse-inc/powerhouse', '--expect-head', '1234567'], {
    fakeGh: true,
    env: d.env('smoke/pr-merge'),
  });
  assert.equal(r.exitCode, EXIT.STATE, r.stdout + r.stderr);
  const { error } = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(error), ERROR_KEYS);
  assert.equal(error.code, 'HEAD_MOVED');
  assert.equal(error.details.expected, '1234567');
});

// ── ci wait outcomes ────────────────────────────────────────────────────────
const MIN = 60_000;
const H = sha('a');

/** Record a full in-process wait on the sim (real "now", so job times mean the same to the spawned run). */
async function recordFull(
  state: SimState,
  argv: string[],
  want: number,
  o: ConstructorParameters<typeof GitHubSim>[2] = {},
): Promise<string> {
  const sim = new GitHubSim(new FakeClock(Date.now()), state, o);
  const rec: Recorded[] = [];
  const run = startWait(sim, argv, { proc: recordingRunner(sim, rec) });
  await drive(sim, run.isDone, { stepMs: 1_000, maxMs: 30 * MIN });
  const r = await run.p;
  assert.equal(r.exitCode, want, `in-process recording: ${r.stdout}`);
  const scenario = join(scratchDir(), `exit-rows-${want}-${process.pid}-${Date.now()}`);
  writeScenario(scenario, rec, 'recorded from a full run of the ci wait GitHub sim');
  return scenario;
}

async function spawnWait(scenario: string, argv: string[], artifacts?: string) {
  const d = dirs();
  const r = await spawnGhx(['ci', 'wait', ...argv], {
    fakeGh: true,
    env: d.env(scenario, artifacts ? { GHX_ARTIFACT_DIR: artifacts } : {}),
    timeoutMs: 60_000,
  });
  return { ...r, json: JSON.parse(r.stdout || '{}') };
}

test('exit 11 (red-shared): the failing test also fails on main', { timeout: 60_000 }, async () => {
  const t = 'src/a.test.ts > flaky on main';
  const state: SimState = {
    pr: { state: 'open', head: H },
    checks: {
      [H]: [
        { id: 41, runId: 600, name: 'unit', status: 'completed', conclusion: 'failure', completedAt: 0, tests: [t] },
      ],
    },
  };
  const mainRuns = [
    {
      id: 950,
      jobs: [
        {
          id: 9501,
          runId: 950,
          name: 'unit',
          status: 'completed' as const,
          conclusion: 'failure',
          startedAt: -60 * MIN,
          completedAt: -50 * MIN,
          tests: [t],
        },
      ],
    },
  ];
  const scenario = await recordFull(state, ['o/r#7'], EXIT.CI_RED_SHARED, { mainRuns });
  const r = await spawnWait(scenario, ['o/r#7']);
  assert.equal(r.exitCode, EXIT.CI_RED_SHARED, r.stdout + r.stderr);
  assert.equal(r.json.outcome, 'red-shared');
});

test('exit 12 (superseded): the PR is already closed', { timeout: 60_000 }, async () => {
  const state: SimState = {
    pr: { state: 'closed', merged: false, head: H },
    checks: { [H]: [{ id: 51, runId: 600, name: 'unit', status: 'in_progress', startedAt: 0 }] },
  };
  const scenario = await recordFull(state, ['o/r#7'], EXIT.SUPERSEDED);
  const r = await spawnWait(scenario, ['o/r#7']);
  assert.equal(r.exitCode, EXIT.SUPERSEDED, r.stdout + r.stderr);
  assert.equal(r.json.outcome, 'closed');
});

test('exit 14 (stalled): a check queued for 31 minutes while nothing in its run started', {
  timeout: 60_000,
}, async () => {
  const state: SimState = {
    pr: { state: 'open', head: H },
    checks: { [H]: [{ id: 61, runId: 610, name: 'deploy', status: 'queued', createdAt: -31 * MIN }] },
  };
  const scenario = await recordFull(state, ['o/r#7'], EXIT.CI_STALLED);
  const r = await spawnWait(scenario, ['o/r#7']);
  assert.equal(r.exitCode, EXIT.CI_STALLED, r.stdout + r.stderr);
  assert.equal(r.json.outcome, 'stalled');
  assert.equal(r.json.results[0].stalled[0].state, 'queued');
});

// No-checks needs the 120 s registering grace to have passed since the wait bound the head. Rather than
// wait 2 real minutes, the wait is bound 10 minutes ago in-process (run 1, interrupted) and the spawned
// run resumes that state; run 2 records the conditional polls a resumed run makes.
test('exit 13 (no-checks): nothing registered within the grace, on a resumed wait', { timeout: 60_000 }, async () => {
  const d = dirs();
  const artifacts = join(d.dir, 'artifacts');
  const sim = new GitHubSim(new FakeClock(Date.now() - 10 * MIN), { pr: { state: 'open', head: H }, checks: {} });
  const rec: Recorded[] = [];
  for (let i = 0; i < 2; i++) {
    const shutdown = createShutdown();
    const run = startWait(sim, ['o/r#7'], { proc: recordingRunner(sim, rec), artifacts, shutdown });
    await drive(sim, () => false, { stepMs: 5_000, maxMs: 5_000 }).catch(() => {});
    shutdown.trigger('SIGTERM');
    await drive(sim, run.isDone, { maxMs: 10_000 });
    assert.equal((await run.p).exitCode, EXIT.SIGTERM);
  }
  const scenario = join(scratchDir(), `exit-rows-13-${process.pid}-${Date.now()}`);
  writeScenario(scenario, rec, 'recorded from two interrupted runs of the ci wait GitHub sim');
  const r = await spawnWait(scenario, ['o/r#7'], artifacts);
  assert.equal(r.exitCode, EXIT.NO_CHECKS, r.stdout + r.stderr);
  assert.equal(r.json.outcome, 'no-checks');
  assert.equal(r.json.resumed, true);
});
