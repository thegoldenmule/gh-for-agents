import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { repoCache } from '../../../../src/ci/cache.ts';
import { fetchWorkflowTimeouts } from '../../../../src/ci/wait/fetch.ts';
import { DEFAULT_TIMEOUT_MINUTES, jobTimeoutFor, scanJobTimeouts } from '../../../../src/ci/wait/job-timeouts.ts';
import { ciEnv, notFound, ok, repoOf } from '../_helpers.ts';

const FIX = join(import.meta.dirname, '../../../fixtures/workflows');
const mixed = readFileSync(join(FIX, 'timeouts-mixed.yml'), 'utf8');
const scan = scanJobTimeouts(mixed);

test('the scanner reads job-level keys only (never step-level or top-level timeouts)', () => {
  assert.deepEqual(scan.jobs, [
    { id: 'lint', name: null, timeoutMinutes: 10, matrix: false, uses: false },
    { id: 'build', name: 'Build', timeoutMinutes: null, matrix: false, uses: false },
    { id: 'test', name: null, timeoutMinutes: 45, matrix: true, uses: false },
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal GitHub Actions expression
    { id: 'e2e', name: 'E2E ${{ matrix.shard }}/4', timeoutMinutes: 25, matrix: true, uses: false },
    { id: 'docs', name: null, timeoutMinutes: null, matrix: false, uses: false },
    { id: 'release', name: null, timeoutMinutes: null, matrix: false, uses: true },
  ]);
});

test('timeout per display name: literal, expression, absent, matrix, reusable workflow', () => {
  const rows: [string, number, string][] = [
    ['lint', 10, 'timeout-minutes'],
    ['Build', DEFAULT_TIMEOUT_MINUTES, 'default-360'], // an expression falls back
    ['docs', DEFAULT_TIMEOUT_MINUTES, 'default-360'], // absent
    ['test (ubuntu-latest, 22)', 45, 'timeout-minutes'], // matrix: one job id, several display names
    ['test (macos-latest, 24)', 45, 'timeout-minutes'],
    ['E2E 3/4', 25, 'timeout-minutes'], // a name with a matrix expression
    ['release / publish', DEFAULT_TIMEOUT_MINUTES, 'default-360'], // the limit lives in the called file
    ['unknown-job', DEFAULT_TIMEOUT_MINUTES, 'default-360'],
  ];
  for (const [name, minutes, basis] of rows) {
    assert.deepEqual(jobTimeoutFor(scan, name), { minutes, basis }, name);
  }
  assert.deepEqual(jobTimeoutFor(null, 'lint'), { minutes: 360, basis: 'default-360' });
});

test('a flow-style jobs mapping or a file without jobs is unresolvable, so 360', () => {
  const flow = scanJobTimeouts(readFileSync(join(FIX, 'timeouts-flow.yml'), 'utf8'));
  assert.deepEqual(flow.jobs, []);
  assert.equal(jobTimeoutFor(flow, 'only').minutes, 360);
  assert.deepEqual(scanJobTimeouts('name: x\n').jobs, []);
});

test('CRLF line endings and comments are handled', () => {
  const s = scanJobTimeouts('jobs:\r\n  a: # the job\r\n    timeout-minutes: 7 # min\r\n');
  assert.deepEqual(jobTimeoutFor(s, 'a'), { minutes: 7, basis: 'timeout-minutes' });
});

test('fetchWorkflowTimeouts reads contents at the bound SHA and caches the scan forever', async () => {
  const env = ciEnv();
  const cache = await repoCache({
    artifacts: env.artifacts,
    repo: repoOf('o/r'),
    clock: env.clock,
    ns: 'wait-timeouts',
  });
  const sha = 'a'.repeat(40);
  const has = (s: string) => (a: string[]) => a.some((x) => x.includes(s));
  env.fake.on(
    has(`contents/.github/workflows/ci.yml?ref=${sha}`),
    ok({ sha: 'blob1', encoding: 'base64', content: Buffer.from(mixed).toString('base64') }),
  );
  const opts = { gh: env.gh, repo: repoOf('o/r'), path: '.github/workflows/ci.yml', ref: sha, cache };
  const got = await fetchWorkflowTimeouts(opts);
  assert.deepEqual(got, scan);
  await env.clock.advance(30 * 24 * 60 * 60_000);
  assert.deepEqual(await fetchWorkflowTimeouts(opts), scan);
  assert.equal(env.fake.calls.length, 1);
  env.fake.on(has('contents/.github/workflows/gone.yml'), notFound());
  assert.equal(await fetchWorkflowTimeouts({ ...opts, path: '.github/workflows/gone.yml' }), null);
});
