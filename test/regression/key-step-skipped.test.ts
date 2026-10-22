// R19 (03 §5.2). Guards §6's misleading green (memory trap_workflow_ui_skipped_on_prs.md): a job that
// concluded success although its key test step was skipped (an `if:` false on PRs). With ci.keySteps
// set, ci why lists it in `suspicious`; without it, no extra call is made.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha, type WJob, type World, why } from '../commands/ci-why-world.ts';
import { EXIT } from '../contract/exit-table.ts';

const RUN = 600;

const skippedTests: WJob = {
  id: 61,
  runId: RUN,
  name: 'workflow-ui',
  workflow: 'UI',
  conclusion: 'success',
  steps: [
    { name: 'Set up job', status: 'completed', conclusion: 'success', number: 1 },
    { name: 'Build', status: 'completed', conclusion: 'success', number: 2 },
    { name: 'Run tests', status: 'completed', conclusion: 'skipped', number: 3 },
    { name: 'Complete job', status: 'completed', conclusion: 'success', number: 4 },
  ],
};
const ranTests: WJob = { id: 62, runId: RUN, name: 'unit', conclusion: 'success', step: 'Run tests' };

const config = { version: 1, components: { core: {} }, ci: { keySteps: ['Run tests'] } };
const world = (o: Partial<World> = {}): World => ({
  slug: 'o/ui',
  number: 19,
  headSha: sha('f'),
  jobs: [skippedTests, ranTests],
  config,
  ...o,
});

const jobsCalls = (calls: { argv: string[] }[]) =>
  calls.filter((c) => c.argv.some((a) => a.startsWith(`repos/o/ui/actions/runs/${RUN}/jobs`)));

test('R19: a green job whose ci.keySteps step was skipped is reported as key-step-skipped', async () => {
  const r = await why(world());
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.ci.state, 'green');
  assert.deepEqual(r.json.failing, []);
  assert.deepEqual(r.json.suspicious, [
    { workflow: 'UI', job: 'workflow-ui', jobId: 61, step: 'Run tests', reason: 'key-step-skipped' },
  ]);
  assert.equal(jobsCalls(r.fake.calls).length, 1, 'one jobs listing per run');
  r.fake.expectNoMutations();
});

test('R19: without ci.keySteps nothing is listed and no jobs listing is made', async () => {
  const r = await why(world({ config: null }));
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(r.json.suspicious, []);
  assert.equal(jobsCalls(r.fake.calls).length, 0);
});

test('R19 with --run: the run jobs already read are reused for key steps', async () => {
  const r = await why(world(), ['--run', String(RUN), '-R', 'o/ui'], { selector: false });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.suspicious.length, 1);
  assert.equal(jobsCalls(r.fake.calls).length, 1, 'the run jobs are listed once');
});
