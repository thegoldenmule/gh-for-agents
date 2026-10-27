// Read-only Actions helpers (src/ci/github.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActionsJob, countWorkflows, isNoRunner } from '../../../src/ci/github.ts';
import { noRunnerRow } from '../../commands/ci-why-world.ts';
import { ciEnv, notFound, ok, repoOf } from './_helpers.ts';

test('countWorkflows reads total_count from one page of actions/workflows, as a read', async () => {
  const env = ciEnv();
  env.fake.on((a) => a.some((x) => x.startsWith('repos/o/r/actions/workflows')), ok({ total_count: 0, workflows: [] }));
  assert.equal(await countWorkflows({ gh: env.gh, repo: repoOf('o/r') }), 0);
  const argv = env.fake.calls[0]?.argv ?? [];
  assert.ok(
    argv.some((x) => x.includes('per_page=1')),
    argv.join(' '),
  );
  env.fake.expectNoMutations();

  const three = ciEnv();
  three.fake.on(() => true, ok({ total_count: 3, workflows: [{ id: 1 }] }));
  assert.equal(await countWorkflows({ gh: three.gh, repo: repoOf('o/r') }), 3);
});

test('isNoRunner: the recorded job GitHub cancelled with no runner and no step; not a job that ran or is waiting', () => {
  const row = ActionsJob.parse(noRunnerRow());
  assert.equal(row.runner_name, '');
  assert.equal(isNoRunner(row), true);
  assert.equal(isNoRunner({ ...row, conclusion: 'failure' }), true);
  assert.equal(isNoRunner({ ...row, runner_name: null, steps: null }), true);
  const step = { name: 'Set up job', status: 'completed', conclusion: 'cancelled', number: 1 };
  assert.equal(isNoRunner({ ...row, runner_name: 'GitHub Actions 7' }), false, 'a runner picked it up');
  assert.equal(isNoRunner({ ...row, steps: [step] }), false, 'a step ran, so there is a log');
  assert.equal(isNoRunner({ ...row, conclusion: 'skipped' }), false, 'skipped is not red');
  assert.equal(isNoRunner({ ...row, status: 'queued', conclusion: null }), false, 'still waiting');
});

test('countWorkflows: a missing repo is an error, never a silent 0 that would auto-pass CI_NO_CHECKS', async () => {
  const env = ciEnv();
  env.fake.on(() => true, notFound());
  await assert.rejects(countWorkflows({ gh: env.gh, repo: repoOf('o/r') }));
});
