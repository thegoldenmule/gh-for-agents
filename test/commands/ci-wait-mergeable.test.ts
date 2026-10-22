// ci wait --until mergeable (02 §11.2; 03 M6.6): CI settles, then mergeable resolves, then the merge CI
// gate (02 §8.2 rows 6–12, through loadPrStatus with scope ci-gate) decides green, red-shared or red.
// The sim answers REST; the PR snapshot's GraphQL (Q1, mergeable, Q2, commits) is mirrored from it here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { WaitSummary } from '../../src/schemas/ci.ts';
import { EXIT } from '../contract/exit-table.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
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
function mirrorPr(sim: GitHubSim, merge: (monotonicMs: number) => Merge) {
  sim.override(isQ1, () => {
    const st = sim.stateAt();
    const [mergeable, mergeStateStatus] = merge(sim.clock.monotonic());
    const contexts = (st.checks[st.pr.head] ?? []).map((j) => {
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
      { contexts },
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

test('CI settles, then mergeable resolves, then the gate runs: UNKNOWN keeps polling, no deadline', async () => {
  const t = running(31, 'test');
  const sim = world([t]);
  change(sim, 3 * MIN, done(t, 3 * MIN));
  mirrorPr(sim, (ms) => (ms < 12 * MIN ? ['UNKNOWN', 'UNKNOWN'] : ['MERGEABLE', 'CLEAN']));
  const r = await wait(sim, ['o/r#7', '--until', 'mergeable']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.results[0].outcome, 'green');
  assert.ok(r.json.results[0].elapsedSec >= 12 * 60, `${r.json.results[0].elapsedSec} s`);
  assert.equal(r.json.results[0].merge.mergeable, 'MERGEABLE');
  assert.ok(sim.calls.filter((c) => isQ1(c.argv)).length > 1, 'the gate re-read the PR while UNKNOWN');
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
