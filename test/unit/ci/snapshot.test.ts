// fetchCiSnapshot over the recorded ci-snapshot/* scenarios (03 M2.2). Lives here rather than in
// test/commands/ (03's ci-snapshot.test.ts) because there is no command yet; it drives createGh directly.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normaliseRollup } from '../../../src/ci/checks.ts';
import { type CiCommit, completeRollup, fetchCiSnapshot, snapshotSummary } from '../../../src/ci/snapshot.ts';
import { isGhxError } from '../../../src/core/errors.ts';
import { CiSummary } from '../../../src/schemas/ci.ts';
import { loadScenario } from '../../helpers/fixture-match.ts';
import { ciEnv, httpReply, repoOf } from './_helpers.ts';

const cli = repoOf('cli/cli');

test('pass (cli/cli#14770): green/settled in one GraphQL call, every check normalised', async () => {
  const env = ciEnv('ci-snapshot/pass');
  const s = await fetchCiSnapshot({ gh: env.gh, repo: cli, number: 14770, warn: env.warn });
  assert.equal(s.forHeadSha, true);
  assert.equal(s.queries, 1);
  assert.equal(s.defaultBranch, 'trunk');
  assert.ok(s.checks.length > 5);
  const sum = CiSummary.parse(snapshotSummary(s));
  assert.equal(sum.state, 'green');
  assert.equal(sum.phase, 'settled');
  assert.equal(sum.headSha, s.headSha);
  assert.deepEqual(env.warnings, []);
  env.fake.expectNoMutations();
  env.fake.expectNoCall({ prefix: ['run', 'view'] });
});

test('fail (cli/cli#14630): govulncheck is the failing Actions check, with run and job ids', async () => {
  const env = ciEnv('ci-snapshot/fail');
  const s = await fetchCiSnapshot({ gh: env.gh, repo: cli, number: 14630 });
  const sum = snapshotSummary(s);
  assert.equal(sum.state, 'red');
  assert.deepEqual(
    sum.failing.map((f) => [f.name, f.workflow, f.kind]),
    [['govulncheck', 'Lint', 'actions']],
  );
  const f = sum.failing[0];
  assert.ok(f?.runId && f.jobId);
  assert.equal(s.runs[String(f.runId)]?.workflowName, 'Lint');
  assert.match(s.runs[String(f.runId)]?.workflowPath ?? '', /^\.github\/workflows\//);
});

test('pending: checks still running give state pending and a pending list', async () => {
  const env = ciEnv('ci-snapshot/pending');
  const s = await fetchCiSnapshot({ gh: env.gh, repo: cli, number: 14791 });
  const sum = snapshotSummary(s);
  assert.ok(sum.pending.length > 0);
  assert.notEqual(sum.state, 'green');
  assert.notEqual(sum.phase, 'settled');
});

test('status-context (nodejs/node#66900): Jenkins StatusContexts map to kind status beside Actions checks', async () => {
  const env = ciEnv('ci-snapshot/status-context');
  const s = await fetchCiSnapshot({ gh: env.gh, repo: repoOf('nodejs/node'), number: 66900 });
  const statuses = s.checks.filter((c) => c.kind === 'status');
  assert.ok(statuses.some((c) => c.name === 'node-test-commit'));
  assert.ok(statuses.every((c) => c.workflow === null && c.jobId === null && c.url.startsWith('https://')));
  assert.ok(s.checks.some((c) => c.kind === 'actions'));
  CiSummary.parse(snapshotSummary(s));
});

test('no-checks: a null rollup is no-checks/registering', async () => {
  const env = ciEnv('ci-snapshot/no-checks');
  const sum = snapshotSummary(await fetchCiSnapshot({ gh: env.gh, repo: cli, number: 14770 }));
  assert.equal(sum.state, 'no-checks');
  assert.equal(sum.phase, 'registering');
});

test('rerun-duplicates: the failed first attempt of CI duration watch is collapsed away', async () => {
  const env = ciEnv('ci-snapshot/rerun-duplicates');
  const s = await fetchCiSnapshot({ gh: env.gh, repo: cli, number: 14770 });
  const watch = s.checks.filter((c) => c.name === 'CI duration watch');
  assert.equal(watch.length, 1);
  assert.equal(watch[0]?.bucket, 'pass');
  assert.equal(snapshotSummary(s).state, 'green');
});

test('ignored-noise: notify-discord is ignored and counted in counts.ignored', async () => {
  const env = ciEnv('ci-snapshot/ignored-noise');
  const s = await fetchCiSnapshot({ gh: env.gh, repo: cli, number: 14770, ignore: ['notify-discord'] });
  const sum = snapshotSummary(s);
  assert.deepEqual(sum.ignored, ['notify-discord']);
  assert.equal(sum.counts.ignored, 1);
  assert.ok(!s.checks.some((c) => c.name === 'notify-discord'));
  // Without the rule it is just a skipped check.
  const env2 = ciEnv('ci-snapshot/ignored-noise');
  const s2 = await fetchCiSnapshot({ gh: env2.gh, repo: cli, number: 14770 });
  assert.equal(s2.checks.find((c) => c.name === 'notify-discord')?.bucket, 'skipped');
});

test('oid-mismatch: one re-query, then CI_SHA_MISMATCH and pending with no checks', async () => {
  const env = ciEnv('ci-snapshot/oid-mismatch');
  const s = await fetchCiSnapshot({ gh: env.gh, repo: cli, number: 14770, warn: env.warn });
  assert.equal(env.fake.calls.length, 2);
  assert.equal(s.queries, 2);
  assert.equal(s.forHeadSha, false);
  assert.deepEqual(s.checks, []);
  assert.deepEqual(
    env.warnings.map((w) => w.code),
    ['CI_SHA_MISMATCH'],
  );
  const sum = snapshotSummary(s);
  assert.equal(sum.state, 'pending');
  assert.equal(sum.headSha, s.headSha);
  env.fake.assertAllConsumed();
});

test('oid-mismatch that resolves on the re-query reports the checks', async () => {
  const env = ciEnv('ci-snapshot/oid-mismatch');
  // The second call answers with the matching `pass` capture.
  const passReply = loadScenario('ci-snapshot/pass')[0];
  assert.ok(passReply);
  let n = 0;
  env.fake.on(() => n++ >= 1, { exitCode: 0, stdout: passReply.stdout, stderr: '' });
  const s = await fetchCiSnapshot({ gh: env.gh, repo: cli, number: 14770, warn: env.warn });
  assert.equal(s.forHeadSha, true);
  assert.equal(s.queries, 2);
  assert.deepEqual(env.warnings, []);
  assert.equal(snapshotSummary(s).state, 'green');
});

test('contexts are paginated on hasNextPage, with the cursor passed as $after', async () => {
  const env = ciEnv();
  const sha = 'c'.repeat(40);
  const page = (nodes: unknown[], hasNextPage: boolean, endCursor: string | null) =>
    httpReply(
      'HTTP/2.0 200 OK',
      JSON.stringify({
        data: {
          repository: {
            defaultBranchRef: { name: 'main' },
            pullRequest: {
              number: 1,
              state: 'OPEN',
              headRefOid: sha,
              headRefName: 'feat',
              baseRefName: 'main',
              commits: {
                nodes: [
                  {
                    commit: {
                      oid: sha,
                      statusCheckRollup: { contexts: { pageInfo: { hasNextPage, endCursor }, nodes } },
                    },
                  },
                ],
              },
            },
          },
        },
      }),
    );
  const ctx = (name: string, state: string) => ({
    __typename: 'StatusContext',
    context: name,
    state,
    targetUrl: null,
    createdAt: '2026-10-22T10:00:00Z',
    isRequired: false,
  });
  env.fake.on((argv) => !argv.some((a) => a.startsWith('after=')), {
    exitCode: 0,
    stdout: page([ctx('a', 'SUCCESS')], true, 'CUR1'),
    stderr: '',
  });
  env.fake.on((argv) => argv.includes('after=CUR1'), {
    exitCode: 0,
    stdout: page([ctx('b', 'FAILURE')], false, null),
    stderr: '',
  });
  const s = await fetchCiSnapshot({ gh: env.gh, repo: repoOf('o/r'), number: 1 });
  assert.deepEqual(
    s.checks.map((c) => c.name),
    ['a', 'b'],
  );
  assert.equal(s.queries, 2);
  assert.equal(snapshotSummary(s).state, 'red');
});

test('a missing PR is PR_NOT_FOUND', async () => {
  const env = ciEnv();
  env.fake.on(() => true, {
    exitCode: 1,
    stdout: httpReply(
      'HTTP/2.0 200 OK',
      JSON.stringify({
        data: { repository: { defaultBranchRef: { name: 'main' }, pullRequest: null } },
        errors: [
          {
            type: 'NOT_FOUND',
            path: ['repository', 'pullRequest'],
            message: 'Could not resolve to a PullRequest with the number of 99999.',
          },
        ],
      }),
    ),
    stderr: 'gh: Could not resolve to a PullRequest with the number of 99999.\n',
  });
  await assert.rejects(fetchCiSnapshot({ gh: env.gh, repo: repoOf('o/r'), number: 99999 }), (e) =>
    isGhxError(e, 'PR_NOT_FOUND'),
  );
});

// completeRollup: the re-query and pagination for callers that embed CI_COMMIT_FIELDS in their own query.
const SHA_C = 'c'.repeat(40);
const statusCtx = (name: string, state: string) => ({
  __typename: 'StatusContext',
  context: name,
  state,
  targetUrl: null,
  createdAt: '2026-10-22T10:00:00Z',
  isRequired: false,
});
const commitOf = (oid: string, nodes: unknown[], hasNextPage: boolean, endCursor: string | null) => ({
  oid,
  statusCheckRollup: { contexts: { pageInfo: { hasNextPage, endCursor }, nodes } },
});
const ciPage = (headRefOid: string, commit: unknown) =>
  httpReply(
    'HTTP/2.0 200 OK',
    JSON.stringify({
      data: {
        repository: {
          defaultBranchRef: { name: 'main' },
          pullRequest: {
            number: 1,
            state: 'OPEN',
            headRefOid,
            headRefName: 'feat',
            baseRefName: 'main',
            commits: { nodes: [{ commit }] },
          },
        },
      },
    }),
  );

test('completeRollup pages on from a caller first page, passing the cursor as $after', async () => {
  const env = ciEnv();
  env.fake.on((argv) => argv.includes('after=CUR1'), {
    exitCode: 0,
    stdout: ciPage(SHA_C, commitOf(SHA_C, [statusCtx('b', 'FAILURE')], false, null)),
    stderr: '',
  });
  const firstPage = commitOf(SHA_C, [statusCtx('a', 'SUCCESS')], true, 'CUR1') as CiCommit;
  const r = await completeRollup({ gh: env.gh, repo: repoOf('o/r'), number: 1, headSha: SHA_C, firstPage });
  assert.equal(r.forHeadSha, true);
  if (r.forHeadSha) {
    assert.deepEqual(
      r.nodes.map((n) => (n.__typename === 'StatusContext' ? n.context : n.name)),
      ['a', 'b'],
    );
    assert.equal(r.truncated, false);
  }
  assert.equal(r.queries, 1);
  env.fake.assertAllConsumed();
});

test('completeRollup re-queries once on an oid mismatch, then reports CI_SHA_MISMATCH', async () => {
  const stale = commitOf('d'.repeat(40), [], false, null) as CiCommit;
  const fixed = ciEnv();
  fixed.fake.on(() => true, {
    exitCode: 0,
    stdout: ciPage(SHA_C, commitOf(SHA_C, [statusCtx('a', 'SUCCESS')], false, null)),
    stderr: '',
  });
  const ok = await completeRollup({ gh: fixed.gh, repo: repoOf('o/r'), number: 1, headSha: SHA_C, firstPage: stale });
  assert.deepEqual([ok.forHeadSha, ok.headSha, ok.queries], [true, SHA_C, 1]);
  const still = ciEnv();
  still.fake.on(() => true, { exitCode: 0, stdout: ciPage(SHA_C, stale), stderr: '' });
  const bad = await completeRollup({
    gh: still.gh,
    repo: repoOf('o/r'),
    number: 1,
    headSha: SHA_C,
    firstPage: stale,
    warn: still.warn,
  });
  assert.equal(bad.forHeadSha, false);
  if (!bad.forHeadSha) assert.equal(bad.rollupOid, 'd'.repeat(40));
  assert.deepEqual(
    still.warnings.map((w) => w.code),
    ['CI_SHA_MISMATCH'],
  );
});

test('completeRollup appends a run GitHub rejected (a failed suite with no check run) and warns WORKFLOW_INVALID', async () => {
  const env = ciEnv();
  const suite = (status: string, conclusion: string | null, runs: number, id: number | null) => ({
    status,
    conclusion,
    checkRuns: { totalCount: runs },
    workflowRun:
      id === null
        ? null
        : {
            databaseId: id,
            url: `https://github.com/o/r/actions/runs/${id}`,
            createdAt: '2026-10-22T10:00:00Z',
            event: 'push',
            file: { path: `.github/workflows/w${id}.yml` },
            workflow: { databaseId: id, name: `w${id}` },
          },
  });
  const firstPage = {
    ...commitOf(SHA_C, [statusCtx('a', 'SUCCESS')], false, null),
    checkSuites: {
      nodes: [
        suite('COMPLETED', 'FAILURE', 0, 1), // rejected
        suite('COMPLETED', 'STARTUP_FAILURE', 0, 2), // rejected
        suite('COMPLETED', 'FAILURE', 3, 3), // failed jobs: in the rollup already
        suite('COMPLETED', 'ACTION_REQUIRED', 0, 4), // awaiting approval, not rejected
        suite('QUEUED', null, 0, 5),
        suite('COMPLETED', 'FAILURE', 0, null), // another app's suite
        null,
      ],
    },
  } as CiCommit;
  const warnings: { code: string; message: string }[] = [];
  const r = await completeRollup({
    gh: env.gh,
    repo: repoOf('o/r'),
    number: 1,
    headSha: SHA_C,
    firstPage,
    warn: (w) => warnings.push(w),
  });
  assert.equal(r.forHeadSha, true);
  if (!r.forHeadSha) return;
  const checks = normaliseRollup(r.nodes, { repo: repoOf('o/r'), headSha: SHA_C }).checks;
  assert.deepEqual(
    checks.map((c) => [c.name, c.workflow, c.kind, c.bucket, c.conclusion, c.runId, c.jobId, c.url]),
    [
      ['a', null, 'status', 'pass', 'success', null, null, `https://github.com/o/r/commit/${SHA_C}/checks`],
      [
        '.github/workflows/w1.yml',
        'w1',
        'actions',
        'fail',
        'failure',
        1,
        null,
        'https://github.com/o/r/actions/runs/1',
      ],
      [
        '.github/workflows/w2.yml',
        'w2',
        'actions',
        'fail',
        'startup_failure',
        2,
        null,
        'https://github.com/o/r/actions/runs/2',
      ],
    ],
  );
  assert.deepEqual(
    warnings.map((w) => w.code),
    ['WORKFLOW_INVALID', 'WORKFLOW_INVALID'],
  );
  assert.match(
    warnings[0]?.message ?? '',
    /\.github\/workflows\/w1\.yml.*https:\/\/github\.com\/o\/r\/actions\/runs\/1$/,
  );
  assert.equal(r.queries, 0);
});
