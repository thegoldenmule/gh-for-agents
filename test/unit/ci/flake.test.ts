import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMainComparer } from '../../../src/ci/compare-main.ts';
import {
  assessFlake,
  detectInfraError,
  detectIntermittent,
  type FlakeJob,
  matchKnownFlaky,
  scoreFlake,
} from '../../../src/ci/flake.ts';
import { Flake } from '../../../src/schemas/ci.ts';
import { ciEnv, ok, repoOf } from './_helpers.ts';
import { analyzeRecorded, corpusLog } from './logs/_recorded.ts';

const repo = repoOf('o/r');
const SHA = 'c'.repeat(40);
const job: FlakeJob = { name: 'test', jobId: 70, runId: 700, attempt: 1, headSha: SHA, workflowId: 5 };

const run = (id: number, conclusion: string, o: Record<string, unknown> = {}) => ({
  id,
  head_sha: `${String(id % 10).repeat(40)}`,
  event: 'push',
  status: 'completed',
  conclusion,
  workflow_id: 5,
  created_at: '2026-10-22T09:00:00Z',
  ...o,
});
const rjob = (id: number, name: string, conclusion: string) => ({
  id,
  run_id: 1,
  name,
  status: 'completed',
  conclusion,
  head_sha: SHA,
  steps: [{ name: 'Run tests', status: 'completed', conclusion, number: 3 }],
});

test('score table: high, medium, none; candidate is medium or higher', () => {
  const sig = (kind: Flake['signals'][number]['kind']) => ({ kind, detail: 'x' });
  assert.deepEqual(scoreFlake([]), { candidate: false, score: 'none', signals: [] });
  assert.equal(scoreFlake([sig('same-sha-passed')]).score, 'high');
  assert.equal(scoreFlake([sig('infra-error')]).score, 'high');
  assert.equal(scoreFlake([sig('main-intermittent')]).score, 'medium');
  assert.equal(scoreFlake([sig('known-flaky')]).score, 'medium');
  assert.equal(scoreFlake([sig('known-flaky'), sig('infra-error')]).score, 'high');
  assert.equal(scoreFlake([sig('known-flaky')]).candidate, true);
  Flake.parse(scoreFlake([sig('main-intermittent')]));
});

test('infra-error patterns: ECONNRESET, 429 Too Many Requests, No space left on device, runner shutdown', () => {
  const s = detectInfraError(corpusLog('infra-econnreset.log'));
  assert.equal(s?.kind, 'infra-error');
  assert.match(s?.detail ?? '', /^ECONNRESET: .*ECONNRESET/);
  for (const line of [
    'toomanyrequests: 429 Too Many Requests - Server message: You have reached your pull rate limit.',
    "System.IO.IOException: No space left on device : '/home/runner/runners/2.337.0/_diag/Worker.log'",
    '##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped.',
    'The self-hosted runner: r1 lost communication with the server.',
  ]) {
    assert.equal(detectInfraError(['ok', line])?.kind, 'infra-error', line);
  }
  assert.equal(detectInfraError(['AssertionError: expected 3 to equal 4']), null);
  assert.equal(detectInfraError(['Error: Docker pull failed (rate)'], ['Docker pull failed'])?.kind, 'infra-error');
});

test('infra-error on a real log: the undici ECONNRESET failure scores high', async () => {
  const a = await analyzeRecorded('node-test');
  const s = detectInfraError(a.lines);
  assert.equal(s?.kind, 'infra-error');
  assert.equal(scoreFlake([s].filter((x) => x !== null)).candidate, true);
});

test('known-flaky: job wildcard, optional test wildcard', () => {
  assert.equal(matchKnownFlaky('e2e (ubuntu)', [], [{ job: 'e2e*' }])?.kind, 'known-flaky');
  const t = matchKnownFlaky('test', ['src/a.test.ts > net > retries'], [{ job: 'test', test: '*net > retries' }]);
  assert.match(t?.detail ?? '', /src\/a\.test\.ts > net > retries/);
  assert.equal(matchKnownFlaky('test', ['src/a.test.ts > adds'], [{ job: 'test', test: '*retries' }]), null);
  assert.equal(matchKnownFlaky('lint', [], [{ job: 'test' }]), null);
});

test('main-intermittent: fail→pass→fail or pass→fail→pass interleaves; a single change does not', () => {
  const h = (...xs: ['pass' | 'fail' | 'unknown', string[]?][]) =>
    xs.map(([outcome, tests = []], i) => ({ runId: 100 + i, outcome, tests }));
  assert.equal(detectIntermittent(['T'], h(['fail', ['T']], ['pass'], ['fail', ['T']]))?.kind, 'main-intermittent');
  assert.equal(detectIntermittent(['T'], h(['pass'], ['fail', ['T']], ['pass']))?.kind, 'main-intermittent');
  // One change only: a test that was fixed, or newly broke.
  assert.equal(detectIntermittent(['T'], h(['fail', ['T']], ['pass'], ['pass'])), null);
  assert.equal(detectIntermittent(['T'], h(['pass'], ['pass'], ['fail', ['T']])), null);
  // A main failure in another test says nothing about T.
  assert.equal(detectIntermittent(['T'], h(['pass'], ['fail', ['U']], ['pass'])), null);
  assert.equal(detectIntermittent([], h(['pass'], ['fail', ['T']], ['pass'])), null);
});

test('same-sha-passed: the job passed on an earlier attempt of the same run', async () => {
  const env = ciEnv();
  env.fake.on(
    (a) => a.some((x) => x.startsWith('repos/o/r/actions/runs/700/attempts/1/jobs')),
    ok({ total_count: 1, jobs: [rjob(69, 'test', 'success')] }),
  );
  const f = await assessFlake({ gh: env.gh, repo, job: { ...job, attempt: 2 }, tests: ['T'], lines: [] });
  assert.equal(f.score, 'high');
  assert.deepEqual(f.signals, [{ kind: 'same-sha-passed', detail: 'test passed on attempt 1 of run 700' }]);
  env.fake.expectNoMutations();
});

test('same-sha-passed: the job passed in another run of the workflow on the same commit', async () => {
  const env = ciEnv();
  env.fake.on(
    (a) => a.some((x) => x.startsWith(`repos/o/r/actions/runs?head_sha=${SHA}`)),
    ok({
      total_count: 3,
      workflow_runs: [
        run(700, 'failure'),
        run(701, 'success', { event: 'pull_request' }),
        run(702, 'success', { workflow_id: 9 }),
      ],
    }),
  );
  env.fake.on(
    (a) => a.some((x) => x.startsWith('repos/o/r/actions/runs/701/jobs')),
    ok({ total_count: 1, jobs: [rjob(71, 'test', 'success')] }),
  );
  const f = await assessFlake({ gh: env.gh, repo, job, tests: ['T'], lines: [] });
  assert.equal(f.score, 'high');
  assert.match(f.signals[0]?.detail ?? '', /passed in run 701 \(pull_request\) on the same commit c{7}/);
  env.fake.expectNoCall((a) => a.some((x) => x.includes('/runs/702/')));
});

test('main-intermittent end to end: parsed main failures interleave with passing runs (≤5 parsed)', async () => {
  const env = ciEnv();
  env.fake.on(
    (a) => a.some((x) => x.startsWith(`repos/o/r/actions/runs?head_sha=`)),
    ok({ total_count: 0, workflow_runs: [] }),
  );
  // Newest first: fail(T), success, fail(T), success.
  env.fake.on(
    (a) => a.some((x) => x.startsWith('repos/o/r/actions/workflows/5/runs?')),
    ok({
      total_count: 4,
      workflow_runs: [run(904, 'failure'), run(903, 'success'), run(902, 'failure'), run(901, 'success')],
    }),
  );
  for (const id of [902, 904]) {
    env.fake.on(
      (a) => a.some((x) => x.startsWith(`repos/o/r/actions/runs/${id}/jobs`)),
      ok({ total_count: 1, jobs: [rjob(id * 10, 'test', 'failure')] }),
    );
    env.fake.on((a) => a.includes(`repos/o/r/actions/jobs/${id * 10}/logs`), {
      exitCode: 0,
      stdout: 'HTTP/1.1 200 OK\r\n\r\n--- FAIL: TestFlaky (0.00s)\n',
      stderr: '',
    });
  }
  const comparer = createMainComparer({
    gh: env.gh,
    artifacts: env.artifacts,
    clock: env.clock,
    repo,
    defaultBranch: 'main',
    prHeadSha: SHA,
  });
  const f = await assessFlake({
    gh: env.gh,
    repo,
    job,
    tests: ['TestFlaky'],
    lines: [],
    main: { comparer, defaultBranch: 'main' },
  });
  assert.equal(f.score, 'medium');
  assert.equal(f.candidate, true);
  assert.equal(f.signals[0]?.kind, 'main-intermittent');
  assert.match(f.signals[0]?.detail ?? '', /TestFlaky failed in 2 of the last 4 main runs/);
  // Successful runs need no jobs call; failed runs need one jobs call and one log each.
  env.fake.expectNoCall((a) => a.some((x) => /\/runs\/90[13]\/jobs/.test(x)));
  env.fake.expectNoMutations();
});

test('no signal: none, not a candidate; gh checks are skipped once the score is high', async () => {
  const env = ciEnv();
  env.fake.on(
    (a) => a.some((x) => x.startsWith('repos/o/r/actions/runs?head_sha=')),
    ok({ total_count: 0, workflow_runs: [] }),
  );
  const f = await assessFlake({ gh: env.gh, repo, job, tests: ['T'], lines: ['AssertionError: nope'] });
  assert.deepEqual(f, { candidate: false, score: 'none', signals: [] });
  const env2 = ciEnv();
  const high = await assessFlake({
    gh: env2.gh,
    repo,
    job,
    tests: [],
    lines: ['read ECONNRESET'],
    knownFlaky: [{ job: 'test' }],
  });
  assert.equal(high.score, 'high');
  assert.deepEqual(
    high.signals.map((s) => s.kind),
    ['infra-error', 'known-flaky'],
  );
  assert.equal(env2.fake.calls.length, 0);
});
