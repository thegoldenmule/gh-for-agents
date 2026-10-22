// R18 (03 §5.2). Guards: `gh run rerun --failed` was refused twice in the corpus (research §3.1):
// `cannot be rerun; This workflow is already running` and `job 111978835495 cannot be rerun`. ghx reads
// each run before posting and skips runs still in progress; a run that restarts between that read and the
// POST is answered by GitHub with 403 "This workflow is already running" (the API text behind gh's first
// message), which ci rerun reports as RUN_IN_PROGRESS rather than a failure. A job GitHub will not rerun
// (gh's second message) is a refusal: skipped as REFUSED, or GH_FAILED when nothing else was rerun.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { httpReply, install, sha, vitestLog, type WJob, type World } from '../commands/ci-why-world.ts';
import { EXIT } from '../contract/exit-table.ts';
import { FakeGh, type GhReply } from '../helpers/fake-gh.ts';
import { runInProcess, scratchDir } from '../helpers/harness.ts';

const SLUG = 'o/r';

const forbidden = (message: string): GhReply => ({
  exitCode: 1,
  stdout: httpReply(
    'HTTP/2.0 403 Forbidden',
    JSON.stringify({ message, documentation_url: 'https://docs.github.com/rest/actions/workflow-runs', status: '403' }),
  ),
  stderr: `gh: ${message} (HTTP 403)\n`,
});
const created: GhReply = { exitCode: 0, stdout: httpReply('HTTP/2.0 201 Created', '{}'), stderr: '' };

const job = (id: number, runId: number, name: string): WJob => ({
  id,
  runId,
  name,
  workflowId: runId,
  workflow: `wf${runId}`,
  conclusion: 'failure',
  log: { text: vitestLog([`src/${name}.test.ts > works`]) },
});

const pathOf = (argv: readonly string[]) => argv.find((a) => a.startsWith('repos/'))?.split('?')[0] ?? '';
const post = (suffix: string) => (a: string[]) => a.includes('POST') && pathOf(a).endsWith(suffix);

async function rerun(w: World, posts: [string, GhReply][], args: string[] = []) {
  const fake = install(new FakeGh(), w);
  for (const [suffix, reply] of posts) fake.on(post(suffix), reply);
  const r = await runInProcess(['ci', 'rerun', `${SLUG}#7`, ...args], {
    gh: fake,
    env: { GHX_ARTIFACT_DIR: mkdtempSync(join(scratchDir(), 'r18-')) },
  });
  return { ...r, fake };
}

const world = (jobs: WJob[]): World => ({ slug: SLUG, number: 7, headSha: sha('a'), jobs });

test('R18: "This workflow is already running" on the POST is RUN_IN_PROGRESS (exit 9), not GH_FAILED', async () => {
  const r = await rerun(world([job(101, 500, 'test')]), [
    ['runs/500/rerun-failed-jobs', forbidden('This workflow is already running')],
  ]);
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.equal(r.json.error.code, 'RUN_IN_PROGRESS');
  assert.deepEqual(r.json.error.details, { runs: [500] });
  assert.match(r.json.error.hint, /ghx ci wait o\/r#7 --until settled/);
});

test("R18: a run that raced is skipped with GitHub's message while another run is rerun", async () => {
  const r = await rerun(world([job(101, 500, 'test'), job(201, 600, 'build')]), [
    ['runs/500/rerun-failed-jobs', forbidden('This workflow is already running')],
    ['runs/600/rerun-failed-jobs', created],
  ]);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(
    r.json.rerun.map((x: { runId: number }) => x.runId),
    [600],
  );
  assert.deepEqual(r.json.skipped, [
    {
      runId: 500,
      workflow: 'wf500',
      reason: 'RUN_IN_PROGRESS',
      attempt: 1,
      message: 'This workflow is already running',
    },
  ]);
  assert.deepEqual(r.json.next, ['ghx ci wait o/r#7']);
});

test('R18: a job GitHub will not rerun is a refusal: GH_FAILED (exit 7) with its message when nothing was rerun', async () => {
  const r = await rerun(
    world([job(111978835495, 500, 'e2e'), job(102, 500, 'lint')]),
    [['jobs/111978835495/rerun', forbidden('job 111978835495 cannot be rerun')]],
    ['--job', 'e2e'],
  );
  assert.equal(r.exitCode, EXIT.GH_FAILED, r.stdout);
  assert.equal(r.json.error.code, 'GH_FAILED');
  assert.match(r.json.error.message, /job 111978835495 cannot be rerun/);
  assert.match(r.json.error.hint, /ghx ci why o\/r#7/);
  assert.deepEqual(r.json.error.details, { runs: [{ runId: 500, message: 'job 111978835495 cannot be rerun' }] });
});
