import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { type ActionsJob, ActionsStep, failingStep, fetchJob } from '../../../../src/ci/github.ts';
import { fetchJobLog } from '../../../../src/ci/logs/fetch.ts';
import { attributeSteps, segmentLines, spansFor } from '../../../../src/ci/logs/steps.ts';
import { ciEnv, repoOf } from '../_helpers.ts';

const step = (number: number, name: string, conclusion: string, started: string | null, completed: string | null) =>
  ActionsStep.parse({ number, name, status: 'completed', conclusion, started_at: started, completed_at: completed });

/** Fetch a recorded runner job + log, attribute steps, and return the failing step's lines. */
async function recorded(runner: string, slug: string, jobId: number) {
  const env = ciEnv(`logs/${runner}-fail`);
  const repo = repoOf(slug);
  const job: ActionsJob = await fetchJob({ gh: env.gh, repo, jobId });
  const r = await fetchJobLog({ gh: env.gh, artifacts: env.artifacts, repo, jobId });
  assert.ok(r.ok);
  const steps = job.steps ?? [];
  const failing = failingStep(steps);
  assert.ok(failing);
  const spans = attributeSteps(r.log.segments, steps, failing);
  const lines = readFileSync(r.log.path, 'utf8').split('\n');
  const own = spansFor(spans, failing.number).flatMap((s) => lines.slice(s.startLine, s.endLine + 1));
  return { failing, spans, own, lines };
}

test('vitest log: the failing step is named from the API and owns the FAIL lines', async () => {
  const { failing, own } = await recorded('vitest', 'vitest-dev/vitest', 119784717653);
  assert.deepEqual(failing, { number: 8, name: 'Test E2E' });
  assert.ok(own.some((l) => l.includes(' FAIL ') && l.includes('updates accepted snapshots')));
  assert.ok(own.some((l) => l.startsWith('##[error]Process completed with exit code')));
});

test('jest log: a named step (header differs from the API name) is still attributed', async () => {
  const { failing, own, spans } = await recorded('jest', 'facebook/react', 119620576517);
  assert.equal(failing.number, 9);
  assert.ok(own.some((l) => l.includes('● ReactFlightDOMEdge › can pass a large typed array from two places')));
  // Set up job comes first; the post steps come after the failing step.
  assert.equal(spans[0]?.name, 'Set up job');
  assert.ok(spans.findIndex((s) => s.number === 9) < spans.length - 1);
});

test('pytest, go and node:test logs: the failure output lands in the failing step', async () => {
  const py = await recorded('pytest', 'pytest-dev/pytest', 118816259139);
  assert.equal(py.failing.name, 'Test with coverage');
  assert.ok(
    py.own.some((l) => l.includes('FAILED') && l.includes('test_multiple_file_args_do_not_rescan_parent_directory')),
  );
  const go = await recorded('go', 'grpc/grpc-go', 119722003331);
  assert.equal(go.failing.name, 'Run tests');
  assert.ok(go.own.some((l) => l.includes('--- FAIL: Test/BidirectionalDraining_ContinuousStreaming')));
  const nt = await recorded('node-test', 'nodejs/undici', 118006467479);
  assert.equal(nt.failing.name, 'Test unit');
  assert.ok(nt.own.some((l) => l.includes('✖ Should handle http2 stream timeout')));
});

test('no step headers at all: the whole log is attributed to the failing step from the API', () => {
  const segs = segmentLines(['compiling', 'error: boom', '##[error]Process completed with exit code 1.']);
  const spans = attributeSteps(segs, [step(1, 'Set up job', 'success', null, null)], { number: 4, name: 'Build' });
  assert.deepEqual(spans, [{ number: 4, name: 'Build', startLine: 0, endLine: 2 }]);
});

test('timestamps map segments to steps; skipped steps own nothing; end-action lines are tolerated', () => {
  const lines = [
    'Current runner version',
    '##[group]Run actions/checkout@v4',
    'Syncing repository',
    '##[endgroup]',
    '##[end-action id=__actions_checkout;outcome=success;conclusion=success;duration_ms=900]',
    '##[group]Run pnpm test',
    ' FAIL  src/a.test.ts > adds',
    '##[error]Process completed with exit code 1.',
    '##[end-action id=__run;outcome=failure;conclusion=failure;duration_ms=4000]',
    'Post job cleanup.',
    'git version 2.55.0',
    'Cleaning up orphan processes',
  ];
  const ts = [
    '2026-10-21T10:00:00.1Z',
    '2026-10-21T10:00:01.2Z',
    '2026-10-21T10:00:01.5Z',
    '2026-10-21T10:00:02.0Z',
    '2026-10-21T10:00:02.1Z',
    '2026-10-21T10:00:03.1Z',
    '2026-10-21T10:00:06.0Z',
    '2026-10-21T10:00:07.0Z',
    '2026-10-21T10:00:07.1Z',
    '2026-10-21T10:00:08.3Z',
    '2026-10-21T10:00:08.5Z',
    '2026-10-21T10:00:09.2Z',
  ];
  const steps = [
    step(1, 'Set up job', 'success', '2026-10-21T10:00:00Z', '2026-10-21T10:00:01Z'),
    step(2, 'Checkout', 'success', '2026-10-21T10:00:01Z', '2026-10-21T10:00:02Z'),
    step(3, 'Setup pnpm', 'skipped', '2026-10-21T10:00:03Z', '2026-10-21T10:00:03Z'),
    step(4, 'Test', 'failure', '2026-10-21T10:00:03Z', '2026-10-21T10:00:07Z'),
    step(5, 'Post Checkout', 'success', '2026-10-21T10:00:08Z', '2026-10-21T10:00:08Z'),
    step(6, 'Complete job', 'success', '2026-10-21T10:00:09Z', '2026-10-21T10:00:09Z'),
  ];
  const spans = attributeSteps(segmentLines(lines, ts), steps, failingStep(steps));
  assert.deepEqual(
    spans.map((s) => [s.number, s.startLine, s.endLine]),
    [
      [1, 0, 0],
      [2, 1, 4],
      [4, 5, 8],
      [5, 9, 10],
      [6, 11, 11],
    ],
  );
  assert.ok(!spans.some((s) => s.name.includes('UNKNOWN')));
});

test('a composite action (nested Run groups) stays inside its outer step by timestamp', () => {
  const lines = [
    'setup',
    '##[group]Run ./.github/actions/setup',
    '##[group]Run pnpm install',
    'installed',
    '##[group]Run pnpm test',
    'FAIL',
  ];
  const ts = ['10:00:00.1', '10:00:01.1', '10:00:02.1', '10:00:20.0', '10:00:21.0', '10:00:25.0'].map(
    (t) => `2026-10-21T${t}Z`,
  );
  const steps = [
    step(1, 'Set up job', 'success', '2026-10-21T10:00:00Z', '2026-10-21T10:00:01Z'),
    step(2, 'Setup', 'success', '2026-10-21T10:00:01Z', '2026-10-21T10:00:20Z'),
    step(3, 'Run pnpm test', 'failure', '2026-10-21T10:00:21Z', '2026-10-21T10:00:25Z'),
  ];
  const spans = attributeSteps(segmentLines(lines, ts), steps);
  assert.deepEqual(
    spans.map((s) => [s.number, s.startLine, s.endLine]),
    [
      [1, 0, 0],
      [2, 1, 3],
      [3, 4, 5],
    ],
  );
});

test('without timestamps, segments map to executed steps in order', () => {
  const lines = ['runner', '##[group]Run checkout', 'ok', '##[group]Run make', 'boom'];
  const steps = [
    step(1, 'Set up job', 'success', null, null),
    step(2, 'Run checkout', 'success', null, null),
    step(3, 'Lint', 'skipped', null, null),
    step(4, 'Run make', 'failure', null, null),
  ];
  const spans = attributeSteps(segmentLines(lines), steps);
  assert.deepEqual(
    spans.map((s) => [s.number, s.startLine]),
    [
      [1, 0],
      [2, 1],
      [4, 3],
    ],
  );
});
