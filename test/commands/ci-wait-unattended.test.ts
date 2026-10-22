// Unattended self-return (02 §11.1; 03 M4.7): with CLAUDE_CODE_SESSION_ATTENDED unset (or anything
// but "1"), ci wait returns `pending`, exit 15, after exactly 25 min of waiting, state saved.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT } from '../contract/exit-table.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { endpoint, GitHubSim, type SimJob, sha, startWait, wait } from './ci-wait-world.ts';

const H = sha('a');
const MIN = 60_000;
const UNSET = { CLAUDE_CODE_SESSION_ATTENDED: undefined };

function world() {
  const clock = new FakeClock();
  const t: SimJob = { id: 21, runId: 600, name: 'test', status: 'in_progress', startedAt: 0 };
  const sim = new GitHubSim(clock, { pr: { state: 'open', head: H }, checks: { [H]: [t] } });
  return { clock, sim, t };
}

test('env unset: pending, exit 15, at exactly 25 fake minutes (not at 24:59), next = the identical command', async () => {
  const { clock, sim } = world();
  const run = startWait(sim, ['o/r#7', '--until', 'settled'], { env: UNSET });
  await clock.advance(25 * MIN - 1_000);
  assert.equal(run.isDone(), false, 'still waiting at 24:59');
  await clock.advance(1_000);
  assert.equal(run.isDone(), true, 'returned at 25:00');
  const r = await run.p;
  assert.equal(r.exitCode, EXIT.CI_PENDING_RESUME, r.stdout);
  assert.equal(r.json.outcome, 'pending');
  assert.equal(r.json.results[0].reason, 'unattended-self-return');
  assert.deepEqual(r.json.results[0].next, ['ghx ci wait o/r#7 --until settled']);
});

for (const value of ['0', 'true', '']) {
  test(`CLAUDE_CODE_SESSION_ATTENDED=${JSON.stringify(value)} counts as unattended`, async () => {
    const { sim } = world();
    const r = await wait(sim, ['o/r#7'], { env: { CLAUDE_CODE_SESSION_ATTENDED: value } });
    assert.equal(r.exitCode, EXIT.CI_PENDING_RESUME, r.stdout);
  });
}

test('CLAUDE_CODE_SESSION_ATTENDED=1: no self-imposed limit; a 90-minute CI runs to green', async () => {
  const { sim, t } = world();
  sim.at(90 * MIN, (s) => {
    s.checks[H] = [{ ...t, status: 'completed', conclusion: 'success', completedAt: 90 * MIN }];
    return s;
  });
  const r = await wait(sim, ['o/r#7'], { env: { CLAUDE_CODE_SESSION_ATTENDED: '1' } });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.ok(r.json.results[0].elapsedSec >= 90 * 60);
});

test('an unattended session never polls faster than every 30 s', async () => {
  const { sim } = world();
  await wait(sim, ['o/r#7'], { env: UNSET });
  const polls = sim.callsTo('repos/o/r/pulls/7').map((c) => c.at);
  const gaps = polls.slice(1).map((at, i) => at - (polls[i] as number));
  assert.ok(gaps.length > 10);
  assert.ok(
    gaps.every((g) => g >= 30_000),
    `gaps: ${gaps.join(',')}`,
  );
});

test('pending, then the identical re-run resumes with no repeated baseline calls', async () => {
  const { sim, t } = world();
  const first = await wait(sim, ['o/r#7'], { env: UNSET });
  assert.equal(first.exitCode, EXIT.CI_PENDING_RESUME);
  sim.at(30 * MIN, (s) => {
    s.checks[H] = [{ ...t, status: 'completed', conclusion: 'success', completedAt: 30 * MIN }];
    return s;
  });
  const n = sim.calls.length;
  const second = await wait(sim, ['o/r#7'], { env: UNSET, artifacts: first.artifacts });
  assert.equal(second.exitCode, EXIT.OK, second.stdout);
  assert.equal(second.json.resumed, true);
  const later = sim.calls.slice(n);
  const baselineish = later.filter((c) =>
    /\/rules\/branches\/|\/branches\/main$|\/pulls\/7\/commits|\/actions\/workflows\/|\/pulls$/.test(
      c.argv.find((a) => a.startsWith('repos/'))?.split('?')[0] ?? '',
    ),
  );
  assert.deepEqual(
    baselineish.map((c) => c.argv.join(' ')),
    [],
  );
  const firstPoll = later.find((c) => c.argv.some((a) => a.startsWith('repos/o/r/pulls/7')));
  assert.equal(firstPoll?.status, 304, 'the first poll of the re-run uses the stored ETag');
});

test('self-return with a target that never bound (rate limited from the start): pending for both, exit 15', async () => {
  const clock = new FakeClock();
  const H1 = sha('1');
  const sim = new GitHubSim(
    clock,
    {
      pr: { state: 'open', head: H1 },
      prs: { 2: { state: 'open', head: sha('2') } },
      checks: { [H1]: [{ id: 11, runId: 110, name: 'test', status: 'in_progress', startedAt: 0 }] },
    },
    { number: 1 },
  );
  sim.override(
    (argv) => endpoint(argv) === 'repos/o/r/pulls/2',
    () => ({
      status: 403,
      exitCode: 1,
      stdout: 'HTTP/2.0 403 Forbidden\r\nContent-Type: application/json\r\n\r\n{"message":"API rate limit exceeded"}',
      stderr: 'gh: API rate limit exceeded for user (HTTP 403)\n',
    }),
  );
  const r = await wait(sim, ['o/r#1', 'o/r#2'], {
    env: { CLAUDE_CODE_SESSION_ATTENDED: undefined },
    maxMs: 40 * 60_000,
  });
  assert.equal(r.exitCode, EXIT.CI_PENDING_RESUME, r.stdout.slice(0, 400));
  assert.deepEqual(
    r.json.results.map((t: { target: string; outcome: string }) => [t.target, t.outcome]),
    [
      ['o/r#1', 'pending'],
      ['o/r#2', 'pending'],
    ],
  );
  assert.equal(r.json.results[1].headSha, null, 'never bound: no head SHA');
});
