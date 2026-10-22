import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkRunBucket,
  collapseLatest,
  ignoreRuleFor,
  normaliseContext,
  normaliseRollup,
  type RollupContext,
} from '../../../src/ci/checks.ts';
import { Check } from '../../../src/schemas/ci.ts';
import { repoOf } from './_helpers.ts';

const repo = repoOf('o/r');
const headSha = 'a'.repeat(40);

const run = (
  id: number,
  name: string,
  conclusion: string | null,
  o: Partial<Record<string, unknown>> = {},
): RollupContext =>
  ({
    __typename: 'CheckRun',
    databaseId: id,
    name,
    status: conclusion === null ? 'IN_PROGRESS' : 'COMPLETED',
    conclusion,
    startedAt: '2026-10-22T10:00:00Z',
    completedAt: conclusion === null ? null : '2026-10-22T10:05:00Z',
    detailsUrl: `https://github.com/o/r/actions/runs/7/job/${id}`,
    isRequired: false,
    checkSuite: {
      app: { slug: 'github-actions' },
      workflowRun: {
        databaseId: 7,
        event: 'pull_request',
        file: { path: '.github/workflows/ci.yml' },
        workflow: { databaseId: 3, name: 'CI' },
      },
    },
    ...o,
  }) as RollupContext;

const status = (context: string, state: string, targetUrl: string | null): RollupContext => ({
  __typename: 'StatusContext',
  context,
  state,
  targetUrl,
  createdAt: '2026-10-22T10:00:00Z',
  isRequired: true,
});

test('bucket mapping follows gh pr checks; cancelled is its own bucket', () => {
  assert.equal(checkRunBucket('COMPLETED', 'SUCCESS'), 'pass');
  for (const c of ['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED'])
    assert.equal(checkRunBucket('COMPLETED', c), 'fail');
  assert.equal(checkRunBucket('COMPLETED', 'CANCELLED'), 'cancelled');
  assert.equal(checkRunBucket('COMPLETED', 'SKIPPED'), 'skipped');
  assert.equal(checkRunBucket('COMPLETED', 'NEUTRAL'), 'neutral');
  assert.equal(checkRunBucket('IN_PROGRESS', null), 'pending');
  assert.equal(checkRunBucket('QUEUED', null), 'pending');
});

test('an Actions CheckRun maps to kind actions with run and job ids; the result satisfies the Check schema', () => {
  const { check } = normaliseContext(run(42, 'build', 'FAILURE', { isRequired: true }), { repo, headSha });
  assert.deepEqual(check, {
    name: 'build',
    workflow: 'CI',
    kind: 'actions',
    bucket: 'fail',
    status: 'completed',
    conclusion: 'failure',
    required: true,
    runId: 7,
    jobId: 42,
    attempt: null,
    url: 'https://github.com/o/r/actions/runs/7/job/42',
    startedAt: '2026-10-22T10:00:00Z',
    completedAt: '2026-10-22T10:05:00Z',
  });
  Check.parse(check);
});

test('a non-Actions CheckRun is kind app and has no job id', () => {
  const { check } = normaliseContext(
    run(9, 'codecov', 'SUCCESS', { checkSuite: { app: { slug: 'codecov' }, workflowRun: null } }),
    {
      repo,
      headSha,
    },
  );
  assert.equal(check.kind, 'app');
  assert.equal(check.jobId, null);
  assert.equal(check.workflow, null);
});

test('a StatusContext maps to kind status; a null targetUrl falls back to the commit checks page', () => {
  const { check } = normaliseContext(status('ci/jenkins', 'FAILURE', null), { repo, headSha });
  assert.equal(check.kind, 'status');
  assert.equal(check.bucket, 'fail');
  assert.equal(check.status, 'completed');
  assert.equal(check.conclusion, 'failure');
  assert.equal(check.required, true);
  assert.equal(check.url, `https://github.com/o/r/commit/${headSha}/checks`);
  Check.parse(check);
  const pending = normaliseContext(status('ci/jenkins', 'PENDING', 'https://ci.example/1'), { repo, headSha }).check;
  assert.equal(pending.bucket, 'pending');
  assert.equal(pending.status, 'in_progress');
  assert.equal(pending.completedAt, null);
  assert.equal(normaliseContext(status('x', 'EXPECTED', null), { repo, headSha }).check.status, 'expected');
});

test('a CheckRun without detailsUrl also gets the fallback url (Check.url is never null)', () => {
  const { check } = normaliseContext(run(5, 'x', 'SUCCESS', { detailsUrl: null }), { repo, headSha });
  assert.equal(check.url, `https://github.com/o/r/commit/${headSha}/checks`);
});

test('duplicate CI duration watch rows collapse to the latest attempt (§6); other rows keep their order', () => {
  const out = collapseLatest(
    [
      run(10, 'lint', 'SUCCESS'),
      run(11, 'CI duration watch', 'FAILURE'),
      run(30, 'CI duration watch', 'SUCCESS'),
      run(12, 'test', 'SUCCESS'),
    ].map((n) => normaliseContext(n, { repo, headSha })),
  );
  assert.deepEqual(
    out.map((c) => [c.name, c.bucket]),
    [
      ['lint', 'pass'],
      ['CI duration watch', 'pass'],
      ['test', 'pass'],
    ],
  );
});

test('same job name in different workflows stays distinct', () => {
  const other = run(20, 'CI duration watch', 'SUCCESS', {
    checkSuite: {
      app: null,
      workflowRun: { databaseId: 8, event: 'push', file: null, workflow: { databaseId: 4, name: 'Release' } },
    },
  });
  const out = collapseLatest(
    [run(11, 'CI duration watch', 'FAILURE'), other].map((n) => normaliseContext(n, { repo, headSha })),
  );
  assert.equal(out.length, 2);
});

test('ignore rules: exact, glob, and {name, workflow, reason}', () => {
  assert.ok(ignoreRuleFor({ name: 'notify-discord', workflow: 'CI' }, ['notify-discord']));
  assert.ok(ignoreRuleFor({ name: 'notify-slack', workflow: 'CI' }, ['notify-*']));
  assert.equal(ignoreRuleFor({ name: 'build', workflow: 'CI' }, ['notify-*']), undefined);
  const rule = { name: 'watch', workflow: 'Release', reason: 'noise' };
  assert.ok(ignoreRuleFor({ name: 'watch', workflow: 'Release' }, [rule]));
  assert.equal(ignoreRuleFor({ name: 'watch', workflow: 'CI' }, [rule]), undefined);
  assert.equal(ignoreRuleFor({ name: 'watch', workflow: null }, [rule]), undefined);
});

test('normaliseRollup: notify-discord is ignored and listed; runs are indexed by run id', () => {
  const out = normaliseRollup([run(1, 'build', 'SUCCESS'), run(2, 'notify-discord', 'SKIPPED')], {
    repo,
    headSha,
    ignore: ['notify-discord'],
  });
  assert.deepEqual(
    out.checks.map((c) => c.name),
    ['build'],
  );
  assert.deepEqual(out.ignored, ['notify-discord']);
  assert.deepEqual(out.runs['7'], {
    runId: 7,
    workflowId: 3,
    workflowName: 'CI',
    workflowPath: '.github/workflows/ci.yml',
    event: 'pull_request',
  });
});
