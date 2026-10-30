// --foreground (a subagent's foreground call): ci wait self-returns `pending`, exit 15, after
// FOREGROUND_RETURN_MS, under the Bash tool's 10-minute cap, attended or not; the identical command
// (with --foreground) resumes from the saved state.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FOREGROUND_RETURN_MS } from '../../src/ci/wait/driver.ts';
import { EXIT } from '../contract/exit-table.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { GitHubSim, type SimJob, sha, startWait, wait } from './ci-wait-world.ts';

const H = sha('a');
const MIN = 60_000;

function world() {
  const clock = new FakeClock();
  const t: SimJob = { id: 21, runId: 600, name: 'test', status: 'in_progress', startedAt: 0 };
  const sim = new GitHubSim(clock, { pr: { state: 'open', head: H }, checks: { [H]: [t] } });
  return { clock, sim, t };
}

test('the foreground ceiling is under the Bash tool cap with a minute to spare', () => {
  assert.equal(FOREGROUND_RETURN_MS, 9 * MIN);
  assert.ok(FOREGROUND_RETURN_MS + MIN <= 600_000);
});

for (const attended of ['1', undefined]) {
  test(`--foreground (attended=${String(attended)}): pending, exit 15, at exactly 9 min; next keeps --foreground`, async () => {
    const { clock, sim } = world();
    const run = startWait(sim, ['--foreground', 'o/r#7', '--until', 'settled'], {
      env: { CLAUDE_CODE_SESSION_ATTENDED: attended },
    });
    await clock.advance(FOREGROUND_RETURN_MS - 1_000);
    assert.equal(run.isDone(), false, 'still waiting at 8:59');
    await clock.advance(1_000);
    assert.equal(run.isDone(), true, 'returned at 9:00');
    const r = await run.p;
    assert.equal(r.exitCode, EXIT.CI_PENDING_RESUME, r.stdout);
    assert.equal(r.json.outcome, 'pending');
    assert.equal(r.json.results[0].reason, 'foreground-self-return');
    assert.deepEqual(r.json.results[0].next, ['ghx ci wait o/r#7 --until settled --foreground']);
    const w = (r.json.warnings ?? []).find((x: { code: string }) => x.code === 'WAIT_FOREGROUND_RETURN');
    assert.ok(w, r.stdout);
    assert.match(w.message, /Re-run the identical command/);
    assert.match(w.message, /ghx ci wait o\/r#7 --until settled --foreground/);
  });
}

test('the identical foreground re-run resumes and finishes green', async () => {
  const { sim, t } = world();
  const first = await wait(sim, ['o/r#7', '--foreground']);
  assert.equal(first.exitCode, EXIT.CI_PENDING_RESUME, first.stdout);
  sim.at(12 * MIN, (s) => {
    s.checks[H] = [{ ...t, status: 'completed', conclusion: 'success', completedAt: 12 * MIN }];
    return s;
  });
  const second = await wait(sim, ['o/r#7', '--foreground'], { artifacts: first.artifacts });
  assert.equal(second.exitCode, EXIT.OK, second.stdout);
  assert.equal(second.json.resumed, true);
  assert.equal(second.json.warnings, undefined, 'no foreground warning on a terminal answer');
});

test('a foreground wait that settles first returns its outcome, not pending', async () => {
  const { sim, t } = world();
  sim.at(3 * MIN, (s) => {
    s.checks[H] = [{ ...t, status: 'completed', conclusion: 'success', completedAt: 3 * MIN }];
    return s;
  });
  const r = await wait(sim, ['o/r#7', '--foreground']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.outcome, 'green');
});
