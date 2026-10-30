// --expect-head (the stale-head race): a wait started right after a push must not judge the old head,
// which GitHub still reports for a few seconds. CI is judged only once the PR's head is the expected
// SHA or has moved past it; the default is the local HEAD when the cwd is on the PR branch and pushed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXPECT_HEAD_DEFAULT_WAIT_MS, EXPECT_HEAD_WAIT_MS } from '../../src/ci/wait/driver.ts';
import { EXIT } from '../contract/exit-table.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { gitCheckout } from '../helpers/fake-git.ts';
import { GitHubSim, type SimJob, type SimOptions, sha, startWait, wait } from './ci-wait-world.ts';

const OLD = sha('a');
const NEW = sha('b');
const MIN = 60_000;

/** The old head is green already; the pushed head reaches the PR at `pushAt` and goes green at `greenAt`. */
function world(o: { pushAt?: number; greenAt?: number; sim?: SimOptions } = {}) {
  const clock = new FakeClock();
  const t: SimJob = { id: 21, runId: 600, name: 'test', status: 'completed', conclusion: 'success', completedAt: 0 };
  const u: SimJob = { id: 22, runId: 601, name: 'test', status: 'in_progress', startedAt: 0 };
  const sim = new GitHubSim(clock, { pr: { state: 'open', head: OLD }, checks: { [OLD]: [t] } }, o.sim);
  const { pushAt, greenAt } = o;
  if (pushAt !== undefined) {
    sim.at(pushAt, (s) => {
      s.pr = { ...s.pr, head: NEW };
      s.checks[NEW] = [{ ...u, startedAt: pushAt }];
      return s;
    });
  }
  if (greenAt !== undefined) {
    sim.at(greenAt, (s) => {
      s.checks[NEW] = [{ ...u, status: 'completed', conclusion: 'success', completedAt: greenAt }];
      return s;
    });
  }
  return { clock, sim };
}

const codes = (r: { json: { warnings?: { code: string }[] } }) => (r.json.warnings ?? []).map((w) => w.code);

test('without it, a wait right after a push returns the old head green at once (the race)', async () => {
  const { sim } = world({ pushAt: 20_000, greenAt: 5 * MIN });
  const r = await wait(sim, ['o/r#7']);
  assert.equal(r.exitCode, EXIT.OK);
  assert.equal(r.json.results[0].headSha, OLD);
});

test('--expect-head <new>: waits for the PR to reach it, then judges CI there', async () => {
  const { sim } = world({ pushAt: 20_000, greenAt: 5 * MIN });
  const r = await wait(sim, ['o/r#7', '--expect-head', NEW.slice(0, 7)]);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.results[0].headSha, NEW);
  assert.ok(r.json.results[0].elapsedSec >= 5 * 60 - 1);
  assert.equal(sim.callsTo(`repos/o/r/commits/${OLD}/check-runs`).length <= 2, true, 'the old head is barely read');
});

test('--expect-head <old> after the head moved past it: binds the new head with EXPECT_HEAD_PASSED', async () => {
  const { sim } = world({ pushAt: 0, greenAt: 3 * MIN, sim: { prCommits: [OLD, NEW] } });
  const r = await wait(sim, ['o/r#7', '--expect-head', OLD]);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.results[0].headSha, NEW);
  assert.ok(codes(r).includes('EXPECT_HEAD_PASSED'), r.stdout);
});

test('--expect-head never seen: superseded, exit 12, after EXPECT_HEAD_WAIT_MS, with pr status next', async () => {
  const { clock, sim } = world();
  const run = startWait(sim, ['o/r#7', '--expect-head', NEW.slice(0, 9)]);
  await clock.advance(EXPECT_HEAD_WAIT_MS - 20_000);
  assert.equal(run.isDone(), false);
  await clock.runUntil(run.isDone, { stepMs: 5_000, maxMs: MIN });
  const r = await run.p;
  assert.equal(r.exitCode, EXIT.SUPERSEDED, r.stdout);
  assert.equal(r.json.results[0].outcome, 'superseded');
  assert.equal(r.json.results[0].reason, 'expect-head-not-seen');
  assert.equal(r.json.results[0].headSha, OLD);
  assert.deepEqual(r.json.results[0].next, ['ghx pr status o/r#7']);
  assert.ok(codes(r).includes('EXPECT_HEAD_NOT_SEEN'));
  assert.equal(sim.callsTo('repos/o/r/pulls/7/commits').length, 1, 'the commits of one head are read once');
});

test('--expect-head takes exactly one PR target; next carries it', async () => {
  const { sim } = world({ pushAt: 0, greenAt: MIN });
  for (const argv of [
    ['o/r#7', 'o/r#8', '--expect-head', NEW.slice(0, 7)],
    ['branch:main', '--expect-head', NEW.slice(0, 7)],
  ]) {
    const r = await wait(sim, argv);
    assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
    assert.equal(r.json.error.code, 'VALIDATION');
  }
  const { sim: s2 } = world({ pushAt: 0 });
  const r = await wait(s2, ['o/r#7', '--expect-head', NEW.slice(0, 7)], { env: { CLAUDE_CODE_SESSION_ATTENDED: '0' } });
  assert.equal(r.exitCode, EXIT.CI_PENDING_RESUME);
  assert.deepEqual(r.json.results[0].next, [`ghx ci wait o/r#7 --expect-head ${NEW.slice(0, 7)}`]);
});

const pushed = (head: string, upstream: string | undefined, branch = 'feat/x') =>
  gitCheckout('o/r', { branch, refs: { HEAD: head, ...(upstream ? { '@{u}': upstream } : {}) } });

test('default: on the PR branch with HEAD pushed, the local HEAD is expected', async () => {
  const { sim } = world({ pushAt: 20_000, greenAt: 5 * MIN });
  const r = await wait(sim, ['7'], { git: pushed(NEW, NEW) });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.results[0].headSha, NEW);
  const nexts: string[] = r.json.results[0].next;
  assert.ok(!nexts.some((n) => n.startsWith('ghx ci wait')), 'green: no re-wait, so the default is never echoed');
});

test('default: origin/<branch> stands in for a missing upstream', async () => {
  const { sim } = world({ pushAt: 20_000, greenAt: 5 * MIN });
  const git = gitCheckout('o/r', { branch: 'feat/x', refs: { HEAD: NEW, 'refs/remotes/origin/feat/x': NEW } });
  const r = await wait(sim, ['o/r#7'], { git });
  assert.equal(r.json.results[0].headSha, NEW, r.stdout);
});

test('no default: HEAD not pushed, another branch, or another repo; the head is judged as it is', async () => {
  for (const git of [
    pushed(NEW, OLD),
    pushed(NEW, NEW, 'other'),
    gitCheckout('x/y', { branch: 'feat/x', refs: { HEAD: NEW, '@{u}': NEW } }),
  ]) {
    const { sim } = world({ pushAt: 20_000, greenAt: 5 * MIN });
    const r = await wait(sim, ['o/r#7'], { git });
    assert.equal(r.exitCode, EXIT.OK, r.stdout);
    assert.equal(r.json.results[0].headSha, OLD);
  }
});

test('default never reached: after EXPECT_HEAD_DEFAULT_WAIT_MS it warns and judges the head as it is', async () => {
  const { sim } = world();
  const r = await wait(sim, ['o/r#7'], { git: pushed(NEW, NEW) });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.results[0].headSha, OLD);
  assert.ok(codes(r).includes('EXPECT_HEAD_DEFAULT_SKIPPED'), r.stdout);
  assert.ok(r.json.results[0].elapsedSec >= EXPECT_HEAD_DEFAULT_WAIT_MS / 1000);
});
