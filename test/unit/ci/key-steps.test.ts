// Key steps (src/ci/key-steps.ts, 02 §12 `suspicious`, §8.2 row 12): the one implementation behind ci why's
// `suspicious` and the merge policy's KEY_STEP_SKIPPED facts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActionsJob } from '../../../src/ci/github.ts';
import { findSuspicious, keyStepSkipped } from '../../../src/ci/key-steps.ts';
import { ciEnv, notFound, ok, repoOf } from './_helpers.ts';

const SHA = 'a'.repeat(40);

function job(id: number, name: string, conclusion: string, step: { name: string; conclusion: string }): ActionsJob {
  return {
    id,
    run_id: 500,
    name,
    status: 'completed',
    conclusion,
    workflow_name: 'CI',
    head_sha: SHA,
    steps: [{ number: 1, status: 'completed', ...step }],
  };
}

const JOBS = [
  job(1, 'test', 'success', { name: 'Run tests', conclusion: 'skipped' }),
  job(2, 'lint', 'failure', { name: 'Run tests', conclusion: 'skipped' }),
  job(3, 'build', 'success', { name: 'Run tests', conclusion: 'success' }),
];

test('keyStepSkipped finds a skipped key step only in a green job', () => {
  assert.deepEqual(keyStepSkipped(JOBS, ['Run tests']), [
    { workflow: 'CI', job: 'test', jobId: 1, step: 'Run tests', reason: 'key-step-skipped' },
  ]);
  assert.deepEqual(keyStepSkipped(JOBS, []), []);
});

test('findSuspicious lists the runs whose jobs could not be read in `unchecked`, and stays an array', async () => {
  const env = ciEnv();
  env.fake.on((a) => a.some((x) => x.includes('actions/runs/500/jobs')), ok({ total_count: 3, jobs: JOBS }));
  env.fake.on((a) => a.some((x) => x.includes('actions/runs/501/jobs')), notFound());
  const r = await findSuspicious({
    gh: env.gh,
    repo: repoOf('o/r'),
    runIds: [500, 501],
    keySteps: ['Run tests'],
    warn: env.warn,
  });
  assert.deepEqual(r.unchecked, [501]);
  assert.deepEqual(
    r.suspicious.map((s) => s.job),
    ['test'],
  );
  assert.deepEqual(
    [...r].map((s) => s.job),
    ['test'],
  );
  assert.ok(env.warnings.some((w) => w.code === 'KEY_STEPS_UNCHECKED'));
});
