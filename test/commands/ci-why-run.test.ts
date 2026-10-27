// ghx ci why run:<id> | --run <id|url> | branch:<name> (02 §12; 03 M3.2): CI without a PR.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT } from '../contract/exit-table.ts';
import { FakeGh } from '../helpers/fake-gh.ts';
import { install, notFoundJson, okJson, sha, vitestLog, type WJob, type World, why } from './ci-why-world.ts';

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
  assert.equal(r.json.target, `run:${RUN}`);
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
  assert.ok(r.json.next.includes(`ghx ci why run:${RUN} -R o/run --job '<name>'`), r.json.next.join('\n'));
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

test('run:<id> is the positional form of --run; a pending run suggests ci wait run:<id>', async () => {
  const jobs: WJob[] = [red[1] as WJob, { id: 3, runId: RUN, name: 'e2e', conclusion: null, status: 'in_progress' }];
  const r = await why(world(jobs), [`run:${RUN}`, '-R', 'o/run'], noPr);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.target, `run:${RUN}`);
  assert.deepEqual(r.json.next, [`ghx ci wait run:${RUN} -R o/run`]);
});

test('a bare branch name is USAGE_BAD_SELECTOR whose hint names branch:<name>', async () => {
  const r = await why(world(red), ['main', '-R', 'o/run'], noPr);
  assert.equal(r.exitCode, EXIT.USAGE);
  assert.equal(r.json.error.code, 'USAGE_BAD_SELECTOR');
  assert.match(r.json.error.hint, /ci why branch:main/);
});

// --- branch:<name>: every workflow's newest run on the branch head ---

const H = sha('a');
const run = (id: number, wf: number, conclusion: string | null): Record<string, unknown> => ({
  id,
  head_sha: H,
  head_branch: 'main',
  event: 'push',
  status: conclusion === null ? 'in_progress' : 'completed',
  conclusion,
  workflow_id: wf,
  path: `.github/workflows/w${wf}.yml`,
  run_attempt: 1,
  created_at: '2026-10-22T10:59:00Z',
});

function mainWorld(): { w: World; fake: FakeGh } {
  const jobs: WJob[] = [
    {
      id: 51,
      runId: 501,
      name: 'unit',
      workflowId: 5,
      conclusion: 'failure',
      headSha: H,
      log: { text: vitestLog(['src/u.test.ts > u']) },
    },
    { id: 52, runId: 501, name: 'lint', workflowId: 5, conclusion: 'success', headSha: H },
    {
      id: 61,
      runId: 601,
      name: 'e2e',
      workflow: 'E2E',
      workflowId: 6,
      conclusion: 'failure',
      headSha: H,
      log: { text: vitestLog(['e2e/x.test.ts > x']) },
    },
    // An older run of workflow 5 on the same commit (re-triggered): superseded by 501.
    {
      id: 41,
      runId: 401,
      name: 'unit',
      workflowId: 5,
      conclusion: 'failure',
      headSha: H,
      log: { text: vitestLog(['old']) },
    },
  ];
  const w = world([], {
    otherJobs: jobs,
    shaRuns: [run(401, 5, 'failure'), run(501, 5, 'failure'), run(601, 6, 'failure')],
  });
  const fake = install(new FakeGh(), w);
  fake.on(
    (a) => a.some((x) => x.split('?')[0] === 'repos/o/run/branches/main'),
    okJson({ name: 'main', commit: { sha: H } }),
  );
  return { w, fake };
}

test('branch:main diagnoses every failing workflow on the head commit, the newest run of each', async () => {
  const { w, fake } = mainWorld();
  const r = await why(w, ['branch:main', '-R', 'o/run'], { ...noPr, fake });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.ref, null);
  assert.equal(r.json.target, `branch:main@${H.slice(0, 7)}`);
  assert.equal(r.json.headSha, H);
  assert.equal(r.json.ci.state, 'red');
  assert.deepEqual(r.json.failing.map((f: { job: string; runId: number }) => `${f.job}@${f.runId}`).sort(), [
    'e2e@601',
    'unit@501',
  ]);
  const q = fake.calls.flatMap((c) => c.argv).find((a) => a.startsWith('repos/o/run/actions/runs?'));
  assert.ok(q, 'read the runs on the head');
  assert.match(q, new RegExp(`head_sha=${H}`));
  assert.match(q, /branch=main/);
  r.fake.expectNoMutations();
});

test('branch:<name>@<sha> reads that commit, not the branch head', async () => {
  const { w, fake } = mainWorld();
  fake.on((a) => a.some((x) => x.split('?')[0] === `repos/o/run/commits/${H.slice(0, 7)}`), okJson({ sha: H }));
  const r = await why(w, [`branch:main@${H.slice(0, 7)}`, '-R', 'o/run'], { ...noPr, fake });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.headSha, H);
  fake.expectNoCall((a) => a.some((x) => x.startsWith('repos/o/run/branches/')));
});

test('a branch that does not exist is REF_NOT_FOUND, exit 5', async () => {
  const { w, fake } = mainWorld();
  fake.on((a) => a.some((x) => x.split('?')[0] === 'repos/o/run/branches/nope'), notFoundJson());
  const r = await why(w, ['branch:nope', '-R', 'o/run'], { ...noPr, fake });
  assert.equal(r.exitCode, EXIT.NOT_FOUND, r.stdout);
  assert.equal(r.json.error.code, 'REF_NOT_FOUND');
});
