// Runs GitHub rejected before any job ran (02 §1.5): which runs count, the check they become, what is said.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normaliseContext } from '../../../src/ci/checks.ts';
import {
  invalidFromRun,
  invalidRunNext,
  invalidRunNode,
  invalidRunWarning,
  isInvalidRun,
  isInvalidRunCheck,
} from '../../../src/ci/invalid-runs.ts';
import { nextFor } from '../../../src/ci/wait/summary.ts';
import { repoOf } from './_helpers.ts';

const repo = repoOf('o/r');
const SHA = 'f'.repeat(40);

test('isInvalidRun: completed failure or startup_failure with no job, in any case', () => {
  assert.equal(isInvalidRun('completed', 'failure', 0), true);
  assert.equal(isInvalidRun('COMPLETED', 'STARTUP_FAILURE', 0), true);
  assert.equal(isInvalidRun('completed', 'failure', 1), false, 'a job ran: an ordinary red');
  assert.equal(isInvalidRun('completed', 'action_required', 0), false, 'awaiting approval');
  assert.equal(isInvalidRun('completed', 'cancelled', 0), false);
  assert.equal(isInvalidRun('queued', null, 0), false);
  assert.equal(isInvalidRun(null, 'failure', 0), false);
});

test('a REST run row (recorded run 40518894617) becomes a red Actions check with no job, named for its file', () => {
  const run = {
    id: 40518894617,
    name: '.github/workflows/ci.yml',
    path: '.github/workflows/ci.yml',
    html_url: 'https://github.com/o/r/actions/runs/40518894617',
    status: 'completed',
    conclusion: 'failure',
    workflow_id: 393121786,
    event: 'push',
    created_at: '2026-10-27T14:12:25Z',
  };
  const c = normaliseContext(invalidRunNode(invalidFromRun(run, repo)), { repo, headSha: SHA }).check;
  assert.deepEqual(c, {
    name: '.github/workflows/ci.yml',
    workflow: '.github/workflows/ci.yml',
    kind: 'actions',
    bucket: 'fail',
    status: 'completed',
    conclusion: 'failure',
    required: false,
    runId: 40518894617,
    jobId: null,
    attempt: null,
    url: 'https://github.com/o/r/actions/runs/40518894617',
    startedAt: '2026-10-27T14:12:25Z',
    completedAt: '2026-10-27T14:12:25Z',
  });
  assert.equal(isInvalidRunCheck(c), true);
  assert.equal(isInvalidRunCheck({ ...c, jobId: 1 }), false, 'a job is an ordinary check');
  assert.equal(isInvalidRunCheck({ ...c, kind: 'status', runId: null }), false);
});

test('a run row without html_url or path still names and links the run; a dynamic path loses its @ref', () => {
  const r = invalidFromRun(
    { id: 7, path: '.github/workflows/x.yml@refs/heads/main', conclusion: 'startup_failure', workflow_id: 3 },
    repo,
  );
  assert.equal(r.path, '.github/workflows/x.yml');
  assert.equal(r.url, 'https://github.com/o/r/actions/runs/7');
  assert.equal(r.conclusion, 'startup_failure');
});

test('the warning and next name the file and the run page, and never suggest a re-wait or rerun', () => {
  const c = {
    name: '.github/workflows/ci.yml',
    runId: 9,
    url: 'https://github.com/o/r/actions/runs/9',
    conclusion: 'failure',
  };
  const w = invalidRunWarning(c);
  assert.equal(w.code, 'WORKFLOW_INVALID');
  assert.match(w.message, /^GitHub rejected \.github\/workflows\/ci\.yml before any job ran \(run 9 concluded failure/);
  assert.match(w.message, /API returns no error text.*https:\/\/github\.com\/o\/r\/actions\/runs\/9$/);
  const next = invalidRunNext([c]);
  assert.deepEqual(next, [
    'Fix .github/workflows/ci.yml: GitHub rejected it before any job ran. Read the error on https://github.com/o/r/actions/runs/9, then commit and push.',
  ]);
  const base = { prRef: 'o/r#7', headSha: SHA, settled: false, flaky: true, identical: 'ghx ci wait o/r#7' };
  assert.deepEqual(nextFor({ ...base, outcome: 'red', workflowInvalid: next }), next);
  assert.deepEqual(nextFor({ ...base, outcome: 'red' }), ['ghx ci rerun o/r#7 --flaky', 'ghx ci wait o/r#7']);
});
