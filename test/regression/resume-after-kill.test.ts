// R21 (03 §5.2): background waits get killed (a subagent ending, the documented 30-minute `-p` cap,
// Monitor's expiry). The identical re-run makes no repeated baseline or diagnosis calls, and a re-run
// after a terminal state makes one conditional head check (plus the CI reads, all 304) and returns.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createShutdown } from '../../src/core/signals.ts';
import { GitHubSim, type SimJob, sha, startWait, wait } from '../commands/ci-wait-world.ts';
import { EXIT } from '../contract/exit-table.ts';
import { FakeClock } from '../helpers/fake-clock.ts';

const H = sha('a');
const MIN = 60_000;

test('killed mid-wait, re-run, then re-run again after the terminal state', async () => {
  const clock = new FakeClock();
  const a: SimJob = { id: 31, runId: 600, name: 'unit', status: 'in_progress', startedAt: 0 };
  const b: SimJob = { id: 32, runId: 600, name: 'e2e', status: 'in_progress', startedAt: 0 };
  const sim = new GitHubSim(clock, { pr: { state: 'open', head: H }, checks: { [H]: [a, b] } });
  const red = { ...a, status: 'completed' as const, conclusion: 'failure', completedAt: 3 * MIN };
  sim.at(3 * MIN, (s) => ({ ...s, checks: { [H]: [red, b] } }));
  sim.at(20 * MIN, (s) => ({
    ...s,
    checks: { [H]: [red, { ...b, status: 'completed', conclusion: 'success', completedAt: 20 * MIN }] },
  }));

  const shutdown = createShutdown();
  const run1 = startWait(sim, ['o/r#7', '--until', 'settled'], { shutdown });
  await clock.advance(10 * MIN);
  shutdown.trigger('SIGTERM');
  await clock.runUntil(run1.isDone, { maxMs: 10_000 });
  assert.equal((await run1.p).json.outcome, 'interrupted');
  const setupCalls = () =>
    sim.calls.filter((c) =>
      /\/pulls\/7\/commits|\/rules\/|\/actions\/(?!runs\?head_sha=[0-9a-f]{40}&per_page=100\b)/.test(c.argv.join(' ')),
    ).length;
  const before = setupCalls();

  const r2 = await wait(sim, ['o/r#7', '--until', 'settled'], { artifacts: run1.artifacts });
  assert.equal(r2.exitCode, EXIT.CI_RED, r2.stdout);
  assert.equal(r2.json.resumed, true);
  assert.equal(setupCalls(), before, 'no repeated baseline or diagnosis calls');

  const n = sim.calls.length;
  const r3 = await wait(sim, ['o/r#7', '--until', 'settled'], { artifacts: run1.artifacts });
  assert.equal(r3.exitCode, EXIT.CI_RED);
  const polls = sim.calls.slice(n).filter((c) => !c.argv.join(' ').includes('/contents/'));
  assert.equal(polls.length, 4, "one tick: the PR, check runs, status and the head's runs");
  assert.ok(polls.every((c) => c.status === 304));
});
