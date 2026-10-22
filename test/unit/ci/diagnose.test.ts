// The diagnosis engine (src/ci/diagnose.ts): budget and partial results, the job cap and order,
// per-stage degradation, and the compact/event forms ci wait uses.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVerdict } from '../../../src/ci/compare-main.ts';
import {
  clipExcerpt,
  compactDiagnosis,
  comparisonFacts,
  createDiagnoser,
  diagnosisOrder,
  eventDiagnosis,
  isDiagnosable,
  skeletonJob,
} from '../../../src/ci/diagnose.ts';
import { type Check, CI_CAPS, CompactDiagnosis, DiagnosisJob, type FailingJob } from '../../../src/schemas/ci.ts';
import { install, logReply, sha, vitestLog, type WJob, type World } from '../../commands/ci-why-world.ts';
import { ciEnv, repoOf } from './_helpers.ts';

const HEAD = sha('a');

const check = (j: WJob, o: Partial<Check> = {}): Check => ({
  name: j.name,
  workflow: 'CI',
  kind: 'actions',
  bucket: 'fail',
  status: 'completed',
  conclusion: 'failure',
  required: j.required === true,
  runId: j.runId,
  jobId: j.id,
  attempt: null,
  url: `https://github.com/o/r/actions/runs/${j.runId}/job/${j.id}`,
  startedAt: null,
  completedAt: null,
  ...o,
});

const job = (id: number, tests: string[], o: Partial<WJob> = {}): WJob => ({
  id,
  runId: 500,
  name: `job ${id}`,
  conclusion: 'failure',
  log: { text: vitestLog(tests) },
  ...o,
});

function setup(jobs: WJob[], o: Partial<World> = {}) {
  const env = ciEnv();
  install(env.fake, { slug: 'o/r', number: 1, headSha: HEAD, jobs, ...o });
  const diagnoser = createDiagnoser({
    gh: env.gh,
    artifacts: env.artifacts,
    clock: env.clock,
    repo: repoOf('o/r'),
    headSha: HEAD,
    defaultBranch: 'main',
    warn: env.warn,
  });
  return { env, diagnoser };
}

/** Real-time wait until `count()` stops changing (in-flight fs work settles). */
async function quiesce(count: () => number): Promise<void> {
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 250 && stable < 5; i++) {
    await new Promise((r) => setTimeout(r, 10));
    const n = count();
    stable = n === last ? stable + 1 : 0;
    last = n;
  }
}

test('isDiagnosable: red Actions checks with job and run ids only', () => {
  const j = job(1, []);
  assert.equal(isDiagnosable(check(j)), true);
  assert.equal(isDiagnosable(check(j, { bucket: 'cancelled' })), true);
  assert.equal(isDiagnosable(check(j, { bucket: 'pass' })), false);
  assert.equal(isDiagnosable(check(j, { kind: 'status', jobId: null, runId: null })), false);
  assert.equal(isDiagnosable(check(j, { jobId: null })), false);
});

test('diagnosisOrder puts required checks first and otherwise keeps order', () => {
  const xs = [
    { required: false, n: 1 },
    { required: true, n: 2 },
    { required: false, n: 3 },
    { required: true, n: 4 },
  ];
  assert.deepEqual(
    diagnosisOrder(xs).map((x) => x.n),
    [2, 4, 1, 3],
  );
});

test('diagnose: every job complete within the budget, partial false, omitted counted past maxJobs', async () => {
  const jobs = [1, 2, 3].map((id) => job(id, [`src/t${id}.test.ts > fails`]));
  const { diagnoser } = setup(jobs);
  const d = await diagnoser.diagnose(
    jobs.map((j) => check(j)),
    { maxJobs: 2 },
  );
  assert.equal(d.partial, false);
  assert.equal(d.omitted, 1);
  assert.deepEqual(
    d.jobs.map((j) => j.tests),
    [['src/t1.test.ts > fails'], ['src/t2.test.ts > fails']],
  );
  assert.equal(d.jobs[0]?.step?.name, 'Run tests');
  assert.equal(d.jobs[0]?.sameOnMain.verdict, 'no-main-run');
});

test('diagnose: a log slower than the budget gives partial true; the fast job is whole, the slow one a skeleton', async () => {
  const fast = job(1, ['src/fast.test.ts > a']);
  const slow = job(2, ['src/slow.test.ts > b']);
  const { env, diagnoser } = setup([fast, slow]);
  env.fake.on((a) => a.includes('repos/o/r/actions/jobs/2/logs'), {
    ...logReply({ text: vitestLog(['src/slow.test.ts > b']) }),
    delayMs: 120_000,
  });
  let done = false;
  const p = diagnoser.diagnose([check(fast), check(slow)], { budgetMs: 60_000 }).finally(() => {
    done = true;
  });
  // The fast job's log is streamed through real fs I/O, which FakeClock does not drive: let it land.
  await quiesce(() => env.fake.calls.length);
  await env.clock.advance(59_000);
  assert.equal(done, false, 'still within the budget');
  await env.clock.advance(2_000);
  const d = await p;
  assert.equal(d.partial, true);
  assert.deepEqual(d.jobs[0]?.tests, ['src/fast.test.ts > a']);
  assert.deepEqual(d.jobs[1]?.tests, []);
  assert.equal(d.jobs[1]?.logPath, null);
  assert.equal(d.jobs[1]?.sameOnMain.verdict, 'not-compared');
  assert.ok(env.warnings.some((w) => w.code === 'DIAGNOSIS_PARTIAL'));
  // The slow stage finishing later does not change the returned result.
  await env.clock.advance(120_000);
  assert.deepEqual(d.jobs[1]?.tests, []);
});

test('diagnose: a log that is not ready yet degrades to logPath null with LOGS_NOT_READY, not an error', async () => {
  const j = job(1, [], { log: 'not-ready' });
  const { env, diagnoser } = setup([j]);
  const d = await diagnoser.diagnose([check(j)]);
  assert.equal(d.partial, false);
  assert.equal(d.jobs[0]?.logPath, null);
  assert.ok(env.warnings.some((w) => w.code === 'LOGS_NOT_READY' && w.message.startsWith('job 1: ')));
});

test('diagnose: a job the jobs API cannot find degrades with DIAGNOSIS_INCOMPLETE; other jobs are unaffected', async () => {
  const ok = job(1, ['src/a.test.ts > a']);
  const { log: _none, ...gone } = job(2, []);
  const { env, diagnoser } = setup([ok]);
  const d = await diagnoser.diagnose([check(ok), check(gone)]);
  assert.deepEqual(d.jobs[0]?.tests, ['src/a.test.ts > a']);
  assert.deepEqual(d.jobs[1], skeletonJob(check(gone) as Check & { jobId: number; runId: number }, 'main'));
  assert.ok(env.warnings.some((w) => w.code === 'DIAGNOSIS_INCOMPLETE' && w.message.startsWith('job 2: ')));
});

test('job(): one job with no budget, for ci wait', async () => {
  const j = job(1, ['src/a.test.ts > a']);
  const { diagnoser } = setup([j]);
  const f = await diagnoser.job(check(j));
  assert.deepEqual(f.tests, ['src/a.test.ts > a']);
  await assert.rejects(diagnoser.job(check(j, { bucket: 'pass' })));
});

const big: FailingJob = {
  workflow: 'CI',
  job: 'test',
  jobId: 1,
  runId: 2,
  attempt: 1,
  url: 'https://github.com/o/r/actions/runs/2/job/1',
  conclusion: 'failure',
  required: false,
  step: { number: 4, name: 'Run tests' },
  tests: Array.from({ length: 30 }, (_, i) => `t${i}`),
  errors: Array.from({ length: 20 }, (_, i) => `Error: e${i}`),
  exitLine: 'Process completed with exit code 1.',
  excerpt: Array.from({ length: 60 }, (_, i) => `line ${i} ${'x'.repeat(20)}`)
    .join('\n')
    .slice(0, 2000),
  logPath: '/tmp/job-1.log',
  logBytes: 10,
  sameOnMain: {
    verdict: 'different',
    mainBranch: 'main',
    mainRunId: null,
    mainSha: null,
    mainRunAt: null,
    prTests: [],
    mainTests: [],
    newTests: [],
  },
  flake: { candidate: false, score: 'none', signals: [] },
};

test('eventDiagnosis cuts to the event caps (≤10 tests, ≤5 errors, ≤10 lines and 1,500 chars)', () => {
  const e = DiagnosisJob.parse(eventDiagnosis(big));
  assert.equal(e.tests.length, CI_CAPS.eventTests);
  assert.equal(e.errors.length, CI_CAPS.eventErrors);
  assert.equal(e.excerpt.split('\n').length, CI_CAPS.eventExcerptLines);
  assert.ok(e.excerpt.startsWith('line 0 '));
  assert.ok(Buffer.byteLength(JSON.stringify(e)) < 4096, 'a diagnosis event fits in 4 KB');
});

test('compactDiagnosis: ≤5 tests, the first error (else the exit line), verdict and score', () => {
  const c = CompactDiagnosis.parse(compactDiagnosis(big));
  assert.equal(c.tests.length, CI_CAPS.compactTests);
  assert.equal(c.firstError, 'Error: e0');
  assert.equal(c.step, 'Run tests');
  assert.equal(c.sameOnMain, 'different');
  assert.equal(c.flake, 'none');
  assert.equal(compactDiagnosis({ ...big, errors: [] }).firstError, 'Process completed with exit code 1.');
  assert.equal(compactDiagnosis({ ...big, errors: [], exitLine: null, step: null }).firstError, null);
});

test('clipExcerpt keeps whole lines from the top within both limits', () => {
  assert.equal(clipExcerpt('a\nb\nc', 2, 100), 'a\nb');
  assert.equal(clipExcerpt('aaaa\nbbbb', 5, 6), 'aaaa');
  assert.equal(clipExcerpt('', 5, 6), '');
});

test('comparisonFacts: a log cut by the 8 MB cap marks the tests truncated, so they never prove same-tests', () => {
  const analysis = {
    job: { name: 'test', run_id: 500 } as never,
    tests: ['src/a.test.ts > a'],
    testsTruncated: false,
    step: { number: 2, name: 'Run tests' },
    logPath: '/tmp/job-1.log',
    warnings: [] as { code: 'LOG_TRUNCATED'; message: string }[],
  };
  assert.equal(comparisonFacts(analysis, 5).testsTruncated, false);
  assert.equal(comparisonFacts(analysis, 5).logParsed, true);
  const cut = comparisonFacts({ ...analysis, warnings: [{ code: 'LOG_TRUNCATED', message: 'cut' }] }, 5);
  assert.equal(cut.testsTruncated, true);
  const main = {
    run: { id: 9, head_sha: sha('d'), created_at: '2026-10-22T09:00:00Z' },
    job: { conclusion: 'failure', tests: ['src/a.test.ts > a', 'b'], step: null, logParsed: true },
  };
  assert.equal(compareVerdict(comparisonFacts(analysis, 5), main, 'main').verdict, 'same-tests');
  assert.equal(compareVerdict(cut, main, 'main').verdict, 'different');
});
