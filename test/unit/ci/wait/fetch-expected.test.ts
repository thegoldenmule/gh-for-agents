import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJsonCache } from '../../../../src/ci/cache.ts';
import {
  branchPath,
  fetchBaseline,
  fetchChangedFiles,
  fetchLastMergedPrHead,
  fetchRequiredSources,
} from '../../../../src/ci/wait/fetch.ts';
import { ciEnv, notFound, ok, repoOf } from '../_helpers.ts';

const repo = repoOf('o/r');
const HEAD = 'a'.repeat(40);
const has = (s: string) => (a: string[]) => a.some((x) => x.includes(s));

test('required sources: ruleset and branch summary unioned; …/protection is never called', async () => {
  const env = ciEnv('ci-wait/required-ruleset');
  const r = await fetchRequiredSources({ gh: env.gh, repo, base: 'main', warn: env.warn });
  assert.deepEqual(r.sources.rules, ['build (ubuntu-latest)', 'lint', 'security/scan']);
  assert.deepEqual(r.sources.branch, ['build (ubuntu-latest)', 'test']);
  assert.equal(r.baseHeadSha, 'c'.repeat(40));
  assert.deepEqual(env.warnings, []);
  env.fake.expectNoCall(has('/protection'));
  env.fake.expectNoMutations();
});

test('required sources: a 404 on rules warns REQUIRED_CHECKS_UNKNOWN and is not an error', async () => {
  const env = ciEnv();
  env.fake.on(has('rules/branches/main'), notFound());
  env.fake.on(has('repos/o/r/branches/main'), ok({ commit: { sha: HEAD }, protected: false }));
  const r = await fetchRequiredSources({ gh: env.gh, repo, base: 'main', warn: env.warn });
  assert.deepEqual(r.sources, { rules: null, branch: [] });
  assert.deepEqual(
    env.warnings.map((w) => w.code),
    ['REQUIRED_CHECKS_UNKNOWN'],
  );
});

test('branch paths keep slashes and encode the rest', () => {
  assert.equal(branchPath('feat/mr-08c'), 'feat/mr-08c');
  assert.equal(branchPath('a b/c#d'), 'a%20b/c%23d');
});

function names(env: ReturnType<typeof ciEnv>, sha: string, runs: string[], statuses: string[] = []) {
  env.fake.on(
    has(`commits/${sha}/check-runs`),
    ok({ total_count: runs.length, check_runs: runs.map((name) => ({ name })) }),
  );
  env.fake.on(
    has(`commits/${sha}/status`),
    ok({ state: 'success', statuses: statuses.map((context) => ({ context })) }),
  );
}

test('baseline: the first previous head with registered checks wins (names = check runs + statuses)', async () => {
  const env = ciEnv();
  names(env, 'p1', []);
  names(env, 'p2', ['build', 'unit'], ['ci/circleci']);
  const b = await fetchBaseline({ gh: env.gh, repo, base: 'main', headSha: HEAD, previousHeads: ['p1', 'p2', 'p3'] });
  assert.deepEqual(b, {
    source: 'previous-head',
    sha: 'p2',
    confidence: 'high',
    names: ['build', 'unit', 'ci/circleci'],
  });
  env.fake.expectNoCall(has('commits/p3/'));
  env.fake.expectNoCall(has('repos/o/r/pulls?'));
});

test('baseline: falls back to the last merged PR, then the base head, and caches the result for 24 h', async () => {
  const env = ciEnv();
  const cache = createJsonCache({ dir: await env.artifacts.pathFor('cache', 'wait-expected', repo), clock: env.clock });
  names(env, 'p1', []);
  env.fake.on(
    has('repos/o/r/pulls?'),
    ok([
      { number: 7, merged_at: '2026-10-21T00:00:00Z', head: { sha: 'self' } },
      { number: 6, merged_at: null, head: { sha: 'closed' } },
      { number: 5, merged_at: '2026-10-20T00:00:00Z', head: { sha: 'm5' } },
    ]),
  );
  names(env, 'm5', []);
  names(env, 'basehead', ['build']);
  const opts = {
    gh: env.gh,
    repo,
    base: 'main',
    headSha: HEAD,
    previousHeads: ['p1'],
    number: 7,
    baseHeadSha: 'basehead',
    cache,
  };
  const b = await fetchBaseline(opts);
  assert.deepEqual(b, { source: 'base-head', sha: 'basehead', confidence: 'low', names: ['build'] });
  const calls = env.fake.calls.length;
  assert.deepEqual(await fetchBaseline(opts), b);
  assert.equal(env.fake.calls.length, calls, 'second lookup is a cache hit');
  await env.clock.advance(24 * 60 * 60_000);
  await fetchBaseline(opts);
  assert.ok(env.fake.calls.length > calls, 'expired after 24 h');
});

test('last merged PR skips the PR itself and unmerged PRs; none gives null', async () => {
  const env = ciEnv();
  env.fake.on(has('repos/o/r/pulls?'), ok([{ number: 3, merged_at: null, head: { sha: 'x' } }]));
  assert.equal(await fetchLastMergedPrHead({ gh: env.gh, repo, base: 'main' }), null);
});

test('changed files include both names of a rename', async () => {
  const env = ciEnv();
  env.fake.on(
    has('pulls/9/files'),
    ok([{ filename: 'src/new.ts', previous_filename: 'src/old.ts' }, { filename: 'README.md' }]),
  );
  assert.deepEqual(await fetchChangedFiles({ gh: env.gh, repo, number: 9 }), ['src/new.ts', 'src/old.ts', 'README.md']);
});
