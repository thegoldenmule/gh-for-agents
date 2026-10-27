// The conditional REST poller (03 M4.3, spike §3.1), against the ETag-aware GitHub sim.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normaliseRollup } from '../../src/ci/checks.ts';
import { pollInterval } from '../../src/ci/wait/interval.ts';
import { createPoller, etagKey, type PollerState, TickFailed } from '../../src/ci/wait/poller.ts';
import { seededRandom } from '../../src/core/random.ts';
import { buildApiArgs } from '../../src/gh/api.ts';
import { isMutating } from '../../src/gh/guard.ts';
import { createGh } from '../../src/gh/index.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { forbidden, GitHubSim, header, type SimJob, sha } from './ci-wait-world.ts';

const repo = { host: 'github.com', owner: 'o', name: 'r' };
const H = sha('a');

function setup(jobs: SimJob[], initial?: PollerState) {
  const clock = new FakeClock();
  const sim = new GitHubSim(clock, { pr: { state: 'open', head: H }, checks: { [H]: jobs } });
  const gh = createGh({
    proc: sim.runner(),
    clock,
    signal: new AbortController().signal,
    mode: 'read',
    random: seededRandom(1),
  });
  const poller = createPoller({
    gh,
    repo,
    target: { kind: 'pr', number: 7 },
    now: () => clock.now(),
    ...(initial ? { initial } : {}),
  });
  return { clock, sim, gh, poller };
}

const lint: SimJob = { id: 11, runId: 500, name: 'lint', status: 'completed', conclusion: 'success' };
const test1: SimJob = { id: 12, runId: 500, name: 'test', status: 'in_progress', startedAt: 0 };

test('first tick: four REST reads plus one suite lookup; checks carry their workflow and run', async () => {
  const { sim, poller } = setup([lint, test1]);
  const r = await poller.tick({ sha: null });
  assert.equal(r.source, 'rest');
  assert.equal(r.headSha, H);
  assert.equal(r.sha, H);
  assert.equal(r.pull?.state, 'OPEN');
  assert.equal(r.notModified, false);
  assert.equal(r.calls, 5);
  assert.equal(sim.callsTo('graphql').length, 1, 'the new suite is mapped once via GraphQL');
  const { checks, runs } = normaliseRollup(r.nodes, { repo, headSha: H });
  assert.deepEqual(
    checks.map((c) => [c.name, c.workflow, c.kind, c.runId, c.jobId, c.bucket]),
    [
      ['lint', 'CI', 'actions', 500, 11, 'pass'],
      ['test', 'CI', 'actions', 500, 12, 'pending'],
    ],
  );
  assert.equal(runs['500']?.workflowPath, '.github/workflows/w5.yml');
});

test('an unchanged tick is all 304s: free, cached bodies reused, no second suite lookup', async () => {
  const { sim, gh, poller } = setup([lint, test1]);
  await poller.tick({ sha: null });
  const used = gh.rateBudget('core')?.used;
  const before = sim.calls.length;
  for (let i = 0; i < 3; i++) {
    const r = await poller.tick({ sha: H });
    assert.equal(r.notModified, true);
    assert.equal(r.calls, 4);
    assert.equal(r.nodes.length, 2);
  }
  const later = sim.calls.slice(before);
  assert.equal(later.length, 12);
  assert.ok(
    later.every((c) => c.status === 304 && header(c.argv, 'if-none-match')),
    'every read sent If-None-Match and got 304',
  );
  assert.equal(gh.rateBudget('core')?.used, used, 'a 304 leaves the rate budget unchanged');
  assert.equal(sim.callsTo('graphql').length, 1);
});

test('the ETag rotates when CI changes, and the next read sends the new one', async () => {
  const { clock, sim, poller } = setup([lint, test1]);
  await poller.tick({ sha: null });
  const key = etagKey({
    path: `repos/{owner}/{repo}/commits/${H}/check-runs`,
    fields: { filter: 'latest', per_page: 100 },
  });
  const first = poller.state().etags[key]?.etag;
  sim.at(10_000, (s) => {
    s.checks[H] = [lint, { ...test1, status: 'completed', conclusion: 'failure', completedAt: 9_000 }];
    return s;
  });
  await clock.advance(10_000);
  const r = await poller.tick({ sha: H });
  assert.equal(r.notModified, false);
  const second = poller.state().etags[key]?.etag;
  assert.ok(first && second && first !== second, 'a new ETag is stored');
  await poller.tick({ sha: H });
  const last = sim.callsTo(`repos/o/r/commits/${H}/check-runs`).at(-1);
  assert.equal(header(last?.argv ?? [], 'if-none-match'), second);
  assert.equal(last?.status, 304);
});

test('persisted ETags make the first tick of a new process a 304 tick', async () => {
  const a = setup([lint, test1]);
  await a.poller.tick({ sha: null });
  const saved = JSON.parse(JSON.stringify(a.poller.state())) as PollerState;
  const b = setup([lint, test1], saved);
  const r = await b.poller.tick({ sha: H });
  assert.equal(r.notModified, true);
  assert.equal(r.nodes.length, 2);
  assert.equal(b.sim.callsTo('graphql').length, 0, 'the suite map was restored');
});

test('two consecutive REST failures switch to the GraphQL fallback, which reads rateLimit{}', async () => {
  const { sim, poller } = setup([lint, test1]);
  sim.override(
    (argv) => argv.some((a) => a.includes('/pulls/7')),
    () => forbidden(),
  );
  await assert.rejects(poller.tick({ sha: null }), TickFailed);
  assert.equal(poller.mode, 'rest');
  const r = await poller.tick({ sha: null });
  assert.equal(poller.mode, 'graphql');
  assert.equal(r.source, 'graphql');
  assert.equal(r.headSha, H);
  assert.equal(r.nodes.length, 2);
  assert.equal(r.budget?.resource, 'graphql');
  assert.equal(r.budget?.remaining, 4321);
});

test('the rate budget feeds the interval: under 10% left multiplies it by 4', async () => {
  const { poller } = setup([lint, test1]);
  const r = await poller.tick({ sha: null });
  const random = seededRandom(3);
  const base = { phase: 'running' as const, estimate: null, attended: true, now: 0 };
  const plenty = pollInterval({ ...base, budget: r.budget, random });
  const low = pollInterval({
    ...base,
    budget: r.budget ? { ...r.budget, remaining: 100 } : undefined,
    random: seededRandom(3),
  });
  assert.equal(plenty.rateLimited, false);
  assert.equal(low.rateLimited, true);
  assert.ok(low.ms > plenty.ms * 3, `${low.ms} vs ${plenty.ms}`);
});

test('read guard: a conditional GET with If-None-Match is a read', () => {
  const { args } = buildApiArgs({
    path: 'repos/o/r/commits/abc/check-runs',
    fields: { filter: 'latest', per_page: 100 },
    headers: { 'If-None-Match': 'W/"abc"' },
  });
  assert.equal(isMutating(args), false);
});

test('every poller call is a read', async () => {
  const { sim, poller } = setup([lint, test1]);
  await poller.tick({ sha: null });
  await poller.tick({ sha: H });
  assert.deepEqual(sim.mutations(), []);
});
