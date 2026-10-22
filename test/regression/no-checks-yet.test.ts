// R04 (03 §5.2): "no checks reported" 11 times (§3.1, §5.2). Zero checks is never green and never a
// timeout: checks that register inside the grace are waited for; none through 120 s is no-checks (13).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubSim, sha, wait } from '../commands/ci-wait-world.ts';
import { EXIT } from '../contract/exit-table.ts';
import { FakeClock } from '../helpers/fake-clock.ts';

const H = sha('a');

test('zero checks until 45 s, then pending, then pass: exit 0, never no-checks', async () => {
  const sim = new GitHubSim(new FakeClock(), { pr: { state: 'open', head: H }, checks: { [H]: [] } });
  const j = { id: 1, runId: 2, name: 'test', status: 'in_progress' as const, startedAt: 45_000 };
  sim.at(45_000, (s) => ({ ...s, checks: { [H]: [j] } }));
  sim.at(300_000, (s) => ({
    ...s,
    checks: { [H]: [{ ...j, status: 'completed', conclusion: 'success', completedAt: 300_000 }] },
  }));
  const r = await wait(sim, ['o/r#7']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.outcome, 'green');
});

test('zero checks through the 120 s grace: no-checks, exit 13, never 0 and never stalled', async () => {
  const sim = new GitHubSim(new FakeClock(), { pr: { state: 'open', head: H }, checks: { [H]: [] } });
  const r = await wait(sim, ['o/r#7'], { stepMs: 1_000 });
  assert.equal(r.exitCode, EXIT.NO_CHECKS, r.stdout);
  assert.equal(r.json.outcome, 'no-checks');
  assert.equal(r.json.results[0].ci.phase, 'registering');
  assert.ok(r.json.results[0].elapsedSec >= 120 && r.json.results[0].elapsedSec < 135);
  assert.deepEqual(r.json.results[0].next, ['ghx ci retrigger o/r#7', 'ghx ci wait o/r#7']);
});

test('only ignored checks registered is still no-checks', async () => {
  const sim = new GitHubSim(
    new FakeClock(),
    {
      pr: { state: 'open', head: H },
      checks: { [H]: [{ id: 1, runId: 2, name: 'notify', status: 'completed', conclusion: 'success' }] },
    },
    { config: { version: 1, components: { core: {} }, ci: { ignore: ['notify'] } } },
  );
  const r = await wait(sim, ['o/r#7'], { stepMs: 1_000 });
  assert.equal(r.exitCode, EXIT.NO_CHECKS, r.stdout);
  assert.equal(r.json.results[0].ci.counts.ignored, 1);
});
