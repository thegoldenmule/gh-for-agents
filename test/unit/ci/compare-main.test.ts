import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  compareVerdict,
  createMainComparer,
  type FailingJobFacts,
  failingJobFacts,
  notCompared,
} from '../../../src/ci/compare-main.ts';
import { SameOnMain } from '../../../src/schemas/ci.ts';
import { GH_FIXTURE_ROOT } from '../../helpers/fixture-match.ts';
import { ciEnv, httpReply, ok, repoOf } from './_helpers.ts';

const repo = repoOf('o/r');
const PR_HEAD = 'a'.repeat(40);
const MAIN_SHA = 'b'.repeat(40);

const run = (id: number, head_sha: string) => ({
  id,
  head_sha,
  head_branch: 'main',
  event: 'push',
  status: 'completed',
  conclusion: 'failure',
  workflow_id: 5,
  path: '.github/workflows/ci.yml',
  run_attempt: 1,
  created_at: '2026-10-22T09:00:00Z',
  run_started_at: '2026-10-22T09:00:05Z',
});

const job = (id: number, name: string, conclusion: string, failingStep = 'Run pnpm test') => ({
  id,
  run_id: 900,
  run_attempt: 1,
  name,
  status: 'completed',
  conclusion,
  head_sha: MAIN_SHA,
  steps: [
    { name: 'Set up job', status: 'completed', conclusion: 'success', number: 1 },
    { name: failingStep, status: 'completed', conclusion, number: 4 },
  ],
});

/** A raw log body as the jobs-logs endpoint returns it (headers are stripped by apiText). */
const logReply = (body: string) => ({
  exitCode: 0,
  stdout: `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n\ufeff${body}`,
  stderr: '',
});

function setup(
  o: {
    runs?: unknown[];
    jobs?: unknown[];
    logs?: Record<
      number,
      ReturnType<typeof logReply> | { exitCode: number; stdout: string; stderr: string; stdoutFile: string }
    >;
  } = {},
) {
  const env = ciEnv();
  env.fake.on(
    (a) => a.some((x) => x.startsWith('repos/o/r/actions/workflows/5/runs?')),
    ok({ total_count: 1, workflow_runs: o.runs ?? [run(900, MAIN_SHA)] }),
  );
  env.fake.on(
    (a) => a.some((x) => x.startsWith('repos/o/r/actions/runs/900/jobs')),
    ok({ total_count: 1, jobs: o.jobs ?? [] }),
  );
  for (const [id, reply] of Object.entries(o.logs ?? {})) {
    env.fake.on((a) => a.includes(`repos/o/r/actions/jobs/${id}/logs`), reply);
  }
  const comparer = createMainComparer({
    gh: env.gh,
    artifacts: env.artifacts,
    clock: env.clock,
    repo,
    defaultBranch: 'main',
    prHeadSha: PR_HEAD,
    warn: env.warn,
  });
  return { env, comparer };
}

const prJob = (tests: string[], step: string | null = 'Run pnpm test'): FailingJobFacts => ({
  name: 'test',
  runId: 700,
  workflowId: 5,
  tests,
  step: step ? { number: 4, name: step } : null,
  logParsed: true,
});

test('a job-name match with different tests is different (a job-name match alone never counts)', async () => {
  // Main's same-named job failed in a different test (the recorded react jest log).
  const jestLog = join(GH_FIXTURE_ROOT, 'logs', 'jest-fail', '002-logs.log');
  const { comparer, env } = setup({
    jobs: [job(901, 'test', 'failure')],
    logs: { 901: { exitCode: 0, stdout: '', stderr: '', stdoutFile: jestLog } },
  });
  const s = await comparer.compare(prJob(['sum › adds']));
  assert.equal(s.verdict, 'different');
  assert.deepEqual(s.mainTests, ['ReactFlightDOMEdge › can pass a large typed array from two places']);
  assert.deepEqual(s.newTests, ['sum › adds']);
  assert.equal(s.mainRunId, 900);
  assert.equal(s.mainSha, MAIN_SHA);
  assert.equal(s.mainRunAt, '2026-10-22T09:00:05Z');
  SameOnMain.parse(s);
  env.fake.expectNoMutations();
});

test('empty PR tests with equal failing steps is same-step', async () => {
  const { comparer } = setup({
    jobs: [job(902, 'test', 'failure', 'Run pnpm install')],
    logs: { 902: logReply('2026-10-22T09:00:06.0Z ERR_PNPM_OUTDATED_LOCKFILE Cannot install\n') },
  });
  const s = await comparer.compare(prJob([], 'Run pnpm install'));
  assert.equal(s.verdict, 'same-step');
  const other = setup({
    jobs: [job(902, 'test', 'failure', 'Run pnpm install')],
    logs: { 902: logReply('2026-10-22T09:00:06.0Z boom\n') },
  });
  assert.equal((await other.comparer.compare(prJob([], 'Run lint'))).verdict, 'different');
});

test("a PR test set that is a strict subset of main's is same-tests", async () => {
  const { comparer } = setup({
    jobs: [job(903, 'test', 'failure')],
    logs: {
      903: logReply(
        ['--- FAIL: TestParse (0.00s)', '--- FAIL: TestOther (0.00s)', 'FAIL\tgithub.com/acme/x\t0.01s'].join('\n'),
      ),
    },
  });
  const s = await comparer.compare(prJob(['TestOther']));
  assert.equal(s.verdict, 'same-tests');
  assert.deepEqual(s.mainTests, ['TestParse', 'TestOther']);
  assert.deepEqual(s.newTests, []);
});

test('no completed main run (or only one at the PR head) is no-main-run', async () => {
  const none = setup({ runs: [] });
  const a = await none.comparer.compare(prJob(['x']));
  assert.equal(a.verdict, 'no-main-run');
  assert.equal(a.mainRunId, null);
  SameOnMain.parse(a);
  const sameHead = setup({ runs: [run(900, PR_HEAD)] });
  assert.equal((await sameHead.comparer.compare(prJob(['x']))).verdict, 'no-main-run');
});

test('a stacked PR (base feature-x) compares against the default branch, not its base', async () => {
  const { comparer, env } = setup({ jobs: [job(904, 'test', 'success')] });
  const s = await comparer.compare(prJob(['x']));
  assert.equal(s.verdict, 'main-green');
  assert.equal(s.mainBranch, 'main');
  const listCall = env.fake.calls.find((c) => c.argv.some((x) => x.includes('/actions/workflows/5/runs?')));
  assert.ok(listCall?.argv.some((x) => x.includes('branch=main&event=push&status=completed')));
  assert.ok(!listCall?.argv.some((x) => x.includes('feature-x')));
});

test('a main run without the same-named job is different; the workflow id comes from the run when unknown', async () => {
  const { comparer, env } = setup({ jobs: [job(905, 'lint', 'failure')] });
  env.fake.on((a) => a.includes('repos/o/r/actions/runs/700'), ok(run(700, PR_HEAD)));
  const s = await comparer.compare({ ...prJob(['x']), workflowId: null });
  assert.equal(s.verdict, 'different');
  env.fake.expectCalls([{ prefix: ['api', '--include', '-X', 'GET', 'repos/o/r/actions/runs/700'] }]);
});

test('main lookups are shared across jobs; parsed main tests are cached on disk by job id', async () => {
  const body = logReply('--- FAIL: TestA (0.00s)\n');
  const { comparer, env } = setup({
    jobs: [job(906, 'test', 'failure'), job(907, 'test2', 'failure')],
    logs: { 906: body, 907: body },
  });
  await comparer.compare(prJob(['TestA']));
  await comparer.compare({ ...prJob(['TestA']), name: 'test2' });
  const lists = env.fake.calls.filter((c) => c.argv.some((x) => x.includes('/workflows/5/runs?')));
  assert.equal(lists.length, 1);
  const jobsCalls = env.fake.calls.filter((c) => c.argv.some((x) => x.includes('/runs/900/jobs')));
  assert.equal(jobsCalls.length, 1);
  // A second comparer over the same artifact root reuses both the main-run lookup and the parsed tests.
  const again = createMainComparer({
    gh: env.gh,
    artifacts: env.artifacts,
    clock: env.clock,
    repo,
    defaultBranch: 'main',
    prHeadSha: PR_HEAD,
  });
  const before = env.fake.calls.length;
  assert.equal((await again.compare(prJob(['TestA']))).verdict, 'same-tests');
  const after = env.fake.calls.slice(before);
  assert.ok(!after.some((c) => c.argv.some((x) => x.endsWith('/logs'))), 'no log refetch');
  assert.ok(!after.some((c) => c.argv.some((x) => x.includes('/workflows/5/runs?'))), 'main run cached (TTL)');
  // After the TTL the main run is looked up again; the test list never expires.
  await env.clock.advance(6 * 60_000);
  const third = createMainComparer({
    gh: env.gh,
    artifacts: env.artifacts,
    clock: env.clock,
    repo,
    defaultBranch: 'main',
    prHeadSha: PR_HEAD,
  });
  const mark = env.fake.calls.length;
  await third.compare(prJob(['TestA']));
  const later = env.fake.calls.slice(mark);
  assert.ok(later.some((c) => c.argv.some((x) => x.includes('/workflows/5/runs?'))));
  assert.ok(!later.some((c) => c.argv.some((x) => x.endsWith('/logs'))));
});

test('an expired main log degrades to different with a warning, and is not cached', async () => {
  const gone = {
    exitCode: 1,
    stdout: httpReply('HTTP/2.0 410 Gone', ''),
    stderr: 'gh: Server Error (HTTP 410)\n',
  };
  const { comparer, env } = setup({ jobs: [job(908, 'test', 'failure')], logs: { 908: gone } });
  const s = await comparer.compare(prJob(['TestA']));
  assert.equal(s.verdict, 'different');
  assert.deepEqual(
    env.warnings.map((w) => w.code),
    ['LOGS_UNAVAILABLE'],
  );
});

test('compareVerdict: cancelled main job is different; notCompared is the inert value', () => {
  const runRef = { id: 1, head_sha: MAIN_SHA, created_at: '2026-10-22T09:00:00Z', run_started_at: null };
  assert.equal(
    compareVerdict(
      { tests: ['a'], step: null },
      { run: runRef, job: { conclusion: 'cancelled', tests: [], step: null } },
      'main',
    ).verdict,
    'different',
  );
  assert.equal(
    compareVerdict(
      { tests: [], step: null },
      { run: runRef, job: { conclusion: 'failure', tests: [], step: null } },
      'main',
    ).verdict,
    'different',
  );
  const nc = notCompared('trunk');
  assert.equal(nc.verdict, 'not-compared');
  SameOnMain.parse(nc);
  const many = Array.from({ length: 40 }, (_, i) => `t${i}`);
  const capped = compareVerdict(
    { tests: many, step: null },
    { run: runRef, job: { conclusion: 'failure', tests: many, step: null } },
    'main',
  );
  assert.equal(capped.verdict, 'same-tests');
  SameOnMain.parse(capped);
});

test('same-step needs a parsed log on both sides: a missing PR or main log is different', async () => {
  const lockfile = logReply('2026-10-22T09:00:06.0Z ERR_PNPM_OUTDATED_LOCKFILE Cannot install\n');
  const pr = setup({ jobs: [job(910, 'test', 'failure', 'Run pnpm install')], logs: { 910: lockfile } });
  assert.equal(
    (await pr.comparer.compare({ ...prJob([], 'Run pnpm install'), logParsed: false })).verdict,
    'different',
  );
  const unknown = setup({ jobs: [job(911, 'test', 'failure', 'Run pnpm install')], logs: { 911: lockfile } });
  const { logParsed: _omit, ...noFlag } = prJob([], 'Run pnpm install');
  assert.equal((await unknown.comparer.compare(noFlag)).verdict, 'different', 'unknown counts as not parsed');
  const notReady = { exitCode: 1, stdout: httpReply('HTTP/2.0 410 Gone', ''), stderr: 'gh: Server Error (HTTP 410)\n' };
  const main = setup({ jobs: [job(912, 'test', 'failure', 'Run pnpm install')], logs: { 912: notReady } });
  assert.equal((await main.comparer.compare(prJob([], 'Run pnpm install'))).verdict, 'different');
  const runRef = { id: 1, head_sha: MAIN_SHA, created_at: '2026-10-22T09:00:00Z', run_started_at: null };
  const step = { number: 4, name: 'Run pnpm install' };
  assert.equal(
    compareVerdict(
      { tests: [], step, logParsed: true },
      { run: runRef, job: { conclusion: 'failure', tests: [], step } },
      'main',
    ).verdict,
    'different',
  );
  assert.equal(
    compareVerdict(
      { tests: [], step, logParsed: true },
      { run: runRef, job: { conclusion: 'failure', tests: [], step, logParsed: true } },
      'main',
    ).verdict,
    'same-step',
  );
});

test('a truncated PR test list is never same-tests', () => {
  const runRef = { id: 1, head_sha: MAIN_SHA, created_at: '2026-10-22T09:00:00Z', run_started_at: null };
  const thirty = Array.from({ length: 30 }, (_, i) => `t${i}`);
  const main = { run: runRef, job: { conclusion: 'failure', tests: thirty, step: null, logParsed: true } };
  assert.equal(compareVerdict({ tests: thirty, step: null, testsTruncated: true }, main, 'main').verdict, 'different');
  assert.equal(
    compareVerdict({ tests: thirty, step: null }, main, 'main').verdict,
    'different',
    'exactly the cap: maybe cut',
  );
  assert.equal(
    compareVerdict({ tests: thirty, step: null, testsTruncated: false }, main, 'main').verdict,
    'same-tests',
  );
  assert.equal(compareVerdict({ tests: ['t1'], step: null }, main, 'main').verdict, 'same-tests');
});

test('failingJobFacts carries logParsed and testsTruncated from a JobAnalysis', () => {
  const a = {
    job: job(920, 'test', 'failure') as never,
    tests: [],
    step: { number: 4, name: 'Run pnpm test' },
    logPath: null,
    testsTruncated: false,
  };
  assert.deepEqual(failingJobFacts(a, 5), {
    name: 'test',
    runId: 900,
    workflowId: 5,
    tests: [],
    step: { number: 4, name: 'Run pnpm test' },
    testsTruncated: false,
    logParsed: false,
  });
  assert.equal(failingJobFacts({ ...a, logPath: '/x.log' }).logParsed, true);
});
