// ci wait --until mergeable (02 §11.2; 03 M6.6): CI settles, then mergeable resolves, then the merge CI
// gate (02 §8.2 rows 6–12, through loadPrStatus with scope ci-gate) decides green, red-shared or red.
// The sim answers REST; the PR snapshot's GraphQL (Q1, mergeable, Q2, commits) is mirrored from it here.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { WaitSummary } from '../../src/schemas/ci.ts';
import { EXIT } from '../contract/exit-table.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { scratchDir } from '../helpers/harness.ts';
import {
  isMergeable,
  isPrCommits,
  isQ1,
  isQ2,
  mergeableReply,
  prCommitsReply,
  q1Pr,
  q1Reply,
  q2Reply,
} from '../unit/pr/snapshot-fixture.ts';
import { GitHubSim, type ProcResultLike, type SimJob, sha, wait } from './ci-wait-world.ts';

const H = sha('a');
const OLD = sha('b');
const MIN = 60_000;

type Merge = [mergeable: string, mergeState: string];

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

const reply = (r: { exitCode: number; stdout: string; stderr: string }): ProcResultLike => ({ status: 200, ...r });

/**
 * The PR snapshot's GraphQL, mirrored from the sim's state at call time: the Q1 rollup carries the sim's
 * check runs for the head (same job, run and workflow ids as REST), and `merge(ms)` gives mergeable.
 */
function mirrorPr(
  sim: GitHubSim,
  merge: (monotonicMs: number) => Merge,
  o: { hide?: string[]; statuses?: unknown[] } = {},
) {
  sim.override(isQ1, () => {
    const st = sim.stateAt();
    const [mergeable, mergeStateStatus] = merge(sim.clock.monotonic());
    const shown = (st.checks[st.pr.head] ?? []).filter((j) => !o.hide?.includes(j.name));
    const contexts = shown.map((j) => {
      const r = sim.checkRun(j) as Record<string, string | null>;
      return {
        __typename: 'CheckRun',
        databaseId: j.id,
        name: j.name,
        status: String(r.status).toUpperCase(),
        conclusion: r.conclusion === null ? null : String(r.conclusion).toUpperCase(),
        startedAt: r.started_at,
        completedAt: r.completed_at,
        detailsUrl: r.html_url,
        isRequired: false,
        checkSuite: {
          app: { slug: 'github-actions' },
          workflowRun: {
            databaseId: j.runId,
            event: 'pull_request',
            file: { path: `.github/workflows/w${j.workflowId ?? 5}.yml` },
            workflow: { databaseId: j.workflowId ?? 5, name: j.workflow ?? 'CI' },
          },
        },
      };
    });
    const pr = q1Pr(
      {
        number: 7,
        url: 'https://github.com/o/r/pull/7',
        headRefName: 'feat/x',
        headRefOid: st.pr.head,
        headRepository: { nameWithOwner: 'o/r' },
        mergeable,
        mergeStateStatus,
      },
      { contexts: [...contexts, ...(o.statuses ?? [])] },
    );
    return reply(q1Reply(pr));
  });
  sim.override(isMergeable, () => {
    const [mergeable, mergeState] = merge(sim.clock.monotonic());
    return reply(mergeableReply(mergeable, { head: sim.stateAt().pr.head, mergeState }));
  });
  sim.override(isQ2, () => reply(q2Reply({ children: { nodes: [] } })));
  sim.override(isPrCommits, () => reply(prCommitsReply([sim.stateAt().pr.head], { head: sim.stateAt().pr.head })));
}

function world(
  jobs: SimJob[],
  o: ConstructorParameters<typeof GitHubSim>[2] = {},
  checks: Record<string, SimJob[]> = {},
) {
  const clock = new FakeClock();
  return new GitHubSim(clock, { pr: { state: 'open', head: H }, checks: { [H]: jobs, ...checks } }, o);
}

const change = (sim: GitHubSim, atMs: number, j: SimJob) =>
  sim.at(atMs, (s) => {
    s.checks[H] = (s.checks[H] ?? []).map((x) => (x.id === j.id ? j : x));
    return s;
  });

test('green: CI settles, the PR is MERGEABLE, the gate passes; exit 0 with merge.ready', async () => {
  const t = running(21, 'test');
  const sim = world([t]);
  change(sim, 4 * MIN, done(t, 4 * MIN));
  mirrorPr(sim, () => ['MERGEABLE', 'CLEAN']);
  const r = await wait(sim, ['o/r#7', '--until', 'mergeable']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const s = WaitSummary.parse(r.json);
  const t0 = s.results[0];
  assert.equal(t0?.outcome, 'green');
  assert.equal(t0?.reason, 'mergeable');
  assert.deepEqual(t0?.merge, { mergeable: 'MERGEABLE', ready: true, blockers: [], waivers: [] });
  assert.ok(t0?.next[0]?.startsWith('ghx pr merge o/r#7'));
  const firstGate = sim.calls.find((c) => isQ1(c.argv));
  assert.ok(firstGate && firstGate.at >= 4 * MIN, 'the gate runs only once CI has settled');
  assert.deepEqual(sim.mutations(), []);
});

/** A config whose only effect is ci.stall.missingMinutes (and, optionally, ci.expected). */
const stallConfig = (missingMinutes: number, expected?: { name: string; workflow: string }[]) => ({
  version: 1,
  components: { x: {} },
  ci: { stall: { missingMinutes }, ...(expected ? { expected } : {}) },
});

test('UNKNOWN after CI settled keeps polling within ci.stall.missingMinutes, then resolves green', async () => {
  const t = running(31, 'test');
  const sim = world([t], { config: stallConfig(20) });
  change(sim, 3 * MIN, done(t, 3 * MIN));
  mirrorPr(sim, (ms) => (ms < 12 * MIN ? ['UNKNOWN', 'UNKNOWN'] : ['MERGEABLE', 'CLEAN']));
  const r = await wait(sim, ['o/r#7', '--until', 'mergeable']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.results[0].outcome, 'green');
  assert.ok(r.json.results[0].elapsedSec >= 12 * 60, `${r.json.results[0].elapsedSec} s`);
  assert.equal(r.json.results[0].merge.mergeable, 'MERGEABLE');
  assert.ok(sim.calls.filter((c) => isQ1(c.argv)).length > 1, 'the gate re-read the PR while UNKNOWN');
});

test('the same UNKNOWN past a shorter ci.stall.missingMinutes ends stalled (mergeable-unknown, exit 14)', async () => {
  const t = running(32, 'test');
  const sim = world([t], { config: stallConfig(5) });
  change(sim, 3 * MIN, done(t, 3 * MIN));
  mirrorPr(sim, (ms) => (ms < 12 * MIN ? ['UNKNOWN', 'UNKNOWN'] : ['MERGEABLE', 'CLEAN']));
  const r = await wait(sim, ['o/r#7', '--until', 'mergeable']);
  assert.equal(r.exitCode, EXIT.CI_STALLED, r.stdout);
  const t0 = WaitSummary.parse(r.json).results[0];
  assert.equal(t0?.outcome, 'stalled');
  assert.equal(t0?.reason, 'mergeable-unknown');
  assert.deepEqual(t0?.stalled, [], 'nothing to rerun');
  assert.deepEqual(t0?.next, ['ghx pr status o/r#7']);
  const sec = t0?.elapsedSec ?? 0;
  assert.ok(sec > 8 * 60 && sec < 12 * 60, `${sec} s: 5 min after the gate saw CI settled at ~3 min`);
});

test('--foreground re-runs keep the gate bound: a stuck UNKNOWN reaches exit 14 across processes', async () => {
  // Each --foreground run returns at 9 min (exit 15), under the default 10 min missingMinutes; the bound
  // must count from the first-settled time an earlier run saved, not restart in every process.
  const t = running(35, 'test');
  const sim = world([t]);
  change(sim, 3 * MIN, done(t, 3 * MIN));
  mirrorPr(sim, () => ['UNKNOWN', 'UNKNOWN']);
  const artifacts = mkdtempSync(join(scratchDir(), 'fg-'));
  const exits: number[] = [];
  for (let i = 0; i < 6 && exits.at(-1) !== EXIT.CI_STALLED; i++) {
    const r = await wait(sim, ['o/r#7', '--until', 'mergeable', '--foreground'], { artifacts });
    exits.push(r.exitCode);
    if (r.exitCode === EXIT.CI_STALLED) {
      assert.equal(r.json.results[0].reason, 'mergeable-unknown');
      assert.deepEqual(r.json.results[0].stalled, []);
    } else {
      assert.equal(r.exitCode, EXIT.CI_PENDING_RESUME, r.stdout);
    }
  }
  assert.deepEqual(exits, [EXIT.CI_PENDING_RESUME, EXIT.CI_STALLED], 'the second run ends it');
  assert.ok(sim.clock.monotonic() < 20 * MIN, `${sim.clock.monotonic() / MIN} min`);
});

test('a check stuck in its own view (queued, no runner) ends the gate stalled: gate-stalled, exit 14', async () => {
  // `deploy` is outside --check and never gets a runner; the wait settles on `lint`, the gate sees `deploy`
  // queued and applies the wait's queued rule (ci.stall.queuedMinutes, 30).
  const lint = running(71, 'lint');
  const deploy: SimJob = { id: 72, runId: 601, name: 'deploy', status: 'queued' };
  const sim = world([lint, deploy]);
  change(sim, 3 * MIN, done(lint, 3 * MIN));
  mirrorPr(sim, () => ['MERGEABLE', 'CLEAN']);
  const r = await wait(sim, ['o/r#7', '--until', 'mergeable', '--check', 'lint']);
  assert.equal(r.exitCode, EXIT.CI_STALLED, r.stdout);
  const t0 = WaitSummary.parse(r.json).results[0];
  assert.equal(t0?.reason, 'gate-stalled');
  assert.deepEqual(
    t0?.stalled.map((x) => [x.name, x.state, x.basis]),
    [['deploy', 'queued', 'ci.stall.queuedMinutes']],
  );
  const sec = t0?.elapsedSec ?? 0;
  assert.ok(sec >= 30 * 60 && sec < 40 * 60, `${sec} s: the queued rule, not open-ended`);
});

test('a ci rerun restarts the gate bound: the clock does not carry over from before the rerun', async () => {
  // Settled at 3 min with UNKNOWN until 8; a rerun runs 8–40; UNKNOWN again 40–43, then MERGEABLE. The
  // old settled time (3 min) used to survive the rerun and stall mergeable-unknown at ~40.4 min.
  const t = running(81, 'test');
  const sim = world([t]);
  change(sim, 3 * MIN, done(t, 3 * MIN));
  sim.at(8 * MIN, (st) => {
    st.checks[H] = [running(82, 'test', { startedAt: 8 * MIN })];
    return st;
  });
  sim.at(40 * MIN, (st) => {
    st.checks[H] = [done(running(82, 'test', { startedAt: 8 * MIN }), 40 * MIN)];
    return st;
  });
  mirrorPr(sim, (ms) =>
    ms < 8 * MIN || (ms >= 40 * MIN && ms < 43 * MIN) ? ['UNKNOWN', 'UNKNOWN'] : ['MERGEABLE', 'CLEAN'],
  );
  const r = await wait(sim, ['o/r#7', '--until', 'mergeable']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.results[0].outcome, 'green');
  assert.ok(r.json.results[0].elapsedSec >= 43 * 60, `${r.json.results[0].elapsedSec} s`);
});

test('an unselected Actions job running past 6 h is left to its own timeout-minutes, not gate-stalled', async () => {
  // A self-hosted job with timeout-minutes above 360 runs 7 h; the gate has no workflow file for it, so it
  // no longer applies the 360 min default to running Actions jobs (GitHub cancels a job at its timeout).
  const lint = running(91, 'lint');
  const soak = running(92, 'soak', { runId: 602 });
  const sim = world([lint, soak]);
  change(sim, 3 * MIN, done(lint, 3 * MIN));
  change(sim, 7 * 60 * MIN, done(soak, 7 * 60 * MIN));
  mirrorPr(sim, () => ['MERGEABLE', 'CLEAN']);
  const r = await wait(sim, ['o/r#7', '--until', 'mergeable', '--check', 'lint'], { maxMs: 9 * 3_600_000 });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.ok(r.json.results[0].elapsedSec >= 7 * 3600, `${r.json.results[0].elapsedSec} s`);
});

test('a commit status pending past 360 min still ends the gate stalled (gate-stalled, exit 14)', async () => {
  const lint = running(95, 'lint');
  const sim = world([lint]);
  change(sim, 3 * MIN, done(lint, 3 * MIN));
  const created = new Date(sim.clock.now()).toISOString();
  const status = {
    __typename: 'StatusContext',
    context: 'deploy/preview',
    state: 'PENDING',
    targetUrl: 'https://ci.example.com/1',
    createdAt: created,
    isRequired: false,
  };
  mirrorPr(sim, () => ['MERGEABLE', 'CLEAN'], { statuses: [status] });
  const r = await wait(sim, ['o/r#7', '--until', 'mergeable'], { maxMs: 9 * 3_600_000 });
  assert.equal(r.exitCode, EXIT.CI_STALLED, r.stdout);
  const t0 = WaitSummary.parse(r.json).results[0];
  assert.equal(t0?.reason, 'gate-stalled');
  assert.deepEqual(
    t0?.stalled.map((x) => [x.name, x.state, x.basis]),
    [['deploy/preview', 'running', 'default-360']],
  );
});

test('an expected check the gate never sees ends stalled (expected-missing, exit 14) past missingMinutes', async () => {
  // REST (the wait) has `test`; the gate's GraphQL rollup never shows it: the gate wiring end to end.
  const t = running(41, 'test');
  const lint = running(42, 'lint');
  const sim = world([t, lint], { config: stallConfig(5, [{ name: 'test', workflow: 'CI' }]) });
  change(sim, 2 * MIN, done(t, 2 * MIN));
  change(sim, 3 * MIN, done(lint, 3 * MIN));
  mirrorPr(sim, () => ['MERGEABLE', 'CLEAN'], { hide: ['test'] });
  const r = await wait(sim, ['o/r#7', '--until', 'mergeable']);
  assert.equal(r.exitCode, EXIT.CI_STALLED, r.stdout);
  const t0 = WaitSummary.parse(r.json).results[0];
  assert.equal(t0?.reason, 'expected-missing');
  assert.deepEqual(
    t0?.stalled.map((x) => [x.name, x.state, x.basis]),
    [['test', 'missing', 'ci.stall.missingMinutes']],
  );
  assert.deepEqual(t0?.merge?.blockers, ['CI_PENDING']);
  assert.ok((t0?.elapsedSec ?? 0) < 12 * 60, `${t0?.elapsedSec} s`);
});

test('--check: an unselected check still running is not a stall; green once it finishes (review finding 2)', async () => {
  const lint = running(51, 'lint');
  const e2e = running(52, 'e2e');
  const sim = world([lint, e2e]);
  change(sim, 3 * MIN, done(lint, 3 * MIN));
  change(sim, 40 * MIN, done(e2e, 40 * MIN));
  mirrorPr(sim, () => ['MERGEABLE', 'CLEAN']);
  const r = await wait(sim, ['o/r#7', '--until', 'mergeable', '--check', 'lint']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.results[0].outcome, 'green');
  assert.ok(r.json.results[0].elapsedSec >= 40 * 60, `${r.json.results[0].elapsedSec} s`);
});

test('red-shared: every failure also fails on main, so the gate waives CI_RED; exit 11 with merge.ready true', async () => {
  const a = running(41, 'unit');
  const failing = 'src/a.test.ts > flaky on main';
  const sim = world([a], {
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
            tests: [failing],
          },
        ],
      },
    ],
  });
  change(sim, 3 * MIN, done(a, 3 * MIN, 'failure', { tests: [failing] }));
  mirrorPr(sim, () => ['MERGEABLE', 'UNSTABLE']);
  const r = await wait(sim, ['o/r#7', '--until', 'mergeable']);
  assert.equal(r.exitCode, EXIT.CI_RED_SHARED, r.stdout);
  const t0 = r.json.results[0];
  assert.equal(t0.outcome, 'red-shared');
  assert.equal(t0.merge.ready, true);
  assert.deepEqual(t0.merge.blockers, []);
  assert.deepEqual(t0.merge.waivers, ['CI_RED']);
});

test('a conflict: green CI but CONFLICTING gives red, with MERGE_CONFLICT in merge.blockers', async () => {
  const t = running(51, 'test');
  const sim = world([t]);
  change(sim, 2 * MIN, done(t, 2 * MIN));
  mirrorPr(sim, () => ['CONFLICTING', 'DIRTY']);
  const r = await wait(sim, ['o/r#7', '--until', 'mergeable']);
  assert.equal(r.exitCode, EXIT.CI_RED, r.stdout);
  const t0 = r.json.results[0];
  assert.equal(t0.outcome, 'red');
  assert.equal(t0.reason, 'merge-blocked');
  assert.equal(t0.ci.state, 'green', 'CI itself is green');
  assert.equal(t0.merge.ready, false);
  assert.deepEqual(t0.merge.blockers, ['MERGE_CONFLICT']);
  assert.deepEqual(t0.next, ['ghx pr status o/r#7']);
  const saved = JSON.parse(
    readFileSync(join(r.artifacts, 'github.com', 'o', 'r', 'ci-wait', `pr-7-${H}.json`), 'utf8'),
  );
  assert.deepEqual(saved.terminal.summary.merge, t0.merge, 'the stored terminal summary carries the gate');
});

test('red CI not shared with main: red with CI_RED, and next points at ci why', async () => {
  const a = running(61, 'unit');
  const sim = world([a]);
  change(sim, 2 * MIN, done(a, 2 * MIN, 'failure'));
  mirrorPr(sim, () => ['MERGEABLE', 'UNSTABLE']);
  const r = await wait(sim, ['o/r#7', '--until', 'mergeable']);
  assert.equal(r.exitCode, EXIT.CI_RED, r.stdout);
  assert.deepEqual(r.json.results[0].merge.blockers, ['CI_RED']);
  assert.deepEqual(r.json.results[0].next, ['ghx ci why o/r#7', 'ghx pr status o/r#7']);
});

test('the gate uses the wait’s aged-out baselines: a missing baseline check does not hold it at CI_PENDING', async () => {
  // OLD (the previous head) ran `e2e`, which never runs on H: the wait ages it out (02 §11.3). H's check
  // reports a completion time ahead of when it was observed, so pr status's own 90 s grace has not passed
  // yet when the gate first runs; only the wait's agedOut lets the gate pass then.
  const t = running(71, 'test');
  const e2e: SimJob = { id: 72, runId: 601, name: 'e2e', status: 'completed', conclusion: 'success', completedAt: 0 };
  const sim = world([t], { prCommits: [OLD, H] }, { [OLD]: [e2e] });
  change(sim, 2 * MIN, done(t, 5 * MIN));
  mirrorPr(sim, () => ['MERGEABLE', 'CLEAN']);
  const r = await wait(sim, ['o/r#7', '--until', 'mergeable']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.ok(r.json.results[0].elapsedSec < 6 * 60, `${r.json.results[0].elapsedSec} s: gated before pr status's grace`);
});

test('--check does not narrow the required set: a required check outside the filter still gates', async () => {
  // `build` is required but never registers. Filtering it out let the wait settle on `lint` and the gate
  // spin at CI_PENDING until the cached required set expired (60 min), when `build` vanished: green.
  const scenario = () => {
    const lint = running(101, 'lint');
    const sim = world([lint], { required: ['build'] });
    change(sim, 3 * MIN, done(lint, 3 * MIN));
    mirrorPr(sim, () => ['MERGEABLE', 'CLEAN']);
    return sim;
  };
  const plain = await wait(scenario(), ['o/r#7', '--until', 'mergeable']);
  const r = await wait(scenario(), ['o/r#7', '--until', 'mergeable', '--check', 'lint']);
  assert.notEqual(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.exitCode, plain.exitCode, r.stdout);
  assert.equal(r.json.results[0].outcome, plain.json.results[0].outcome);
  assert.ok(r.json.results[0].elapsedSec < 30 * 60, `${r.json.results[0].elapsedSec} s: no CI_PENDING spin`);
  assert.ok(r.json.results[0].ci.expectedMissing.includes('build'));
});

test('branch targets are refused with VALIDATION: a branch has no mergeable state', async () => {
  const sim = world([]);
  const r = await wait(sim, ['branch:main', '--until', 'mergeable', '-R', 'o/r']);
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  assert.equal(r.json.error.code, 'VALIDATION');
  assert.equal(sim.calls.length, 0, 'refused before any gh call');
});

test('a re-run on an unchanged PR returns the stored mergeable answer without re-reading the gate', async () => {
  const t = running(81, 'test');
  const sim = world([t]);
  change(sim, 2 * MIN, done(t, 2 * MIN));
  mirrorPr(sim, () => ['MERGEABLE', 'CLEAN']);
  const first = await wait(sim, ['o/r#7', '--until', 'mergeable']);
  assert.equal(first.exitCode, EXIT.OK, first.stdout);
  const gates = sim.calls.filter((c) => isQ1(c.argv)).length;
  const second = await wait(sim, ['o/r#7', '--until', 'mergeable'], { artifacts: first.artifacts });
  assert.equal(second.exitCode, EXIT.OK, second.stdout);
  assert.equal(second.json.resumed, true);
  assert.deepEqual(second.json.results[0].merge, first.json.results[0].merge);
  assert.equal(sim.calls.filter((c) => isQ1(c.argv)).length, gates, 'no gate read');
});

test('a stored merge-blocked red is re-gated on a re-run (an approval can clear it with no new commit)', async () => {
  const t = running(91, 'test');
  const sim = world([t]);
  change(sim, 2 * MIN, done(t, 2 * MIN));
  let blocked = true;
  mirrorPr(sim, () => (blocked ? ['MERGEABLE', 'BLOCKED'] : ['MERGEABLE', 'CLEAN']));
  const first = await wait(sim, ['o/r#7', '--until', 'mergeable']);
  assert.equal(first.exitCode, EXIT.CI_RED, first.stdout);
  assert.deepEqual(first.json.results[0].merge.blockers, ['BLOCKED_BY_PROTECTION']);
  blocked = false;
  const second = await wait(sim, ['o/r#7', '--until', 'mergeable'], { artifacts: first.artifacts });
  assert.equal(second.exitCode, EXIT.OK, second.stdout);
});
