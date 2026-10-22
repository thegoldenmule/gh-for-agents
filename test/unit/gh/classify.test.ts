import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { publicCodeFor } from '../../../src/core/errors.ts';
import { CLASSIFIER_ROWS, type ClassifyInput, classify } from '../../../src/gh/classify.ts';

const DIR = join(import.meta.dirname, '../../fixtures/gh-stderr');
const stderr = (f: string): string => readFileSync(join(DIR, f), 'utf8');

const CASES: [file: string, extra: Partial<ClassifyInput>, code: string, transient: boolean][] = [
  ['run-view-in-progress.txt', {}, 'GH_IN_PROGRESS', false],
  ['no-checks.txt', {}, 'GH_NO_CHECKS', false],
  ['not-a-git-repo.txt', {}, 'GH_NOT_A_REPO', false],
  ['could-not-resolve-pr.txt', {}, 'GH_NOT_FOUND', false],
  ['already-merged.txt', {}, 'GH_ALREADY', false],
  ['graphql-something-went-wrong.txt', {}, 'GH_TRANSIENT', true],
  ['rerun-already-running.txt', {}, 'GH_ALREADY', false],
  ['job-cannot-be-rerun.txt', {}, 'GH_ALREADY', false],
  ['unknown-json-field.txt', {}, 'GH_FAILED', false],
  ['diff-406.txt', {}, 'GH_TOO_LARGE', false],
  ['logs-gone-410.txt', {}, 'GH_LOGS_GONE', false],
  [
    'logs-blob-404.txt',
    { stdout: 'HTTP/1.1 404 The specified blob does not exist.\r\n\r\n<Error><Code>BlobNotFound</Code></Error>' },
    'GH_LOGS_NOT_READY',
    false,
  ],
  ['logs-blob-404.txt', { stdout: '{"message":"Not Found"}' }, 'GH_NOT_FOUND', false],
  ['api-not-found.txt', {}, 'GH_NOT_FOUND', false],
  ['server-error-502.txt', {}, 'GH_TRANSIENT', true],
  ['rate-limit-403.txt', {}, 'GH_RATE_LIMITED', true],
  ['secondary-rate-limit-403.txt', {}, 'GH_RATE_LIMITED', true],
  ['graphql-rate-limit.txt', {}, 'GH_RATE_LIMITED', true],
  ['forbidden-403.txt', {}, 'GH_FORBIDDEN', false],
  ['bad-credentials-401.txt', {}, 'GH_AUTH', false],
  ['not-logged-in.txt', {}, 'GH_AUTH', false],
  ['connection-reset.txt', {}, 'GH_TRANSIENT', true],
  ['io-timeout.txt', {}, 'GH_TRANSIENT', true],
  ['eof.txt', {}, 'GH_TRANSIENT', true],
];

for (const [file, extra, code, transient] of CASES) {
  test(`${file}${extra.stdout ? ' (with stdout)' : ''} → ${code}`, () => {
    const r = classify({ exitCode: 1, stderr: stderr(file), stdout: '', ...extra });
    assert.equal(r.code, code);
    assert.equal(r.transient, transient);
  });
}

test('spawn ENOENT → GH_NOT_INSTALLED → ENV_GH_MISSING', () => {
  const r = classify({ exitCode: null, stderr: '', stdout: '', spawnErrorCode: 'ENOENT' });
  assert.equal(r.code, 'GH_NOT_INSTALLED');
  assert.equal(publicCodeFor(r.code), 'ENV_GH_MISSING');
});

test('per-attempt timeout → GH_TIMEOUT (transient)', () => {
  assert.deepEqual(classify({ exitCode: null, stderr: '', stdout: '', timedOut: true }), {
    code: 'GH_TIMEOUT',
    transient: true,
  });
});

test('410 must not be classified transient even though it says Server Error (03 §3.3)', () => {
  const r = classify({ exitCode: 1, stderr: 'gh: Server Error (HTTP 410)', stdout: '' });
  assert.equal(r.transient, false);
  assert.equal(r.status, 410);
});

test('GraphQL partial NOT_FOUND on a 200 with exit 1 (03 §3.4)', () => {
  const stdout = JSON.stringify({
    data: { repository: { pullRequest: null } },
    errors: [{ type: 'NOT_FOUND', path: ['repository', 'pullRequest'], message: 'Could not resolve' }],
  });
  assert.equal(classify({ exitCode: 1, stderr: '', stdout, status: 200 }).code, 'GH_NOT_FOUND');
});

test('rate limit carries retryAfterMs from Retry-After or x-ratelimit-reset', () => {
  const a = classify({
    exitCode: 1,
    stderr: stderr('secondary-rate-limit-403.txt'),
    stdout: '',
    headers: { 'retry-after': '60' },
  });
  assert.equal(a.retryAfterMs, 60_000);
  const b = classify({
    exitCode: 1,
    stderr: stderr('rate-limit-403.txt'),
    stdout: '',
    headers: { 'x-ratelimit-reset': '1000' },
    now: 990_000,
  });
  assert.equal(b.retryAfterMs, 10_000);
});

test('anything else → GH_FAILED', () => {
  assert.equal(classify({ exitCode: 1, stderr: 'something odd', stdout: '' }).code, 'GH_FAILED');
});

test('every classifier row is exercised by a case above', () => {
  const covered = new Set([...CASES.map((c) => c[2]), 'GH_NOT_INSTALLED', 'GH_TIMEOUT']);
  for (const row of CLASSIFIER_ROWS) assert.ok(covered.has(row.code), row.code);
});
