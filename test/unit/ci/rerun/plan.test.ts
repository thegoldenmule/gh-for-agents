// src/ci/rerun/plan.ts (02 §13.1; 03 M5.1): which runs ci rerun reruns, which it skips, the error when
// none is left (NO_FAILED_RUNS > RUN_IN_PROGRESS > RERUN_LIMIT), and the per-run targeting.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActionsRun } from '../../../../src/ci/github.ts';
import { parseCommandOverrides } from '../../../../src/ci/rerun/overrides.ts';
import {
  type ClassifyInput,
  classifyRuns,
  failingRunIds,
  nothingRerunnable,
  type RunGroup,
  selectJobs,
} from '../../../../src/ci/rerun/plan.ts';
import { GhxError } from '../../../../src/core/errors.ts';
import type { Check, Flake } from '../../../../src/schemas/ci.ts';

const H = 'a'.repeat(40);
const repo = { host: 'github.com', owner: 'o', name: 'r' };

function check(jobId: number, runId: number, bucket: Check['bucket'], name = `job${jobId}`): Check {
  return {
    name,
    workflow: `wf${runId}`,
    kind: 'actions',
    bucket,
    status: bucket === 'pending' ? 'in_progress' : 'completed',
    conclusion: bucket === 'fail' ? 'failure' : bucket === 'pass' ? 'success' : null,
    required: false,
    runId,
    jobId,
    attempt: 1,
    url: `https://github.com/o/r/actions/runs/${runId}/job/${jobId}`,
    startedAt: null,
    completedAt: null,
  };
}

function row(id: number, o: Partial<ActionsRun> = {}): ActionsRun {
  return {
    id,
    head_sha: H,
    event: 'pull_request',
    status: 'completed',
    conclusion: 'failure',
    workflow_id: 5,
    run_attempt: 1,
    created_at: '2026-10-22T10:00:00Z',
    ...o,
  };
}

const input = (checks: Check[], o: Partial<ClassifyInput> = {}): ClassifyInput => ({
  repo,
  ref: 'o/r#7',
  headSha: H,
  ciState: 'red',
  checks,
  jobPatterns: [],
  maxAttempts: 3,
  overrideLimit: false,
  ...o,
});

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof GhxError, String(e));
    return e.code;
  }
  return 'ok';
}

/** Rows: [name, checks, run rows, expected outcome]. */
const PRECEDENCE: [string, Check[], ActionsRun[], string][] = [
  ['no red check', [check(1, 10, 'pass')], [], 'NO_FAILED_RUNS'],
  [
    'a red status context only',
    [{ ...check(1, 10, 'fail'), kind: 'status', runId: null, jobId: null }],
    [],
    'NO_FAILED_RUNS',
  ],
  [
    'the only red run is for another commit',
    [check(1, 10, 'fail')],
    [row(10, { head_sha: 'b'.repeat(40) })],
    'NO_FAILED_RUNS',
  ],
  ['in progress', [check(1, 10, 'fail')], [row(10, { status: 'in_progress' })], 'RUN_IN_PROGRESS'],
  ['queued', [check(1, 10, 'fail')], [row(10, { status: 'queued' })], 'RUN_IN_PROGRESS'],
  ['at the limit', [check(1, 10, 'fail')], [row(10, { run_attempt: 3 })], 'RERUN_LIMIT'],
  ['past the limit', [check(1, 10, 'fail')], [row(10, { run_attempt: 4 })], 'RERUN_LIMIT'],
  [
    'in progress and at the limit: RUN_IN_PROGRESS wins',
    [check(1, 10, 'fail'), check(2, 20, 'fail')],
    [row(10, { run_attempt: 3 }), row(20, { status: 'in_progress' })],
    'RUN_IN_PROGRESS',
  ],
  [
    'in progress plus one rerunnable: no error',
    [check(1, 10, 'fail'), check(2, 20, 'cancelled')],
    [row(10, { status: 'in_progress' }), row(20, { conclusion: 'cancelled' })],
    'ok',
  ],
  ['attempt 2 of 3', [check(1, 10, 'fail')], [row(10, { run_attempt: 2 })], 'ok'],
];

for (const [name, checks, rows, want] of PRECEDENCE) {
  test(`precedence: ${name} → ${want}`, () => {
    const i = input(checks);
    const runs = new Map(rows.map((r) => [r.id, r]));
    assert.equal(
      codeOf(() => {
        failingRunIds(i);
        classifyRuns(i, runs);
      }),
      want,
    );
  });
}

test('the RERUN_LIMIT override lets a run at the limit through', () => {
  const r = classifyRuns(
    input([check(1, 10, 'fail')], { overrideLimit: true }),
    new Map([[10, row(10, { run_attempt: 5 })]]),
  );
  assert.equal(r.rerunnable[0]?.attempt, 5);
});

test('nothingRerunnable after the POSTs: a race (RUN_IN_PROGRESS) outranks a refusal, which is GH_FAILED', () => {
  const i = input([]);
  const refused = { runId: 10, workflow: 'CI', reason: 'REFUSED' as const, attempt: 1, message: 'nope' };
  const race = { runId: 20, workflow: 'CI', reason: 'RUN_IN_PROGRESS' as const, attempt: 1 };
  assert.equal(nothingRerunnable(i, [refused, race]).code, 'RUN_IN_PROGRESS');
  const e = nothingRerunnable(i, [refused]);
  assert.equal(e.code, 'GH_FAILED');
  assert.match(e.message, /nope/);
});

function group(red: Check[], matched = red): RunGroup {
  const r = red as RunGroup['red'];
  return { runId: 10, workflow: 'CI', attempt: 1, url: 'u', red: r, matched: matched as RunGroup['matched'] };
}

const flake = (candidate: boolean): Flake =>
  candidate
    ? { candidate, score: 'high', signals: [{ kind: 'infra-error', detail: 'ECONNRESET' }] }
    : { candidate, score: 'none', signals: [] };

test('targeting: no selection reruns the failed jobs of the run', () => {
  const s = selectJobs([group([check(1, 10, 'fail'), check(2, 10, 'fail')])], {
    ref: 'o/r#7',
    headSha: H,
    byJob: false,
    flake: null,
  });
  assert.equal(s.actions[0]?.method, 'failed-jobs');
  assert.deepEqual(s.widened, []);
});

test('targeting: --flaky with one candidate of two posts that job; two of three widens', () => {
  const [a, b, c] = [check(1, 10, 'fail'), check(2, 10, 'fail'), check(3, 10, 'fail')];
  const one = selectJobs([group([a, b] as Check[])], {
    ref: 'o/r#7',
    headSha: H,
    byJob: false,
    flake: new Map([
      [1, flake(true)],
      [2, flake(false)],
    ]),
  });
  assert.deepEqual([one.actions[0]?.method, one.actions[0]?.jobId], ['job', 1]);
  assert.deepEqual(
    one.actions[0]?.flake?.map((f) => f.job),
    ['job1'],
  );
  const two = selectJobs([group([a, b, c] as Check[])], {
    ref: 'o/r#7',
    headSha: H,
    byJob: false,
    flake: new Map([
      [1, flake(true)],
      [2, flake(true)],
    ]),
  });
  assert.equal(two.actions[0]?.method, 'failed-jobs');
  assert.deepEqual(two.widened, [{ runId: 10, selected: ['job1', 'job2'], extra: ['job3'] }]);
});

test('targeting: --flaky with no candidate anywhere is NO_FLAKY_CANDIDATES; an unassessed job is no candidate', () => {
  const g = group([check(1, 10, 'fail', 'Test Reactor')]);
  assert.equal(
    codeOf(() => selectJobs([g], { ref: 'o/r#7', headSha: H, byJob: false, flake: new Map() })),
    'NO_FLAKY_CANDIDATES',
  );
});

test('overrides: an allowed code with a reason; reason missing, too long or code not allowed is VALIDATION', () => {
  assert.deepEqual(parseCommandOverrides(['RERUN_LIMIT'], ' user asked ', ['RERUN_LIMIT']), {
    codes: ['RERUN_LIMIT'],
    reason: 'user asked',
  });
  assert.equal(parseCommandOverrides(undefined, 'x', ['RERUN_LIMIT']), null);
  for (const [codes, reason] of [
    [['RERUN_LIMIT'], undefined],
    [['RERUN_LIMIT'], 'x'.repeat(201)],
    [['RERUN_LIMIT'], 'a\nb'],
    [['AUTHOR_NOT_VIEWER'], 'x'],
  ] as const) {
    assert.equal(
      codeOf(() => parseCommandOverrides(codes, reason, ['RERUN_LIMIT'])),
      'VALIDATION',
      `${codes} ${reason}`,
    );
  }
});
