import assert from 'node:assert/strict';
import { test } from 'node:test';
import { repoCache } from '../../../../src/ci/cache.ts';
import { fetchEtaStats } from '../../../../src/ci/wait/fetch.ts';
import { ciEnv, ok, repoOf } from '../_helpers.ts';
import { at, job } from './_data.ts';

const repo = repoOf('o/r');
const has = (s: string) => (a: string[]) => a.some((x) => x.includes(s));
const done = (id: number, name: string, mins: number) =>
  job(id, name, {
    status: 'completed',
    conclusion: 'success',
    created_at: at(0),
    started_at: at(1),
    completed_at: at(1 + mins),
  });

function setup() {
  const env = ciEnv();
  env.fake.on(
    (a) => a.some((x) => x.startsWith('repos/o/r/actions/workflows/5/runs?') && x.includes('event=push')),
    ok({ total_count: 4, workflow_runs: [{ id: 101 }, { id: 102 }, { id: 103 }, { id: 104 }] }),
  );
  env.fake.on(
    (a) => a.some((x) => x.startsWith('repos/o/r/actions/workflows/5/runs?') && x.includes('event=pull_request')),
    ok({
      total_count: 2,
      workflow_runs: [
        { id: 201, pull_requests: [{ base: { ref: 'release' } }] },
        { id: 202, pull_requests: [{ base: { ref: 'main' } }] },
      ],
    }),
  );
  for (const [id, mins] of [
    [101, 4],
    [102, 6],
    [103, 5],
  ] as const) {
    env.fake.on(has(`actions/runs/${id}/jobs`), ok({ total_count: 1, jobs: [done(id * 10, 'build', mins)] }));
  }
  env.fake.on(has('actions/runs/202/jobs'), ok({ total_count: 1, jobs: [done(2020, 'e2e', 12)] }));
  return env;
}

test('push runs on the base give the stats; only the newest 3 runs are sampled', async () => {
  const env = setup();
  const stats = await fetchEtaStats({ gh: env.gh, repo, base: 'main', workflowId: 5, jobNames: ['build'] });
  assert.deepEqual(stats, {
    build: { samples: 3, medianSec: 300, p90Sec: 348, queueMedianSec: 60, source: 'push' },
  });
  env.fake.expectCalls([has('event=push&status=success'), has('branch=main')]);
  env.fake.expectNoCall(has('actions/runs/104/jobs'));
  env.fake.expectNoCall(has('event=pull_request'));
});

test('a job missing from push runs falls back to pull_request runs into the base; cached 24 h on FakeClock', async () => {
  const env = setup();
  const cache = await repoCache({ artifacts: env.artifacts, repo, clock: env.clock, ns: 'wait-eta' });
  const opts = { gh: env.gh, repo, base: 'main', workflowId: 5, jobNames: ['build', 'e2e'], cache };
  const stats = await fetchEtaStats(opts);
  assert.equal(stats.e2e?.source, 'pull_request');
  assert.equal(stats.e2e?.medianSec, 720);
  env.fake.expectNoCall(has('actions/runs/201/jobs'));
  const calls = env.fake.calls.length;
  await env.clock.advance(23 * 60 * 60_000);
  assert.deepEqual(await fetchEtaStats(opts), stats);
  assert.equal(env.fake.calls.length, calls, 'a cache hit within 24 h');
  await env.clock.advance(60 * 60_000);
  await fetchEtaStats(opts);
  assert.ok(env.fake.calls.length > calls, 'refetched after 24 h');
  env.fake.expectNoMutations();
});
