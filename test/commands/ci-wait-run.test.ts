// ci wait run:<id> (02 §11, §11.5): one workflow run, without a PR. It reads the run and its latest jobs
// (both conditional), expects nothing beyond them, and never settles while the run itself is going: jobs
// that `needs` others, or a rerun's new attempt, come later. Also: targets ci wait refuses before any call,
// and the no-checks of a PR that conflicts with its base.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT } from '../contract/exit-table.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { GitHubSim, type SimJob, type SimState, sha, wait } from './ci-wait-world.ts';

const H = sha('e');
const MIN = 60_000;
const RUN = 900;

const job = (id: number, name: string, o: Partial<SimJob> = {}): SimJob => ({
  id,
  runId: RUN,
  name,
  status: 'completed',
  conclusion: 'success',
  startedAt: 0,
  completedAt: 0,
  ...o,
});

/** No PR: the run's jobs live on commit H (the sim's PR points elsewhere and must never be read). */
const state = (jobs: SimJob[], o: Partial<SimState> = {}): SimState => ({
  pr: { state: 'open', head: sha('0') },
  checks: { [H]: jobs },
  ...o,
});

test('run:<id>: a completed red run is red (exit 10) with its diagnosis, read from the run alone', async () => {
  const sim = new GitHubSim(new FakeClock(), state([job(1, 'unit', { conclusion: 'failure' }), job(2, 'lint')]));
  const r = await wait(sim, [`run:${RUN}`, '-R', 'o/r']);
  assert.equal(r.exitCode, EXIT.CI_RED, r.stdout);
  const t = r.json.results[0];
  assert.equal(t.target, `run:${RUN}`);
  assert.equal(t.headSha, H);
  assert.equal(t.ci.state, 'red');
  assert.deepEqual(
    t.ci.failing.map((f: { name: string; runId: number }) => [f.name, f.runId]),
    [['unit', RUN]],
  );
  assert.equal(t.diagnosis.jobs[0].job, 'unit');
  assert.equal(sim.callsTo(/\/pulls\//).length, 0, 'a run target never reads a PR');
  assert.equal(sim.callsTo(/\/check-runs$/).length, 0, 'nor the commit’s check runs');
  assert.equal(sim.callsTo(/\/branches\//).length, 0, 'nor required checks');
  assert.ok(sim.callsTo(`repos/o/r/actions/runs/${RUN}/jobs`).length > 0);
  assert.deepEqual(sim.mutations(), []);
});

test('run:<id>: a flaky failure suggests ci rerun run:<id> -R, not a PR', async () => {
  const flaky = job(1, 'unit', { conclusion: 'failure', logExtra: ['Error: read ECONNRESET'] });
  const sim = new GitHubSim(new FakeClock(), state([flaky]));
  const r = await wait(sim, [`run:${RUN}`, '-R', 'o/r']);
  assert.equal(r.exitCode, EXIT.CI_RED, r.stdout);
  assert.deepEqual(r.json.results[0].rerunCandidates, [1]);
  assert.ok(r.json.results[0].next.includes(`ghx ci rerun run:${RUN} -R o/r --flaky`), r.stdout);
});

test('run:<id>: a job cancelled before any runner picked it up is a no-runner rerun candidate, not LOGS_NOT_READY', async () => {
  const starved = job(1, 'pack-test (macos-latest)', { conclusion: 'cancelled', noRunner: true });
  const sim = new GitHubSim(new FakeClock(), state([starved, job(2, 'check')]));
  const r = await wait(sim, [`run:${RUN}`, '-R', 'o/r']);
  assert.equal(r.exitCode, EXIT.CI_RED, r.stdout);
  const t = r.json.results[0];
  assert.deepEqual(t.diagnosis.jobs[0], {
    job: 'pack-test (macos-latest)',
    workflow: 'CI',
    jobId: 1,
    step: null,
    tests: [],
    firstError: null,
    logPath: null,
    sameOnMain: 'not-compared',
    flake: 'high',
  });
  assert.deepEqual(t.rerunCandidates, [1]);
  assert.ok(t.next.includes(`ghx ci rerun run:${RUN} -R o/r --flaky`), r.stdout);
  assert.ok(!(r.json.warnings ?? []).some((w: { code: string }) => w.code === 'LOGS_NOT_READY'), r.stdout);
  assert.equal(sim.callsTo(/\/actions\/jobs\/1\/logs$/).length, 0, 'no log was ever written');
});

test('run:<id>: every listed job done while the run is still going is not settled; later jobs count', async () => {
  const sim = new GitHubSim(new FakeClock(), state([job(1, 'build')], { runs: { [RUN]: { status: 'in_progress' } } }));
  // A job that `needs` build appears at 3 min, completes green at 5 min; the run completes then.
  sim.at(3 * MIN, (s) => ({ ...s, checks: { [H]: [job(1, 'build'), job(2, 'deploy', { status: 'in_progress' })] } }));
  sim.at(5 * MIN, (s) => ({
    ...s,
    runs: {},
    checks: { [H]: [job(1, 'build'), job(2, 'deploy', { completedAt: 5 * MIN })] },
  }));
  const r = await wait(sim, [`run:${RUN}`, '-R', 'o/r']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.ok(
    r.json.results[0].elapsedSec >= 5 * 60,
    `${r.json.results[0].elapsedSec} s: not green before the run ended`,
  );
  assert.equal(r.json.results[0].ci.counts.pass, 2);
});

test('run:<id>: a queued run with no jobs yet keeps waiting past the grace (not no-checks)', async () => {
  const sim = new GitHubSim(new FakeClock(), state([], { runs: { [RUN]: { status: 'queued' } } }));
  sim.at(10 * MIN, (s) => ({ ...s, runs: {}, checks: { [H]: [job(1, 'build', { completedAt: 10 * MIN })] } }));
  const r = await wait(sim, [`run:${RUN}`, '-R', 'o/r']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.results[0].outcome, 'green');
});

test('run:<id> after ci rerun: the new attempt is waited on, and the stored red no longer stands', async () => {
  const sim = new GitHubSim(new FakeClock(), state([job(1, 'unit', { conclusion: 'failure' }), job(2, 'lint')]));
  const first = await wait(sim, [`run:${RUN}`, '--until', 'settled', '-R', 'o/r']);
  assert.equal(first.exitCode, EXIT.CI_RED, first.stdout);
  // The rerun: attempt 2 queues the failed job again (a new job id) and completes green at +4 min.
  const now = sim.clock.monotonic();
  sim.at(now, (s) => ({
    ...s,
    runs: { [RUN]: { status: 'queued', attempt: 2 } },
    checks: { [H]: [job(3, 'unit', { status: 'queued', startedAt: now }), job(2, 'lint')] },
  }));
  sim.at(now + 4 * MIN, (s) => ({
    ...s,
    runs: { [RUN]: { status: 'completed', attempt: 2 } },
    checks: { [H]: [job(3, 'unit', { startedAt: now, completedAt: now + 4 * MIN }), job(2, 'lint')] },
  }));
  const second = await wait(sim, [`run:${RUN}`, '--until', 'settled', '-R', 'o/r'], { artifacts: first.artifacts });
  assert.equal(second.exitCode, EXIT.OK, second.stdout);
  assert.equal(second.json.results[0].outcome, 'green');
});

test('a run that does not exist is RUN_NOT_FOUND (exit 5)', async () => {
  const sim = new GitHubSim(new FakeClock(), state([]));
  const r = await wait(sim, ['run:12345', '-R', 'o/r']);
  assert.equal(r.exitCode, EXIT.NOT_FOUND, r.stdout);
  assert.equal(r.json.error.code, 'RUN_NOT_FOUND');
});

// --- refused before any gh call ---

test('--until mergeable with run:<id> is VALIDATION (exit 2): a run has no mergeable state', async () => {
  const sim = new GitHubSim(new FakeClock(), state([]));
  const r = await wait(sim, [`run:${RUN}`, '--until', 'mergeable', '-R', 'o/r']);
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  assert.equal(r.json.error.code, 'VALIDATION');
  assert.match(r.json.error.hint, /--until settled for a branch or run target/);
  assert.equal(sim.calls.length, 0);
});

test('a bare branch name (ci wait main --until mergeable) is USAGE_BAD_SELECTOR naming branch:main', async () => {
  for (const argv of [['main', '--until', 'mergeable'], ['main']]) {
    const sim = new GitHubSim(new FakeClock(), state([]));
    const r = await wait(sim, [...argv, '-R', 'o/r']);
    assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
    assert.equal(r.json.error.code, 'USAGE_BAD_SELECTOR');
    assert.match(r.json.error.hint, /ci wait branch:main/);
    assert.match(r.json.error.hint, /--until mergeable takes a PR/);
    assert.equal(sim.calls.length, 0);
  }
});

// --- a PR with a merge conflict: GitHub runs no pull_request workflow on it ---

test('no-checks on a conflicting PR keeps exit 13 and says why: merge or rebase the base, then push', async () => {
  const sim = new GitHubSim(new FakeClock(), { pr: { state: 'open', head: H, mergeable: false }, checks: {} });
  const r = await wait(sim, ['o/r#7']);
  assert.equal(r.exitCode, EXIT.NO_CHECKS, r.stdout);
  const t = r.json.results[0];
  assert.equal(t.outcome, 'no-checks');
  assert.equal(t.reason, 'merge-conflict');
  assert.deepEqual(t.next, ['git fetch origin main && git merge origin/main', 'ghx ci wait o/r#7']);
  const w = (r.json.warnings as { code: string; message: string }[]).find((x) => x.code === 'MERGE_CONFLICT');
  assert.match(w?.message ?? '', /o\/r#7 conflicts with main.*no pull_request workflows.*Merge or rebase main/);
});

test('no-checks on a PR without a conflict still suggests ci retrigger', async () => {
  const sim = new GitHubSim(new FakeClock(), { pr: { state: 'open', head: H, mergeable: true }, checks: {} });
  const r = await wait(sim, ['o/r#7']);
  assert.equal(r.exitCode, EXIT.NO_CHECKS, r.stdout);
  assert.equal(r.json.results[0].reason, 'grace');
  assert.deepEqual(r.json.results[0].next, ['ghx ci retrigger o/r#7', 'ghx ci wait o/r#7']);
});
