// ghx ci why <pr> (02 §12; 03 M3.1), in-process over the fake GitHub in ci-why-world.ts.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { FailingJob } from '../../src/schemas/ci.ts';
import { EXIT } from '../contract/exit-table.ts';
import { FakeGh } from '../helpers/fake-gh.ts';
import {
  httpReply,
  install,
  mainRun,
  okJson,
  recordedJob,
  sha,
  vitestLog,
  type WJob,
  type World,
  why,
} from './ci-why-world.ts';

const passing = (id: number, name: string): WJob => ({ id, runId: 500, name, conclusion: 'success' });

const failing = (id: number, name: string, tests: string[], o: Partial<WJob> = {}): WJob => ({
  id,
  runId: 500,
  name,
  conclusion: 'failure',
  log: { text: vitestLog(tests) },
  ...o,
});

test('red-vitest: the failing job, its step from the jobs API, the test, the log on disk; no run view', async () => {
  const job = recordedJob('vitest');
  const r = await why({
    slug: 'vitest-dev/vitest',
    number: 9001,
    headSha: 'b10cd584c28c1c145bcc4a47afe65357999cd46a',
    jobs: [job, { ...passing(119784717000, 'lint'), runId: job.runId }],
  });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.ref, 'vitest-dev/vitest#9001');
  assert.equal(r.json.ci.state, 'red');
  assert.equal(r.json.failing.length, 1);
  const f = FailingJob.parse(r.json.failing[0]);
  assert.equal(f.job, 'Test: vite@7, e2e, node-24, ubuntu-latest');
  assert.deepEqual(f.step, { number: 8, name: 'Test E2E' });
  assert.ok(f.tests.includes('test/watch/snapshot-review.test.ts > updates accepted snapshots'), f.tests.join('\n'));
  assert.equal(f.exitLine, 'Process completed with exit code 1.');
  assert.ok(f.excerpt.length > 0 && f.excerpt.length <= 2000);
  assert.ok(f.logPath && existsSync(f.logPath), 'logPath exists');
  assert.equal(f.sameOnMain.verdict, 'no-main-run');
  assert.equal(f.flake.score, 'none');
  assert.equal(r.json.omitted, 0);
  assert.deepEqual(r.json.nonActionsFailing, []);
  r.fake.expectNoCall({ prefix: ['run', 'view'] });
  r.fake.expectNoMutations();
});

test('red-shared: the PR test also fails on the latest main push run, so sameOnMain is same-tests', async () => {
  const t = 'src/a.test.ts > sums';
  const r = await why({
    slug: 'o/shared',
    number: 7,
    headSha: sha('a'),
    jobs: [failing(101, 'test', [t])],
    mainRuns: { 5: [mainRun(900, 'failure')] },
    otherJobs: [failing(901, 'test', [t, 'src/b.test.ts > other'], { runId: 900, headSha: sha('d') })],
  });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const f = r.json.failing[0];
  assert.equal(f.sameOnMain.verdict, 'same-tests');
  assert.equal(f.sameOnMain.mainRunId, 900);
  assert.deepEqual(f.sameOnMain.newTests, []);
  assert.equal(r.json.warnings, undefined, 'compare and flake both read the main log without a race');
});

test('green: failing is empty, exit 0, and no job or log is fetched', async () => {
  const r = await why({
    slug: 'o/green',
    number: 1,
    headSha: sha('a'),
    jobs: [passing(1, 'test'), passing(2, 'lint')],
  });
  assert.equal(r.exitCode, EXIT.OK);
  assert.equal(r.json.ci.state, 'green');
  assert.deepEqual(r.json.failing, []);
  assert.deepEqual(r.json.next, []);
  assert.equal(
    r.fake.calls.filter((c) => c.argv.some((a) => a.includes('/actions/'))).length,
    0,
    'no Actions REST call',
  );
});

test('external-status-fail: a red commit status lands in nonActionsFailing, not in failing', async () => {
  const r = await why({
    slug: 'o/ext',
    number: 2,
    headSha: sha('a'),
    jobs: [passing(1, 'test')],
    statuses: [{ context: 'ci/circleci: build', state: 'FAILURE', targetUrl: 'https://circleci.com/x/1' }],
  });
  assert.equal(r.exitCode, EXIT.OK);
  assert.deepEqual(r.json.failing, []);
  assert.equal(r.json.nonActionsFailing.length, 1);
  assert.equal(r.json.nonActionsFailing[0].name, 'ci/circleci: build');
  assert.equal(r.json.nonActionsFailing[0].kind, 'status');
});

const six = (): WJob[] => [
  ...Array.from({ length: 5 }, (_, i) => failing(10 + i, `shard ${i + 1}`, [`src/s${i}.test.ts > t`])),
  failing(20, 'required-e2e', ['e2e/a.test.ts > flows'], { required: true }),
];

test('six-failing: 5 are diagnosed (required first), omitted is 1, and next suggests --job', async () => {
  const r = await why({ slug: 'o/six', number: 3, headSha: sha('a'), jobs: six() });
  assert.equal(r.exitCode, EXIT.OK);
  assert.equal(r.json.failing.length, 5);
  assert.equal(r.json.omitted, 1);
  assert.equal(r.json.failing[0].job, 'required-e2e');
  assert.ok(r.json.next.some((n: string) => n.startsWith('ghx ci why o/six#3 --job')));
});

test('--max-jobs 2 diagnoses two and omits four', async () => {
  const r = await why({ slug: 'o/six2', number: 3, headSha: sha('a'), jobs: six() }, ['--max-jobs', '2']);
  assert.equal(r.json.failing.length, 2);
  assert.equal(r.json.omitted, 4);
  const logCalls = r.fake.calls.filter((c) => c.argv.some((a) => a.endsWith('/logs')));
  assert.equal(logCalls.length, 2, 'only the diagnosed jobs have their logs fetched');
});

test('--max-jobs above 5 is a usage error', async () => {
  const r = await why({ slug: 'o/six3', number: 3, headSha: sha('a'), jobs: six() }, ['--max-jobs', '6']);
  assert.equal(r.exitCode, EXIT.USAGE);
  assert.equal(r.json.error.code, 'VALIDATION');
});

test('--job glob: only matching failing jobs are diagnosed; names with slashes match too', async () => {
  const jobs = [
    failing(1, 'test / unit (shard 1/2)', ['src/a.test.ts > a']),
    failing(2, 'test / unit (shard 2/2)', ['src/b.test.ts > b']),
    failing(3, 'lint', ['x.ts > y']),
  ];
  const r = await why({ slug: 'o/glob', number: 4, headSha: sha('a'), jobs }, ['--job', 'test / unit (shard 2*']);
  assert.deepEqual(
    r.json.failing.map((f: { job: string }) => f.job),
    ['test / unit (shard 2/2)'],
  );
  assert.equal(r.json.omitted, 0);
  const r2 = await why({ slug: 'o/glob2', number: 4, headSha: sha('a'), jobs }, ['--job', 'lint', '--job', '*1/2)']);
  assert.deepEqual(r2.json.failing.map((f: { job: string }) => f.job).sort(), ['lint', 'test / unit (shard 1/2)']);
});

test('--no-compare-main: sameOnMain is not-compared and no main run is listed', async () => {
  const r = await why(
    {
      slug: 'o/nocmp',
      number: 5,
      headSha: sha('a'),
      jobs: [failing(1, 'test', ['src/a.test.ts > a'])],
      mainRuns: { 5: [mainRun(900, 'failure')] },
    },
    ['--no-compare-main'],
  );
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.failing[0].sameOnMain.verdict, 'not-compared');
  r.fake.expectNoCall((a) => a.some((x) => x.includes('/actions/workflows/')));
});

test('a failing comparison degrades to not-compared with DIAGNOSIS_INCOMPLETE; the rest of the job stands', async () => {
  const fake = new FakeGh();
  const world: World = {
    slug: 'o/cmpfail',
    number: 6,
    headSha: sha('a'),
    jobs: [failing(1, 'test', ['src/a.test.ts > a'])],
  };
  install(fake, world);
  fake.on((a) => a.some((x) => x.startsWith('repos/o/cmpfail/actions/workflows/5/runs')), {
    exitCode: 1,
    stdout: httpReply('HTTP/2.0 403 Forbidden', '{"message":"Resource not accessible by integration"}'),
    stderr: 'gh: Resource not accessible by integration (HTTP 403)\n',
  });
  const r = await why(world, [], { fake });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const f = r.json.failing[0];
  assert.deepEqual(f.tests, ['src/a.test.ts > a']);
  assert.equal(f.sameOnMain.verdict, 'not-compared');
  assert.ok(
    r.json.warnings.some((w: { code: string }) => w.code === 'DIAGNOSIS_INCOMPLETE'),
    JSON.stringify(r.json.warnings),
  );
});

test('a flaky candidate (infra error in the log) puts ci rerun --flaky in next', async () => {
  const r = await why({
    slug: 'o/flaky',
    number: 8,
    headSha: sha('a'),
    jobs: [failing(1, 'test', [], { log: { text: vitestLog([], { extra: ['Error: read ECONNRESET'] }) } })],
  });
  assert.equal(r.json.failing[0].flake.score, 'high');
  assert.ok(r.json.next.includes('ghx ci rerun o/flaky#8 --flaky'));
});

test('a PR that does not exist is PR_NOT_FOUND, exit 5', async () => {
  const fake = new FakeGh();
  install(fake, { slug: 'o/missing', number: 404, headSha: sha('a'), jobs: [] });
  fake.on(
    { prefix: ['api', 'graphql'] },
    okJson({ data: { repository: { defaultBranchRef: null, pullRequest: null } } }),
  );
  const r = await why({ slug: 'o/missing', number: 404, headSha: sha('a'), jobs: [] }, [], { fake });
  assert.equal(r.exitCode, EXIT.NOT_FOUND);
  assert.equal(r.json.error.code, 'PR_NOT_FOUND');
});

test('5 failing jobs with real runner logs at default caps stay under 16 KB (no spill)', async () => {
  const jobs = ['vitest', 'jest', 'node-test', 'pytest', 'go'].map((runner) => recordedJob(runner, { runId: 777 }));
  const r = await why({ slug: 'o/five', number: 9, headSha: sha('a'), jobs });
  assert.equal(r.exitCode, EXIT.OK, r.stdout.slice(0, 500));
  assert.equal(r.json.spilled, undefined, `spilled at ${r.json.bytes} bytes`);
  assert.equal(r.json.failing.length, 5);
  const bytes = Buffer.byteLength(r.stdout);
  assert.ok(bytes < 16 * 1024, `${bytes} bytes`);
  for (const f of r.json.failing) assert.ok(f.tests.length > 0 || f.errors.length > 0, `${f.job} has a diagnosis`);
});
