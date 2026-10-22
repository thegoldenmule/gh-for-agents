// Read-only Actions helpers (src/ci/github.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countWorkflows } from '../../../src/ci/github.ts';
import { ciEnv, notFound, ok, repoOf } from './_helpers.ts';

test('countWorkflows reads total_count from one page of actions/workflows, as a read', async () => {
  const env = ciEnv();
  env.fake.on((a) => a.some((x) => x.startsWith('repos/o/r/actions/workflows')), ok({ total_count: 0, workflows: [] }));
  assert.equal(await countWorkflows({ gh: env.gh, repo: repoOf('o/r') }), 0);
  const argv = env.fake.calls[0]?.argv ?? [];
  assert.ok(
    argv.some((x) => x.includes('per_page=1')),
    argv.join(' '),
  );
  env.fake.expectNoMutations();

  const three = ciEnv();
  three.fake.on(() => true, ok({ total_count: 3, workflows: [{ id: 1 }] }));
  assert.equal(await countWorkflows({ gh: three.gh, repo: repoOf('o/r') }), 3);
});

test('countWorkflows: a missing repo is an error, never a silent 0 that would auto-pass CI_NO_CHECKS', async () => {
  const env = ciEnv();
  env.fake.on(() => true, notFound());
  await assert.rejects(countWorkflows({ gh: env.gh, repo: repoOf('o/r') }));
});
