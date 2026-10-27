// ghx ci wait on a run GitHub rejected before any job ran (an invalid workflow file): red at once (exit 10,
// reason workflow-invalid) for PR, branch: and run: targets, never no-checks, never a re-wait or a rerun.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT } from '../contract/exit-table.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { GitHubSim, type SimJob, type SimState, sha, wait } from './ci-wait-world.ts';

const H = sha('a');
const BAD = 40518894617;
const FIX = `Fix .github/workflows/ci.yml: GitHub rejected it before any job ran. Read the error on https://github.com/o/r/actions/runs/${BAD}, then commit and push.`;

const rejected = (o: Partial<NonNullable<SimState['rejected']>[string][number]> = {}) => ({
  [H]: [{ id: BAD, path: '.github/workflows/ci.yml', ...o }],
});
const lint: SimJob = { id: 11, runId: 500, name: 'lint', status: 'in_progress', startedAt: 0 };

function sim(extra: Partial<SimState> = {}) {
  return new GitHubSim(new FakeClock(), { pr: { state: 'open', head: H }, checks: {}, ...extra });
}

function expectRejected(r: Awaited<ReturnType<typeof wait>>, target: string) {
  assert.equal(r.exitCode, EXIT.CI_RED, r.stdout);
  const t = r.json.results[0];
  assert.equal(t.target, target);
  assert.equal(t.outcome, 'red');
  assert.equal(t.reason, 'workflow-invalid');
  assert.equal(t.ci.state, 'red');
  assert.deepEqual(t.ci.failing, [
    { name: '.github/workflows/ci.yml', workflow: t.ci.failing[0].workflow, jobId: null, runId: BAD },
  ]);
  assert.deepEqual(t.next, [FIX], 'fix the file: no re-wait, no rerun');
  assert.deepEqual(t.rerunCandidates, []);
  const w = (r.json.warnings as { code: string; message: string }[]).filter((x) => x.code === 'WORKFLOW_INVALID');
  assert.equal(w.length, 1);
  assert.match(w[0]?.message ?? '', /rejected \.github\/workflows\/ci\.yml before any job ran.*run page shows it/);
  return t;
}

test('PR: a rejected run on the head ends red on the first tick, not no-checks after the grace', async () => {
  const s = sim({ rejected: rejected() });
  const r = await wait(s, ['o/r#7']);
  const t = expectRejected(r, 'o/r#7');
  assert.ok(t.elapsedSec < 60, `ended at once (${t.elapsedSec} s), not after the 120 s grace`);
  assert.equal(s.callsTo(`repos/o/r/actions/runs/${BAD}/jobs`).length, 0, 'the runs listing alone proves it');
  assert.deepEqual(s.mutations(), []);
});

test('PR, --until settled: ends at once although other checks still run', async () => {
  const r = await wait(sim({ checks: { [H]: [lint] }, rejected: rejected() }), ['o/r#7', '--until', 'settled']);
  const t = expectRejected(r, 'o/r#7');
  assert.equal(t.ci.counts.pending, 1);
});

test('PR, --check: a rejected run counts whatever the glob selects', async () => {
  const r = await wait(sim({ checks: { [H]: [lint] }, rejected: rejected() }), ['o/r#7', '--check', 'lint']);
  expectRejected(r, 'o/r#7');
});

test('the identical command on the same SHA returns the same red again, not a continued wait', async () => {
  const s = sim({ rejected: rejected() });
  const first = await wait(s, ['o/r#7']);
  expectRejected(first, 'o/r#7');
  const again = await wait(s, ['o/r#7'], { artifacts: first.artifacts });
  assert.equal(again.exitCode, EXIT.CI_RED, again.stdout);
  assert.equal(again.json.results[0].reason, 'workflow-invalid');
  assert.deepEqual(again.json.results[0].next, [FIX]);
});

test('branch:<name>: the rejected run on the branch head is red', async () => {
  const s = sim({ pr: { state: 'open', head: sha('0') }, branches: { main: H }, rejected: rejected() });
  const r = await wait(s, ['branch:main', '-R', 'o/r', '--until', 'settled']);
  expectRejected(r, 'branch:main');
});

test('run:<id>: the rejected run itself is red, from the run and its empty job list', async () => {
  const s = sim({ pr: { state: 'open', head: sha('0') }, rejected: rejected({ conclusion: 'startup_failure' }) });
  const r = await wait(s, [`run:${BAD}`, '-R', 'o/r']);
  assert.equal(r.exitCode, EXIT.CI_RED, r.stdout);
  const t = r.json.results[0];
  assert.equal(t.reason, 'workflow-invalid');
  assert.deepEqual(t.ci.failing, [
    { name: '.github/workflows/ci.yml', workflow: '.github/workflows/ci.yml', jobId: null, runId: BAD },
  ]);
  assert.deepEqual(t.next, [FIX]);
  assert.equal(s.callsTo(/\/check-runs$/).length, 0);
});

test('no run at all is still no-checks (exit 13) after the grace', async () => {
  const r = await wait(sim({ pr: { state: 'open', head: H, mergeable: true } }), ['o/r#7']);
  assert.equal(r.exitCode, EXIT.NO_CHECKS, r.stdout);
  assert.equal(r.json.results[0].reason, 'grace');
});

test('a zero-job run awaiting approval (action_required) is not a rejected workflow: still no-checks', async () => {
  const r = await wait(
    sim({ pr: { state: 'open', head: H, mergeable: true }, rejected: rejected({ conclusion: 'action_required' }) }),
    ['o/r#7'],
  );
  assert.equal(r.exitCode, EXIT.NO_CHECKS, r.stdout);
});

test('a failed run with jobs is an ordinary red, diagnosed, not workflow-invalid', async () => {
  const unit: SimJob = { id: 31, runId: 600, name: 'unit', status: 'completed', conclusion: 'failure', completedAt: 0 };
  const r = await wait(sim({ checks: { [H]: [unit] } }), ['o/r#7']);
  assert.equal(r.exitCode, EXIT.CI_RED, r.stdout);
  assert.notEqual(r.json.results[0].reason, 'workflow-invalid');
  assert.equal(r.json.results[0].diagnosis.jobs[0].job, 'unit');
});
