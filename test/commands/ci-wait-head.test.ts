// Head binding and branch targets (02 §11.5; 03 M4.8): a moved head never mixes SHAs.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { headPolicy, parseWaitTarget, targetKey } from '../../src/ci/wait/targets.ts';
import { EXIT } from '../contract/exit-table.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { GitHubSim, type SimJob, sha, wait } from './ci-wait-world.ts';

const H = sha('a');
const H2 = sha('b');
const MIN = 60_000;
const job = (id: number, o: Partial<SimJob> = {}): SimJob => ({
  id,
  runId: id * 10,
  name: 'test',
  status: 'in_progress',
  startedAt: 0,
  ...o,
});

const events = (path: string) =>
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

function moved(sim: GitHubSim, at: number, checksOnNew: SimJob[]) {
  sim.at(at, (s) => ({ ...s, pr: { ...s.pr, head: H2 }, checks: { ...s.checks, [H2]: checksOnNew } }));
}

test('restart (PR default): head-changed, re-bind under a new state key, per-check state and grace reset', async () => {
  const sim = new GitHubSim(new FakeClock(), { pr: { state: 'open', head: H }, checks: { [H]: [job(1)] } });
  moved(sim, 5 * MIN, []);
  // The new head registers nothing: no-checks comes 120 s after the re-bind, not after the start.
  const r = await wait(sim, ['o/r#7'], { stepMs: 1_000 });
  assert.equal(r.exitCode, EXIT.NO_CHECKS, r.stdout);
  const t = r.json.results[0];
  assert.equal(t.headSha, H2);
  assert.equal(t.restarts, 1);
  assert.ok(t.elapsedSec >= 5 * 60 + 120, `elapsed ${t.elapsedSec}`);
  const ev = events(r.json.eventsPath);
  const hc = ev.find((e) => e.type === 'head-changed');
  assert.deepEqual([hc?.from, hc?.to, hc?.action], [H, H2, 'restart']);
  assert.deepEqual(
    ev.filter((e) => e.type === 'start').map((e) => e.headSha),
    [H, H2],
  );
  assert.ok(
    ev.filter((e) => 'headSha' in e && e.type !== 'start').every((e) => e.headSha === H || e.headSha === H2),
    'every event carries its headSha',
  );
  const files = readdirSync(join(r.artifacts, 'github.com', 'o', 'r', 'ci-wait'));
  assert.ok(files.includes(`pr-7-${H}.json`) && files.includes(`pr-7-${H2}.json`));
});

test('restart: the new head’s CI decides the outcome', async () => {
  const sim = new GitHubSim(new FakeClock(), { pr: { state: 'open', head: H }, checks: { [H]: [job(1)] } });
  moved(sim, 2 * MIN, [job(2, { status: 'completed', conclusion: 'success', completedAt: 2 * MIN })]);
  const r = await wait(sim, ['o/r#7']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.results[0].headSha, H2);
});

test('--on-head-change stop: superseded, exit 12', async () => {
  const sim = new GitHubSim(new FakeClock(), { pr: { state: 'open', head: H }, checks: { [H]: [job(1)] } });
  moved(sim, 2 * MIN, [job(2)]);
  const r = await wait(sim, ['o/r#7', '--on-head-change', 'stop']);
  assert.equal(r.exitCode, EXIT.SUPERSEDED, r.stdout);
  assert.equal(r.json.outcome, 'superseded');
  assert.equal(r.json.results[0].headSha, H);
  assert.deepEqual(r.json.results[0].next, ['ghx pr status o/r#7']);
});

test('--on-head-change stay on a PR keeps the bound SHA and emits branch-advanced once', async () => {
  const sim = new GitHubSim(new FakeClock(), { pr: { state: 'open', head: H }, checks: { [H]: [job(1)] } });
  moved(sim, 2 * MIN, [job(2)]);
  sim.at(6 * MIN, (s) => ({
    ...s,
    checks: { ...s.checks, [H]: [job(1, { status: 'completed', conclusion: 'success', completedAt: 6 * MIN })] },
  }));
  const r = await wait(sim, ['o/r#7', '--on-head-change', 'stay']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.results[0].headSha, H);
  assert.equal(events(r.json.eventsPath).filter((e) => e.type === 'branch-advanced').length, 1);
});

for (const merged of [false, true]) {
  test(`a PR ${merged ? 'merged' : 'closed'} mid-wait ends closed, exit 12`, async () => {
    const sim = new GitHubSim(new FakeClock(), { pr: { state: 'open', head: H }, checks: { [H]: [job(1)] } });
    sim.at(3 * MIN, (s) => ({ ...s, pr: { ...s.pr, state: 'closed', merged } }));
    const r = await wait(sim, ['o/r#7']);
    assert.equal(r.exitCode, EXIT.SUPERSEDED, r.stdout);
    assert.equal(r.json.outcome, 'closed');
    assert.equal(r.json.results[0].reason, merged ? 'merged' : 'closed');
  });
}

test('branch:<name> binds the head at start, emits branch-advanced, and keeps the bound SHA', async () => {
  const sim = new GitHubSim(new FakeClock(), {
    pr: { state: 'open', head: sha('f') },
    branches: { main: H },
    checks: { [H]: [job(1)] },
  });
  sim.at(2 * MIN, (s) => ({ ...s, branches: { main: H2 }, checks: { ...s.checks, [H2]: [job(2)] } }));
  sim.at(8 * MIN, (s) => ({
    ...s,
    checks: { ...s.checks, [H]: [job(1, { status: 'completed', conclusion: 'success', completedAt: 8 * MIN })] },
  }));
  const r = await wait(sim, ['branch:main', '-R', 'o/r']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const t = r.json.results[0];
  assert.equal(t.target, 'branch:main');
  assert.equal(t.headSha, H);
  assert.equal(t.restarts, 0);
  const adv = events(r.json.eventsPath).filter((e) => e.type === 'branch-advanced');
  assert.deepEqual(
    adv.map((e) => [e.boundSha, e.branchHead]),
    [[H, H2]],
  );
  assert.deepEqual(t.next, [], 'no merge or rerun suggestions for a branch');
  assert.equal(sim.callsTo(/\/pulls\//).length, 0, 'a branch target never reads a PR');
});

test('branch:<name>@<short sha> binds that commit (resolved to the full SHA), whatever the branch head', async () => {
  const sim = new GitHubSim(new FakeClock(), {
    pr: { state: 'open', head: sha('f') },
    branches: { main: H2 },
    checks: { [H]: [job(1, { status: 'completed', conclusion: 'failure', completedAt: 0 })], [H2]: [job(2)] },
  });
  const r = await wait(sim, [`branch:main@${H.slice(0, 7)}`, '-R', 'o/r']);
  assert.equal(r.exitCode, EXIT.CI_RED, r.stdout);
  assert.equal(r.json.results[0].headSha, H);
  assert.equal(r.json.results[0].target, `branch:main@${H.slice(0, 7)}`);
});

test('target parsing, keys and default head policies', () => {
  assert.deepEqual(parseWaitTarget('branch:release/1.2@9f2c4e1'), {
    kind: 'branch',
    raw: 'branch:release/1.2@9f2c4e1',
    branch: 'release/1.2',
    sha: '9f2c4e1',
  });
  assert.equal(parseWaitTarget('branch:user@host').kind, 'branch');
  assert.equal((parseWaitTarget('branch:user@host') as { branch: string }).branch, 'user@host');
  assert.equal(targetKey(parseWaitTarget('o/r#12')), 'pr-12');
  assert.throws(() => parseWaitTarget('branch:'), /not a ci wait target/);
  assert.throws(() => parseWaitTarget('https://github.com/o/r/actions/runs/5'), /not a ci wait target/);
  assert.equal(headPolicy(parseWaitTarget('12'), undefined), 'restart');
  assert.equal(headPolicy(parseWaitTarget('branch:main'), undefined), 'stay');
  assert.equal(headPolicy(parseWaitTarget('branch:main@9f2c4e1'), 'restart'), 'stay');
  assert.equal(headPolicy(parseWaitTarget('12'), 'stop'), 'stop');
});
