// fetchJobLog over the spike §3.3 responses (gh/logs-api). Lives here rather than in test/commands/
// (03's ci-logs-fetch.test.ts) because there is no command yet; it drives createGh directly.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fetchJobLog, LOG_CAP_BYTES } from '../../../../src/ci/logs/fetch.ts';
import { isGhxError } from '../../../../src/core/errors.ts';
import { ciEnv, notFound, repoOf } from '../_helpers.ts';

test('200: the log streams to <root>/<host>/<owner>/<repo>/logs/job-<id>.log, cleaned, with step segments', async () => {
  const env = ciEnv('logs-api');
  const r = await fetchJobLog({ gh: env.gh, artifacts: env.artifacts, repo: repoOf('cli/cli'), jobId: 119137909038 });
  assert.ok(r.ok);
  assert.equal(r.log.path, join(env.artifacts.root, 'github.com', 'cli', 'cli', 'logs', 'job-119137909038.log'));
  const text = readFileSync(r.log.path, 'utf8');
  assert.equal(r.log.bytes, Buffer.byteLength(text));
  assert.ok(text.startsWith('Current runner version'), 'no headers, BOM or timestamp');
  assert.ok(!text.includes('\u001b['), 'no ANSI');
  assert.ok(!/^\d{4}-\d{2}-\d{2}T/m.test(text), 'no timestamps');
  assert.ok(text.includes('##[error]Process completed with exit code 1.'));
  assert.ok(r.log.segments.some((s) => s.header === 'Run go mod tidy -diff' && s.ts !== null));
  // Only the cleaned log remains.
  assert.deepEqual(
    readdirSync(dirname(r.log.path)).filter((f) => f.startsWith('job-')),
    ['job-119137909038.log'],
  );
  env.fake.expectNoCall({ prefix: ['run', 'view'] });
  env.fake.expectNoMutations();
});

test('blob 404 (job still running): LOGS_NOT_READY warning, no file, no throw', async () => {
  const env = ciEnv('logs-api');
  const r = await fetchJobLog({
    gh: env.gh,
    artifacts: env.artifacts,
    repo: repoOf('vercel/next.js'),
    jobId: 119958724632,
  });
  assert.deepEqual(r.ok ? null : r.warning.code, 'LOGS_NOT_READY');
  assert.equal(
    existsSync(join(env.artifacts.root, 'github.com', 'vercel', 'next.js', 'logs', 'job-119958724632.log')),
    false,
  );
});

test('410 (expired): LOGS_UNAVAILABLE warning, not GH_FAILED, and not retried', async () => {
  const env = ciEnv('logs-api');
  const r = await fetchJobLog({ gh: env.gh, artifacts: env.artifacts, repo: repoOf('cli/cli'), jobId: 73871539329 });
  assert.deepEqual(r.ok ? null : r.warning.code, 'LOGS_UNAVAILABLE');
  assert.equal(env.fake.calls.length, 1);
});

test('a GitHub JSON 404 (no such job) is RUN_NOT_FOUND', async () => {
  const env = ciEnv();
  env.fake.on({ prefix: ['api'] }, notFound());
  await assert.rejects(fetchJobLog({ gh: env.gh, artifacts: env.artifacts, repo: repoOf('o/r'), jobId: 1 }), (e) =>
    isGhxError(e, 'RUN_NOT_FOUND'),
  );
  env.fake.expectCalls([['api', '--include', '-X', 'GET', 'repos/o/r/actions/jobs/1/logs']], { exhaustive: true });
});

test('a log over the cap keeps only its tail and warns LOG_TRUNCATED (02 §11.4: 8 MB per log)', async () => {
  assert.equal(LOG_CAP_BYTES, 8 * 1024 * 1024);
  const env = ciEnv('logs-api');
  const r = await fetchJobLog({
    gh: env.gh,
    artifacts: env.artifacts,
    repo: repoOf('cli/cli'),
    jobId: 119137909038,
    maxBytes: 8192,
  });
  assert.ok(r.ok);
  assert.equal(r.log.warning?.code, 'LOG_TRUNCATED');
  assert.ok(r.log.omittedBytes > 0);
  const text = readFileSync(r.log.path, 'utf8');
  assert.ok(r.log.bytes <= 8192, `kept ${r.log.bytes} bytes`);
  assert.ok(!text.startsWith('Current runner version'), 'the head was dropped');
  assert.ok(text.includes('##[error]Process completed with exit code 1.'), 'the failure near the end is kept');
  assert.ok(text.endsWith('Cleaning up orphan processes\n'), 'the tail is intact');
  assert.equal(r.log.lines, text.split('\n').length - 1);
});

test('a log under the cap is kept whole, with no warning', async () => {
  const env = ciEnv('logs-api');
  const r = await fetchJobLog({ gh: env.gh, artifacts: env.artifacts, repo: repoOf('cli/cli'), jobId: 119137909038 });
  assert.ok(r.ok);
  assert.equal(r.log.warning, null);
  assert.equal(r.log.omittedBytes, 0);
});
