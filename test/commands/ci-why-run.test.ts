// ghx ci why --run <id|url> (02 §12; 03 M3.2): one workflow run, without a PR.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT } from '../contract/exit-table.ts';
import { FakeGh } from '../helpers/fake-gh.ts';
import { install, notFoundJson, sha, vitestLog, type WJob, type World, why } from './ci-why-world.ts';

const RUN = 37948190914;

const world = (jobs: WJob[], o: Partial<World> = {}): World => ({
  slug: 'o/run',
  number: 1,
  headSha: sha('e'),
  defaultBranch: 'trunk',
  jobs,
  ...o,
});

const red: WJob[] = [
  { id: 1, runId: RUN, name: 'test', conclusion: 'failure', log: { text: vitestLog(['src/a.test.ts > a']) } },
  { id: 2, runId: RUN, name: 'lint', conclusion: 'success' },
];

const noPr = { selector: false } as const;

test('--run <id> -R: the run head is diagnosed with ref null, and the default branch comes from the repo', async () => {
  const r = await why(world(red), ['--run', String(RUN), '-R', 'o/run'], noPr);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.ref, null);
  assert.equal(r.json.headSha, sha('e'));
  assert.equal(r.json.ci.state, 'red');
  assert.deepEqual(
    r.json.failing.map((f: { job: string }) => f.job),
    ['test'],
  );
  assert.deepEqual(r.json.failing[0].tests, ['src/a.test.ts > a']);
  assert.equal(r.json.failing[0].sameOnMain.mainBranch, 'trunk');
  assert.deepEqual(r.json.suspicious, []);
  r.fake.expectNoCall({ prefix: ['api', 'graphql'] });
  r.fake.expectNoCall({ prefix: ['run', 'view'] });
  r.fake.expectNoMutations();
});

test('--run <url>: the repo comes from the URL', async () => {
  const r = await why(world(red), ['--run', `https://github.com/o/run/actions/runs/${RUN}`], noPr);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.failing.length, 1);
});

test('a run or job URL in the PR slot means that run', async () => {
  const r = await why(world(red), [`https://github.com/o/run/actions/runs/${RUN}/job/1`], noPr);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.ref, null);
  assert.equal(r.json.failing[0].jobId, 1);
});

test('mid-run: a finished failed job is diagnosed while a sibling is still queued', async () => {
  const jobs: WJob[] = [red[0] as WJob, { id: 3, runId: RUN, name: 'e2e', conclusion: null, status: 'queued' }];
  const r = await why(world(jobs), ['--run', String(RUN), '-R', 'o/run'], noPr);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.ci.phase, 'running');
  assert.equal(r.json.ci.pending[0].name, 'e2e');
  assert.deepEqual(r.json.failing[0].tests, ['src/a.test.ts > a']);
});

test('omitted jobs suggest a --run follow-up with --job', async () => {
  const many: WJob[] = Array.from({ length: 3 }, (_, i) => ({
    id: 10 + i,
    runId: RUN,
    name: `shard ${i}`,
    conclusion: 'failure',
    log: { text: vitestLog([`src/s${i}.test.ts > t`]) },
  }));
  const r = await why(world(many), ['--run', String(RUN), '-R', 'o/run', '--max-jobs', '1'], noPr);
  assert.equal(r.json.omitted, 2);
  assert.ok(r.json.next.includes(`ghx ci why --run ${RUN} -R o/run --job '<name>'`), r.json.next.join('\n'));
});

test('a run that does not exist is RUN_NOT_FOUND, exit 5', async () => {
  const fake = install(new FakeGh(), world(red));
  fake.on((a) => a.includes(`repos/o/run/actions/runs/999`), notFoundJson());
  const r = await why(world(red), ['--run', '999', '-R', 'o/run'], { ...noPr, fake });
  assert.equal(r.exitCode, EXIT.NOT_FOUND);
  assert.equal(r.json.error.code, 'RUN_NOT_FOUND');
});

test('a PR and --run together are VALIDATION; neither is VALIDATION; a non-run --run is USAGE_BAD_SELECTOR', async () => {
  const both = await why(world(red), ['--run', String(RUN)]);
  assert.equal(both.exitCode, EXIT.USAGE);
  assert.equal(both.json.error.code, 'VALIDATION');
  const neither = await why(world(red), ['-R', 'o/run'], noPr);
  assert.equal(neither.exitCode, EXIT.USAGE);
  assert.equal(neither.json.error.code, 'VALIDATION');
  const bad = await why(world(red), ['--run', 'o/run#12'], noPr);
  assert.equal(bad.exitCode, EXIT.USAGE);
  assert.equal(bad.json.error.code, 'USAGE_BAD_SELECTOR');
});
