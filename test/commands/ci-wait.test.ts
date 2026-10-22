// ghx ci wait <pr> (02 §11; 03 M4.5, M4.7), in-process on FakeClock against the ETag-aware GitHub sim.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { WaitEvent, WaitSummary } from '../../src/schemas/ci.ts';
import { EXIT } from '../contract/exit-table.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { GitHubSim, type SimJob, type SimState, sha, wait } from './ci-wait-world.ts';

const H = sha('a');
const MIN = 60_000;

const running = (id: number, name: string, o: Partial<SimJob> = {}): SimJob => ({
  id,
  runId: 600,
  name,
  status: 'in_progress',
  startedAt: 0,
  ...o,
});
const done = (j: SimJob, at: number, conclusion = 'success', o: Partial<SimJob> = {}): SimJob => ({
  ...j,
  status: 'completed',
  conclusion,
  completedAt: at,
  ...o,
});

function world(jobs: SimJob[], o: ConstructorParameters<typeof GitHubSim>[2] = {}, extra: Partial<SimState> = {}) {
  const clock = new FakeClock();
  const sim = new GitHubSim(clock, { pr: { state: 'open', head: H }, checks: { [H]: jobs }, ...extra }, o);
  return { clock, sim };
}

/** Replace job `id` on the head from `atMs` on. */
const change = (sim: GitHubSim, atMs: number, j: SimJob) =>
  sim.at(atMs, (s) => {
    s.checks[H] = (s.checks[H] ?? []).map((x) => (x.id === j.id ? j : x));
    return s;
  });

function events(r: { json: { eventsPath: string } }) {
  return readFileSync(r.json.eventsPath, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { type: string; seq: number } & Record<string, unknown>);
}

/** Main push runs whose jobs took `minutes` each (the ETA/stall baseline for `names`). */
function baseline(names: string[], minutes: number, runs = 3) {
  return Array.from({ length: runs }, (_, i) => ({
    id: 900 + i,
    jobs: names.map((name, k) => ({
      id: 9000 + i * 10 + k,
      runId: 900 + i,
      name,
      status: 'completed' as const,
      conclusion: 'success',
      createdAt: -10 * 60 * MIN,
      startedAt: -10 * 60 * MIN,
      completedAt: -10 * 60 * MIN + minutes * MIN,
    })),
  }));
}

test('pending → pass gives green, exit 0; the steady state is all 304s', async () => {
  const t = running(21, 'test');
  const { sim } = world([t]);
  change(sim, 4 * MIN, done(t, 4 * MIN));
  const r = await wait(sim, ['o/r#7']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const s = WaitSummary.parse(r.json);
  assert.equal(s.outcome, 'green');
  assert.equal(s.exitCode, 0);
  assert.equal(s.resumed, false);
  assert.equal(s.results[0]?.ci.state, 'green');
  assert.deepEqual(s.results[0]?.next, ['ghx pr merge o/r#7 --expect-head aaaaaaa --dry-run']);
  const polls = sim.callsTo('repos/o/r/pulls/7');
  assert.ok(polls.length > 3);
  assert.ok(polls.slice(1).every((c) => c.status === 304));
  assert.deepEqual(sim.mutations(), []);
  assert.equal(sim.callsTo(/\/actions\/jobs\//).length, 0, 'green fetches no job or log');
});

test('pending → fail: the summary folds in the diagnosis, exit 10, before the rest settles', async () => {
  const a = running(31, 'unit');
  const b = running(32, 'e2e');
  const { sim } = world([a, b]);
  change(sim, 14 * MIN, done(a, 14 * MIN, 'failure', { tests: ['src/a.test.ts > adds'] }));
  const r = await wait(sim, ['o/r#7']);
  assert.equal(r.exitCode, EXIT.CI_RED, r.stdout);
  const s = WaitSummary.parse(r.json);
  const t = s.results[0];
  assert.equal(s.outcome, 'red');
  assert.equal(t?.reason, 'first-failure');
  assert.equal(t?.ci.phase, 'running', 'e2e is still running');
  assert.deepEqual(t?.ci.failing, [{ name: 'unit', workflow: 'CI', jobId: 31, runId: 600 }]);
  const d = t?.diagnosis?.jobs[0];
  assert.equal(d?.job, 'unit');
  assert.equal(d?.step, 'Run tests');
  assert.deepEqual(d?.tests, ['src/a.test.ts > adds']);
  assert.equal(d?.sameOnMain, 'no-main-run');
  assert.ok(d?.logPath);
  assert.ok(s.diagnosisPath, 'the full diagnosis is on disk');
  const full = JSON.parse(readFileSync(s.diagnosisPath as string, 'utf8'));
  assert.equal(full.diagnoses[0].job.jobId, 31);
  assert.ok(t?.next.includes('ghx ci wait o/r#7'), 'an early red suggests continuing');
  const ev = events(r);
  assert.ok(ev.some((e) => e.type === 'diagnosis'));
  assert.deepEqual(
    ev.map((e) => e.seq),
    ev.map((_, i) => i),
    'gapless seq',
  );
  for (const e of ev.slice(0, -1)) WaitEvent.parse(e);
  assert.equal(ev.at(-1)?.type, 'summary');
  assert.deepEqual(sim.mutations(), []);
});

test('red-shared: the failing test also fails on main, exit 11', async () => {
  const a = running(41, 'unit');
  const t = 'src/a.test.ts > flaky on main';
  const { sim } = world([a], {
    mainRuns: [
      {
        id: 950,
        jobs: [
          {
            id: 9501,
            runId: 950,
            name: 'unit',
            status: 'completed',
            conclusion: 'failure',
            startedAt: -MIN * 60,
            completedAt: -MIN * 50,
            tests: [t],
          },
        ],
      },
    ],
  });
  change(sim, 3 * MIN, done(a, 3 * MIN, 'failure', { tests: [t] }));
  const r = await wait(sim, ['o/r#7']);
  assert.equal(r.exitCode, EXIT.CI_RED_SHARED, r.stdout);
  assert.equal(r.json.outcome, 'red-shared');
  assert.equal(r.json.results[0].diagnosis.jobs[0].sameOnMain, 'same-tests');
  assert.ok(r.json.results[0].next[0].startsWith('ghx pr merge o/r#7'));
});

test('cancelled counts as red', async () => {
  const a = running(51, 'unit');
  const { sim } = world([a]);
  change(sim, 2 * MIN, done(a, 2 * MIN, 'cancelled'));
  const r = await wait(sim, ['o/r#7']);
  assert.equal(r.exitCode, EXIT.CI_RED, r.stdout);
});

test('settled mode waits past the first failure for everything', async () => {
  const a = running(61, 'unit');
  const b = running(62, 'e2e');
  const { sim } = world([a, b]);
  change(sim, 2 * MIN, done(a, 2 * MIN, 'failure'));
  change(sim, 20 * MIN, done(b, 20 * MIN));
  const r = await wait(sim, ['o/r#7', '--until', 'settled']);
  assert.equal(r.exitCode, EXIT.CI_RED, r.stdout);
  assert.equal(r.json.results[0].reason, 'settled');
  assert.ok(r.json.results[0].elapsedSec >= 20 * 60);
  assert.ok(!r.json.results[0].next.includes('ghx ci wait o/r#7 --until settled'));
});

test('a healthy 45-minute CI is followed to the end, with no stall', async () => {
  const names = ['build', 'test'];
  const jobs = names.map((n, i) => running(70 + i, n));
  const { sim } = world(jobs, { mainRuns: baseline(names, 40) });
  change(sim, 30 * MIN, done(jobs[0] as SimJob, 30 * MIN));
  change(sim, 45 * MIN, done(jobs[1] as SimJob, 45 * MIN));
  const r = await wait(sim, ['o/r#7']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const start = events(r).find((e) => e.type === 'start') as unknown as { eta: { seconds: number } | null };
  assert.ok(start.eta && start.eta.seconds > 0, 'the start event carries an ETA from the baseline');
});

test('the first-failure continuation: a re-run on the same SHA stops at the next new failure, not the old one', async () => {
  const a = running(81, 'unit');
  const b = running(82, 'lint');
  const c = running(83, 'e2e');
  const { sim } = world([a, b, c]);
  change(sim, 2 * MIN, done(a, 2 * MIN, 'failure'));
  change(sim, 10 * MIN, done(b, 10 * MIN, 'failure'));
  change(sim, 30 * MIN, done(c, 30 * MIN));
  const first = await wait(sim, ['o/r#7']);
  assert.deepEqual(
    first.json.results[0].ci.failing.map((f: { name: string }) => f.name),
    ['unit'],
  );
  const logsBefore = sim.callsTo(/\/actions\/jobs\/81\/logs$/).length;
  const second = await wait(sim, ['o/r#7'], { artifacts: first.artifacts });
  assert.equal(second.exitCode, EXIT.CI_RED);
  assert.equal(second.json.resumed, true);
  assert.equal(second.json.results[0].reason, 'first-failure');
  assert.deepEqual(
    second.json.results[0].ci.failing.map((f: { name: string }) => f.name),
    ['unit', 'lint'],
  );
  assert.equal(sim.callsTo(/\/actions\/jobs\/81\/logs$/).length, logsBefore, 'unit is not diagnosed again');
  const third = await wait(sim, ['o/r#7'], { artifacts: first.artifacts });
  assert.equal(third.exitCode, EXIT.CI_RED);
  assert.equal(third.json.results[0].reason, 'settled');
});

test('--check limits the considered checks', async () => {
  const a = running(91, 'unit');
  const b = running(92, 'lint');
  const { sim } = world([a, b]);
  change(sim, 2 * MIN, done(b, 2 * MIN, 'failure'));
  change(sim, 5 * MIN, done(a, 5 * MIN));
  const r = await wait(sim, ['o/r#7', '--check', 'unit']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
});

test('--no-diagnose: red without any job or log call', async () => {
  const a = running(95, 'unit');
  const { sim } = world([a]);
  change(sim, MIN, done(a, MIN, 'failure'));
  const r = await wait(sim, ['o/r#7', '--no-diagnose']);
  assert.equal(r.exitCode, EXIT.CI_RED);
  assert.equal(r.json.results[0].diagnosis, null);
  assert.equal(sim.callsTo(/\/actions\/jobs\//).length, 0);
});

// ── Stall rules end to end (02 §11.1, §11.3; 03 M4.5) ─────────────────────
test('stall: running past max(3×p90, p90+15m) of its baseline gives stalled, exit 14', async () => {
  const t = running(101, 'test');
  const { sim } = world([t], { mainRuns: baseline(['test'], 4) });
  const r = await wait(sim, ['o/r#7']);
  assert.equal(r.exitCode, EXIT.CI_STALLED, r.stdout);
  const st = r.json.results[0].stalled[0];
  assert.equal(st.state, 'running');
  assert.equal(st.basis, 'p90+15m');
  assert.equal(st.thresholdSec, 19 * 60);
  assert.ok(r.json.results[0].elapsedSec >= 19 * 60 && r.json.results[0].elapsedSec < 21 * 60);
});

test('stall: a first run with no baseline uses GitHub’s 360-minute default', async () => {
  const t = running(111, 'test');
  const { sim } = world([t]);
  const r = await wait(sim, ['o/r#7'], { stepMs: 60_000 });
  assert.equal(r.exitCode, EXIT.CI_STALLED, r.stdout);
  const st = r.json.results[0].stalled[0];
  assert.equal(st.basis, 'default-360');
  assert.ok(r.json.results[0].elapsedSec >= 360 * 60);
});

test('stall: a first run with a literal timeout-minutes uses it', async () => {
  const t = running(121, 'test');
  const { sim } = world([t]);
  const yaml = 'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    timeout-minutes: 45\n    steps: []\n';
  sim.override(
    (argv) => argv.some((a) => a.startsWith('repos/o/r/contents/.github/workflows/')),
    () => ({
      status: 200,
      exitCode: 0,
      stdout: `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ sha: 'b1', encoding: 'base64', content: Buffer.from(yaml).toString('base64') })}`,
      stderr: '',
    }),
  );
  const r = await wait(sim, ['o/r#7']);
  assert.equal(r.exitCode, EXIT.CI_STALLED, r.stdout);
  assert.equal(r.json.results[0].stalled[0].basis, 'timeout-minutes');
  assert.equal(r.json.results[0].stalled[0].thresholdSec, 45 * 60);
});

test('stall: queued with no runner while nothing else in its run started, past 30 min', async () => {
  const q: SimJob = { id: 131, runId: 610, name: 'deploy', status: 'queued', createdAt: 0 };
  const other: SimJob = { id: 132, runId: 610, name: 'other', status: 'queued', createdAt: 0 };
  const { sim } = world([q, other]);
  const r = await wait(sim, ['o/r#7']);
  assert.equal(r.exitCode, EXIT.CI_STALLED, r.stdout);
  const st = r.json.results[0].stalled.map((s: { name: string; state: string }) => [s.name, s.state]);
  assert.deepEqual(st, [
    ['deploy', 'queued'],
    ['other', 'queued'],
  ]);
  assert.ok(r.json.results[0].elapsedSec >= 30 * 60 && r.json.results[0].elapsedSec < 32 * 60);
});

test('no stall: queued in a run whose sibling is running (a matrix at its concurrency limit)', async () => {
  const q: SimJob = { id: 141, runId: 620, name: 'shard 2', status: 'queued', createdAt: 0 };
  const sib = running(142, 'shard 1', { runId: 620 });
  const { sim } = world([q, sib], { mainRuns: baseline(['shard 1', 'shard 2'], 50) });
  change(sim, 45 * MIN, done(sib, 45 * MIN));
  change(sim, 46 * MIN, { ...q, status: 'in_progress', startedAt: 46 * MIN });
  change(sim, 50 * MIN, done({ ...q, status: 'in_progress', startedAt: 46 * MIN }, 50 * MIN));
  const r = await wait(sim, ['o/r#7']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
});

test('stall: a required check that never registers ends stalled (missing) 10 min after the rest settled', async () => {
  const t = running(151, 'test');
  const { sim } = world([t], { required: ['e2e'] });
  change(sim, 5 * MIN, done(t, 5 * MIN));
  const r = await wait(sim, ['o/r#7']);
  assert.equal(r.exitCode, EXIT.CI_STALLED, r.stdout);
  const st = r.json.results[0].stalled[0];
  assert.equal(st.state, 'missing');
  assert.equal(st.name, 'e2e');
  assert.deepEqual(r.json.results[0].ci.expectedMissing, ['e2e']);
  assert.ok(r.json.results[0].elapsedSec >= 15 * 60 && r.json.results[0].elapsedSec < 17 * 60);
});

test('--stream prints every event and ends with the summary line', async () => {
  const t = running(161, 'test');
  const { sim } = world([t]);
  change(sim, 2 * MIN, done(t, 2 * MIN));
  const r = await wait(sim, ['o/r#7', '--stream']);
  assert.equal(r.exitCode, EXIT.OK);
  const lines = r.lines.map((l) => JSON.parse(l));
  assert.equal(lines[0].type, 'start');
  assert.equal(lines.at(-1).type, 'summary');
  assert.equal(lines.at(-1).outcome, 'green');
});

test('a check on page 2 of check-runs is re-read while page 1 is unchanged (a conditional GET per page)', async () => {
  const jobs = Array.from({ length: 100 }, (_, i) => done(running(1000 + i, `shard ${i}`), 0));
  const last = running(2000, 'shard last');
  const { sim } = world([...jobs, last]);
  change(sim, 3 * MIN, done(last, 3 * MIN));
  const r = await wait(sim, ['o/r#7'], { maxMs: 30 * MIN });
  assert.equal(r.exitCode, EXIT.OK, r.stdout.slice(0, 300));
  assert.ok(r.json.results[0].elapsedSec < 5 * 60);
  const page2 = sim.calls.filter((c) => c.argv.some((a) => a.includes('check-runs') && a.includes('page=2')));
  assert.ok(
    page2.some((c) => c.status === 304),
    'an unchanged page 2 costs a 304',
  );
});

test('one check set: a REST check the GraphQL rollup leaves out (copilot review) is not counted', async () => {
  const t = running(301, 'test');
  const copilot = running(302, 'copilot-pull-request-reviewer', { runId: 650, rollup: false });
  const { sim } = world([t, copilot]);
  change(sim, 3 * MIN, done(t, 3 * MIN));
  const r = await wait(sim, ['o/r#7'], { maxMs: 60 * MIN });
  assert.equal(r.exitCode, EXIT.OK, r.stdout.slice(0, 300));
  assert.equal(r.json.results[0].ci.counts.pass, 1);
  assert.equal(r.json.results[0].ci.counts.pending, 0);
  const lookups = sim.calls.filter((c) => c.argv[1] === 'graphql').length;
  assert.ok(lookups <= 2, `${lookups} GraphQL suite lookups: only when the suites change, plus one confirmation`);
});
