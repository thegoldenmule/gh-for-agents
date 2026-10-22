// The shared CI-summary composition's policy facts (src/pr/ci-summary.ts; 02 §8.2 rows 10b and 12):
// the workflow total comes from countWorkflows, and a run whose jobs cannot be read reaches the policy
// as keyStepsUnchecked, so KEY_STEP_SKIPPED fails closed (04, key steps).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CiSnapshot } from '../../../src/ci/snapshot.ts';
import { buildCiSummary, type CiSummaryConfig } from '../../../src/pr/ci-summary.ts';
import type { Check } from '../../../src/schemas/ci.ts';
import { ciEnv, httpReply, ok, repoOf } from '../ci/_helpers.ts';

const REPO = repoOf('o/r');
const HEAD = 'a'.repeat(40);
const RUN = 500;

const check = (o: Partial<Check> = {}): Check => ({
  name: 'unit',
  workflow: 'CI',
  kind: 'actions',
  bucket: 'pass',
  status: 'completed',
  conclusion: 'success',
  required: false,
  runId: RUN,
  jobId: 5001,
  attempt: null,
  url: `https://github.com/o/r/actions/runs/${RUN}/job/5001`,
  startedAt: '2026-10-22T10:00:00Z',
  completedAt: '2026-10-22T10:05:00Z',
  ...o,
});

function snapshot(checks: Check[]): CiSnapshot {
  return {
    repo: REPO,
    number: 7,
    prState: 'OPEN',
    headSha: HEAD,
    headRef: 'feat/x',
    baseRef: 'main',
    defaultBranch: 'main',
    forHeadSha: true,
    checks,
    ignored: [],
    runs: {},
    truncated: false,
    queries: 1,
  };
}

const forbidden = () => ({
  exitCode: 1,
  stdout: httpReply('HTTP/2.0 403 Forbidden', '{"message":"Resource not accessible by integration"}'),
  stderr: 'gh: Resource not accessible by integration (HTTP 403)\n',
});

const path = (argv: readonly string[]) => argv.find((a) => a.startsWith('repos/'))?.split('?')[0];

async function facts(checks: Check[], config: Partial<CiSummaryConfig>, env = ciEnv()) {
  const r = await buildCiSummary({
    gh: env.gh,
    artifacts: env.artifacts,
    clock: env.clock,
    repo: REPO,
    ref: 'o/r#7',
    number: 7,
    base: 'main',
    ci: snapshot(checks),
    config: { ignore: [], ...config },
    compareMain: false,
    warn: env.warn,
  });
  return { ...r, env };
}

test('ci.keySteps with a run whose jobs cannot be read: keyStepsUnchecked carries the run id', async () => {
  const env = ciEnv();
  env.fake.on((a) => path(a) === `repos/o/r/actions/runs/${RUN}/jobs`, forbidden());
  const r = await facts([check()], { keySteps: ['Run tests'] }, env);
  assert.deepEqual(r.facts.keyStepsUnchecked, [RUN]);
  assert.deepEqual(r.facts.keyStepsSkipped, []);
  assert.ok(env.warnings.some((w) => w.code === 'KEY_STEPS_UNCHECKED'));
});

test('ci.keySteps with readable jobs: a skipped key step is reported, nothing unchecked', async () => {
  const env = ciEnv();
  env.fake.on(
    (a) => path(a) === `repos/o/r/actions/runs/${RUN}/jobs`,
    ok({
      total_count: 1,
      jobs: [
        {
          id: 5001,
          run_id: RUN,
          run_attempt: 1,
          name: 'unit',
          status: 'completed',
          conclusion: 'success',
          created_at: '2026-10-22T10:00:00Z',
          started_at: '2026-10-22T10:00:00Z',
          completed_at: '2026-10-22T10:05:00Z',
          html_url: `https://github.com/o/r/actions/runs/${RUN}/job/5001`,
          workflow_name: 'CI',
          head_sha: HEAD,
          runner_id: 1,
          runner_name: 'r1',
          steps: [{ name: 'Run tests', status: 'completed', conclusion: 'skipped', number: 2 }],
        },
      ],
    }),
  );
  const r = await facts([check()], { keySteps: ['Run tests'] }, env);
  assert.deepEqual(r.facts.keyStepsSkipped, [{ job: 'unit', step: 'Run tests' }]);
  assert.deepEqual(r.facts.keyStepsUnchecked, []);
});

test('no checks: workflowsTotal comes from countWorkflows (actions/workflows, per_page 1)', async () => {
  const env = ciEnv();
  env.fake.on((a) => path(a) === 'repos/o/r/actions/workflows', ok({ total_count: 0, workflows: [] }));
  const r = await facts([], {}, env);
  assert.equal(r.summary.state, 'no-checks');
  assert.equal(r.facts.workflowsTotal, 0);
  const call = env.fake.calls.find((c) => path(c.argv) === 'repos/o/r/actions/workflows');
  assert.ok(
    call?.argv.some((a) => a.includes('per_page=1')),
    call?.argv.join(' '),
  );
});

test('no checks and an unreadable workflow list: workflowsTotal null with CI_DETAIL_UNAVAILABLE', async () => {
  const env = ciEnv();
  env.fake.on((a) => path(a) === 'repos/o/r/actions/workflows', forbidden());
  const r = await facts([], {}, env);
  assert.equal(r.facts.workflowsTotal, null);
  assert.ok(env.warnings.some((w) => w.code === 'CI_DETAIL_UNAVAILABLE'));
});

test('checks reported: no workflow-list call', async () => {
  const env = ciEnv();
  const r = await facts([check()], {}, env);
  assert.equal(r.facts.workflowsTotal, null);
  assert.ok(!env.fake.calls.some((c) => path(c.argv) === 'repos/o/r/actions/workflows'));
});
