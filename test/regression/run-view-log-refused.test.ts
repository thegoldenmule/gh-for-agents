// R02 (03 §5.2). Guards: `gh run view --log` refuses while a run is in progress, 16 times in the corpus
// (research §0, §3.1). ci why reads a finished job's log from actions/jobs/{id}/logs, which works
// mid-run (spike 03 §3.3); `run view` is answered here with its refusal and must never be called.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { install, type LogSpec, recordedJob, type World, why } from '../commands/ci-why-world.ts';
import { EXIT } from '../contract/exit-table.ts';
import { FakeGh } from '../helpers/fake-gh.ts';

const REFUSAL = readFileSync(
  join(import.meta.dirname, '..', 'fixtures', 'gh-stderr', 'run-view-in-progress.txt'),
  'utf8',
);

/** vitest-dev/vitest run 39766938159: the e2e job has failed while a sibling job is still running. */
function midRun(log?: LogSpec): { world: World; fake: FakeGh } {
  const failed = recordedJob('vitest', log ? { log } : {});
  const world: World = {
    slug: 'vitest-dev/vitest',
    number: 9002,
    headSha: 'b10cd584c28c1c145bcc4a47afe65357999cd46a',
    jobs: [failed, { id: 119784717999, runId: failed.runId, name: 'Test: browser', conclusion: null }],
  };
  const fake = install(new FakeGh(), world);
  fake.on({ prefix: ['run', 'view'] }, { exitCode: 1, stdout: '', stderr: REFUSAL });
  return { world, fake };
}

const logCalls = (fake: FakeGh) =>
  fake.calls.filter((c) => c.argv.some((a) => a.endsWith('/actions/jobs/119784717653/logs')));

test('R02: mid-run, the failed job is diagnosed through the jobs-logs API and run view is never called', async () => {
  const { world, fake } = midRun();
  const r = await why(world, [], { fake });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.ci.state, 'red');
  assert.equal(r.json.ci.phase, 'running', 'the run is still in progress');
  const f = r.json.failing[0];
  assert.ok(f.tests.includes('test/watch/snapshot-review.test.ts > updates accepted snapshots'));
  assert.ok(f.logPath?.endsWith('job-119784717653.log'));
  assert.equal(logCalls(fake).length, 1);
  fake.expectNoCall({ prefix: ['run', 'view'] });
  fake.expectNoMutations();
});

test('R02 variant: the job is still running (blob 404): logPath null, warning LOGS_NOT_READY, exit 0', async () => {
  const { world, fake } = midRun('not-ready');
  const r = await why(world, [], { fake });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.failing[0].logPath, null);
  assert.deepEqual(r.json.failing[0].step, { number: 8, name: 'Test E2E' }, 'the step still comes from the jobs API');
  assert.ok(r.json.warnings.some((w: { code: string }) => w.code === 'LOGS_NOT_READY'));
  fake.expectNoCall({ prefix: ['run', 'view'] });
});

test('R02 variant: expired logs (410): warning LOGS_UNAVAILABLE, not GH_FAILED, and not retried', async () => {
  const { world, fake } = midRun('gone');
  const r = await why(world, [], { fake });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.error, undefined);
  assert.equal(r.json.failing[0].logPath, null);
  assert.ok(r.json.warnings.some((w: { code: string }) => w.code === 'LOGS_UNAVAILABLE'));
  assert.equal(logCalls(fake).length, 1, 'the 410 is not retried');
  fake.expectNoCall({ prefix: ['run', 'view'] });
});
