import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summariseCi } from '../../../src/ci/summary.ts';
import { type Bucket, type Check, CiSummary } from '../../../src/schemas/ci.ts';

const headSha = 'b'.repeat(40);
const check = (name: string, bucket: Bucket): Check => ({
  name,
  workflow: 'CI',
  kind: 'actions',
  bucket,
  status: bucket === 'pending' ? 'in_progress' : 'completed',
  conclusion: bucket === 'pending' ? null : bucket === 'pass' ? 'success' : bucket === 'fail' ? 'failure' : bucket,
  required: false,
  runId: 1,
  jobId: 2,
  attempt: null,
  url: 'https://github.com/o/r/actions/runs/1/job/2',
  startedAt: null,
  completedAt: null,
});

test('zero checks gives no-checks/registering, never green', () => {
  const s = summariseCi({ headSha, checks: [] });
  assert.equal(s.state, 'no-checks');
  assert.equal(s.phase, 'registering');
  CiSummary.parse(s);
});

test('zero checks with only ignored ones is still no-checks, with the ignored count', () => {
  const s = summariseCi({ headSha, checks: [], ignored: ['notify-discord'] });
  assert.equal(s.state, 'no-checks');
  assert.equal(s.counts.ignored, 1);
  assert.deepEqual(s.ignored, ['notify-discord']);
});

test('all passed (skipped and neutral allowed) is green/settled', () => {
  const s = summariseCi({ headSha, checks: [check('a', 'pass'), check('b', 'skipped'), check('c', 'neutral')] });
  assert.equal(s.state, 'green');
  assert.equal(s.phase, 'settled');
  assert.deepEqual(s.counts, { pass: 1, fail: 0, pending: 0, skipped: 1, cancelled: 0, neutral: 1, ignored: 0 });
});

test('cancelled counts as red', () => {
  const s = summariseCi({ headSha, checks: [check('a', 'pass'), check('b', 'cancelled')] });
  assert.equal(s.state, 'red');
  assert.deepEqual(
    s.failing.map((f) => [f.name, f.sameOnMain, f.flake]),
    [['b', null, null]],
  );
});

test('a failure while others run is red/running, and the pending list carries the picked fields', () => {
  const s = summariseCi({ headSha, checks: [check('a', 'fail'), check('b', 'pending')] });
  assert.equal(s.state, 'red');
  assert.equal(s.phase, 'running');
  assert.deepEqual(s.pending, [{ name: 'b', workflow: 'CI', status: 'in_progress', required: false }]);
  CiSummary.parse(s);
});

test('pending only is pending/running', () => {
  const s = summariseCi({ headSha, checks: [check('a', 'pass'), check('b', 'pending')] });
  assert.equal(s.state, 'pending');
  assert.equal(s.phase, 'running');
});

test('a missing expected check keeps it off green (partial)', () => {
  const s = summariseCi({
    headSha,
    checks: [check('a', 'pass')],
    expected: [
      { name: 'a', workflow: 'CI', source: 'required', state: 'reported' },
      { name: 'e2e', workflow: 'CI', source: 'required', state: 'missing' },
    ],
  });
  assert.equal(s.state, 'pending');
  assert.equal(s.phase, 'partial');
  assert.deepEqual(
    s.expectedMissing.map((e) => e.name),
    ['e2e'],
  );
  const none = summariseCi({
    headSha,
    checks: [],
    expected: [{ name: 'e2e', workflow: null, source: 'config', state: 'missing' }],
  });
  assert.equal(none.state, 'pending');
  assert.equal(none.phase, 'registering');
});

test('an SHA mismatch reports nothing and is pending', () => {
  const s = summariseCi({ headSha, checks: [check('a', 'fail')], ignored: ['x'], shaMismatch: true });
  assert.equal(s.state, 'pending');
  assert.equal(s.phase, 'registering');
  assert.deepEqual(s.failing, []);
  assert.equal(s.counts.fail, 0);
  assert.equal(s.forHeadSha, true);
});
