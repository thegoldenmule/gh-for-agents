// ghx pr land (wait until mergeable, then merge pinned to that head): merges on green, never on red CI, a
// moved head or a merge refusal, and returns one JSON outcome whose exit code is the outcome.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ciConfigFingerprint } from '../../src/ci/wait/state.ts';
import { LandSummary } from '../../src/commands/pr/land.ts';
import { parseConfigText } from '../../src/config/load.ts';
import { EXIT } from '../contract/exit-table.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { fakeGit } from '../helpers/fake-git.ts';
import { runInProcess, scratchDir } from '../helpers/harness.ts';
import {
  ENQUEUED_AT,
  enqueueReply,
  isEnqueue,
  isMergeable,
  isPrCommits,
  isQ1,
  isQ2,
  isQueueRead,
  mergeableReply,
  prCommitsReply,
  type QueueEntryFixture,
  q1Pr,
  q1Reply,
  q2Reply,
  queueFields,
  queueReadReply,
} from '../unit/pr/snapshot-fixture.ts';
import { drive, endpoint, forbidden, GitHubSim, type ProcResultLike, type SimJob, sha } from './ci-wait-world.ts';
import { httpReply } from './ci-why-world.ts';
import { CONFIG } from './pr-status-world.ts';

const H = sha('a');
const NEW = sha('c');
const MC = sha('e');
const MIN = 60_000;

const reply = (r: { exitCode: number; stdout: string; stderr: string }): ProcResultLike => ({ status: 200, ...r });
const isPut = (argv: string[]) => argv.includes('PUT') && endpoint(argv) === 'repos/o/r/pulls/7/merge';

/** The PR snapshot's GraphQL mirrored from the sim (as in ci-wait-mergeable.test.ts), plus the merge PUT. */
function world(
  o: {
    merge?: [string, string];
    jobs?: SimJob[];
    repo?: Record<string, unknown>;
    /** More Q1 pull request fields, read at each call (the merge queue's). */
    pr?: () => Record<string, unknown>;
    config?: Record<string, unknown>;
  } = {},
) {
  const clock = new FakeClock();
  const t: SimJob = { id: 21, runId: 600, name: 'test', status: 'in_progress', startedAt: 0 };
  const sim = new GitHubSim(
    clock,
    { pr: { state: 'open', head: H }, checks: { [H]: o.jobs ?? [t] } },
    { config: o.config ?? CONFIG },
  );
  const [mergeable, mergeStateStatus] = o.merge ?? ['MERGEABLE', 'CLEAN'];
  sim.override(isQ1, () => {
    const st = sim.stateAt();
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
            file: { path: '.github/workflows/w5.yml' },
            workflow: { databaseId: 5, name: 'CI' },
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
        state: st.pr.merged ? 'MERGED' : 'OPEN',
        mergeable,
        mergeStateStatus,
        ...o.pr?.(),
      },
      { contexts },
    );
    return reply(q1Reply(pr, o.repo));
  });
  sim.override(isMergeable, () =>
    reply(mergeableReply(mergeable, { head: sim.stateAt().pr.head, mergeState: mergeStateStatus })),
  );
  sim.override(isQ2, () => reply(q2Reply({ children: { nodes: [] } })));
  sim.override(isPrCommits, () => reply(prCommitsReply([sim.stateAt().pr.head], { head: sim.stateAt().pr.head })));
  sim.override(isPut, () => {
    sim.at(clock.monotonic(), (s) => ({ ...s, pr: { ...s.pr, state: 'closed', merged: true, mergeCommit: MC } }));
    return {
      status: 200,
      exitCode: 0,
      stdout: JSON.stringify({ sha: MC, merged: true, message: 'merged' }),
      stderr: '',
    };
  });
  return { clock, sim, t };
}

const green = (sim: GitHubSim, t: SimJob, at: number, conclusion = 'success') =>
  sim.at(at, (s) => {
    s.checks[s.pr.head] = [{ ...t, status: 'completed', conclusion, completedAt: at }];
    return s;
  });

async function land(sim: GitHubSim, argv: string[], env: Record<string, string | undefined> = {}) {
  const artifacts = mkdtempSync(join(scratchDir(), 'land-'));
  let done = false;
  const p = runInProcess(['pr', 'land', ...argv], {
    proc: sim.runner(),
    git: fakeGit({}),
    clock: sim.clock,
    env: { GHX_ARTIFACT_DIR: artifacts, CLAUDE_CODE_SESSION_ATTENDED: '1', ...env },
  }).then((r) => {
    done = true;
    return r;
  });
  await drive(sim, () => done, { stepMs: 5_000, maxMs: 2 * 3_600_000 });
  return p;
}

test('green and mergeable: one PUT pinned to the judged head; merged, exit 0', async () => {
  const { sim, t } = world();
  green(sim, t, 4 * MIN);
  const r = await land(sim, ['o/r#7']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const s = LandSummary.parse(r.json);
  assert.equal(s.outcome, 'merged');
  assert.equal(s.headSha, H);
  assert.equal(s.merge?.mergeCommit, MC);
  assert.equal(s.wait?.outcome, 'green');
  assert.equal(s.merge?.headSha, H, 'the merge is pinned to the head the wait judged');
  assert.equal(s.merge?.plan.request.body.sha, H);
  assert.equal(puts(sim), 1);
  assert.equal(s.error, null);
  assert.deepEqual(s.next, s.merge?.next);
});

const puts = (sim: GitHubSim) => sim.calls.filter((c) => isPut(c.argv)).length;

test('issue #2: in a repo that deletes head branches on merge, merge.headBranch says GitHub deleted it', async () => {
  const { sim, t } = world({ repo: { deleteBranchOnMerge: true } });
  sim.override(
    (argv) => endpoint(argv) === 'repos/o/r/git/ref/heads/feat/x',
    () => ({
      status: 404,
      exitCode: 1,
      stdout: httpReply('HTTP/2.0 404 Not Found', '{"message":"Not Found"}'),
      stderr: 'gh: Not Found (HTTP 404)\n',
    }),
  );
  green(sim, t, 4 * MIN);
  const r = await land(sim, ['o/r#7']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const s = LandSummary.parse(r.json);
  assert.equal(s.outcome, 'merged');
  assert.equal(s.merge?.deletedBranch, false);
  assert.deepEqual(s.merge?.headBranch, { state: 'deleted', deletedBy: 'github', autoDelete: true });
});

test('red CI: not merged, exit 10, the diagnosis, ci why next; no PUT', async () => {
  const { sim, t } = world();
  green(sim, t, 3 * MIN, 'failure');
  const r = await land(sim, ['o/r#7']);
  assert.equal(r.exitCode, EXIT.CI_RED, r.stdout);
  const s = LandSummary.parse(r.json);
  assert.equal(s.outcome, 'not-merged');
  assert.equal(s.wait?.outcome, 'red');
  assert.equal(s.merge, null);
  assert.ok(s.next.includes('ghx ci why o/r#7'), JSON.stringify(s.next));
  assert.ok(!s.next.some((n) => n.startsWith('ghx ci wait') || n.startsWith('ghx pr merge')));
  assert.equal(puts(sim), 0);
});

test('the head moves mid-wait: not merged, exit 12, pr status next; no PUT', async () => {
  const { sim, t } = world();
  sim.at(2 * MIN, (s) => {
    s.pr = { ...s.pr, head: NEW };
    s.checks[NEW] = [{ ...t, id: 22, runId: 601 }];
    return s;
  });
  const r = await land(sim, ['o/r#7']);
  assert.equal(r.exitCode, EXIT.SUPERSEDED, r.stdout);
  const s = LandSummary.parse(r.json);
  assert.equal(s.outcome, 'not-merged');
  assert.equal(s.headSha, H);
  assert.deepEqual(s.next, ['ghx pr status o/r#7']);
  assert.equal(puts(sim), 0);
});

test('a conflict: pr merge refuses (MERGE_BLOCKED, exit 9) with its plan as error; no PUT', async () => {
  const { sim, t } = world({ merge: ['CONFLICTING', 'DIRTY'] });
  green(sim, t, 2 * MIN);
  const r = await land(sim, ['o/r#7']);
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  const s = LandSummary.parse(r.json);
  assert.equal(s.outcome, 'not-merged');
  assert.equal(s.reason, 'MERGE_BLOCKED');
  assert.equal(s.error?.code, 'MERGE_BLOCKED');
  assert.deepEqual(s.wait?.merge?.blockers, ['MERGE_CONFLICT']);
  assert.equal(puts(sim), 0);
});

test('a policy refusal (no merge permission): exit 6, the error says which; no PUT', async () => {
  const { sim, t } = world({ repo: { viewerPermission: 'READ' } });
  green(sim, t, 2 * MIN);
  const r = await land(sim, ['o/r#7']);
  assert.equal(r.exitCode, EXIT.POLICY, r.stdout);
  const s = LandSummary.parse(r.json);
  assert.equal(s.error?.code, 'MERGE_BLOCKED');
  assert.match(JSON.stringify(s.error?.details), /NO_MERGE_PERMISSION/);
  assert.equal(puts(sim), 0);
});

test('--dry-run: waits, plans the pinned merge, sends nothing; would-merge', async () => {
  const { sim, t } = world();
  green(sim, t, 2 * MIN);
  const r = await land(sim, ['o/r#7', '--dry-run']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const s = LandSummary.parse(r.json);
  assert.equal(s.outcome, 'would-merge');
  assert.equal(s.plan?.request.body.sha, H);
  assert.deepEqual(s.next, ['ghx pr land o/r#7']);
  assert.deepEqual(sim.mutations(), []);
});

test('--foreground: pending, exit 15 at 9 min; next and the warning name the identical pr land', async () => {
  const { sim } = world();
  const r = await land(sim, ['--foreground', 'o/r#7', '--method', 'merge']);
  assert.equal(r.exitCode, EXIT.CI_PENDING_RESUME, r.stdout);
  const s = LandSummary.parse(r.json);
  assert.equal(s.outcome, 'pending');
  assert.deepEqual(s.next, ['ghx pr land o/r#7 --method merge --foreground']);
  assert.match(JSON.stringify(r.json.warnings), /ghx pr land o\/r#7 --method merge --foreground/);
  assert.equal(puts(sim), 0);
});

test('merged by someone else at the judged head while waiting: already-merged, exit 0, no PUT', async () => {
  const { sim, t } = world();
  sim.at(2 * MIN, (s) => ({
    ...s,
    pr: { ...s.pr, state: 'closed', merged: true, mergeCommit: MC },
    checks: { [H]: [{ ...t, status: 'completed', conclusion: 'success', completedAt: 2 * MIN }] },
  }));
  const r = await land(sim, ['o/r#7']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const s = LandSummary.parse(r.json);
  assert.equal(s.outcome, 'already-merged');
  assert.equal(puts(sim), 0);
});

/** Run one ghx command against the sim with a shared artifact dir (a saved wait state carries over). */
async function runIn(sim: GitHubSim, argv: string[], artifacts: string) {
  let done = false;
  const p = runInProcess(argv, {
    proc: sim.runner(),
    git: fakeGit({}),
    clock: sim.clock,
    env: { GHX_ARTIFACT_DIR: artifacts, CLAUDE_CODE_SESSION_ATTENDED: '1' },
  }).then((r) => {
    done = true;
    return r;
  });
  await drive(sim, () => done, { stepMs: 5_000, maxMs: 2 * 3_600_000 });
  return p;
}

test('tally#27: a wait bound under another ci.expected is re-derived, and a check that never comes stalls (exit 14)', async () => {
  // The wait state is bound from one checkout's config (the PR's worktree); land then runs from a
  // checkout whose ci.expected still names a retired job. It used to settle green on the stored set
  // while the merge gate, re-deriving from its own config, held CI_PENDING forever: a 12 h hang.
  const { sim, t, clock } = world();
  const expected = [{ name: 'test', workflow: 'CI' }];
  sim.o.config = { ...CONFIG, ci: { ...CONFIG.ci, expected } };
  green(sim, t, 2 * MIN);
  const artifacts = mkdtempSync(join(scratchDir(), 'land-'));
  const first = await runIn(sim, ['ci', 'wait', 'o/r#7'], artifacts);
  assert.equal(first.exitCode, EXIT.OK, first.stdout);

  sim.o.config = {
    ...CONFIG,
    ci: { ...CONFIG.ci, expected: [...expected, { name: 'packaging snapshot', workflow: 'CI' }] },
  };
  const startedAt = clock.monotonic();
  const r = await runIn(sim, ['pr', 'land', 'o/r#7'], artifacts);
  assert.equal(r.exitCode, EXIT.CI_STALLED, r.stdout);
  assert.ok(clock.monotonic() - startedAt <= 15 * MIN, 'bounded by ci.stall.missingMinutes, not open-ended');
  const s = LandSummary.parse(r.json);
  assert.equal(s.outcome, 'not-merged');
  assert.equal(s.wait?.outcome, 'stalled');
  assert.deepEqual(
    s.wait?.stalled.map((x) => [x.name, x.state]),
    [['packaging snapshot', 'missing']],
  );
  assert.equal(puts(sim), 0);
  assert.match(JSON.stringify(r.json.warnings), /WAIT_CONFIG_CHANGED/);
  const start = readFileSync(s.eventsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .find((e) => e.type === 'start');
  assert.equal(start?.config?.kind, 'remote', 'the start event names where ci.expected was read');
  assert.ok(start?.expected.some((e: { name: string }) => e.name === 'packaging snapshot'));
});

/** A saved wait (config A expects `test`), then the cwd's config B also expects `packaging snapshot`. */
async function boundUnderA(edit: (state: Record<string, unknown>, b: Record<string, unknown>) => void) {
  const { sim, t, clock } = world();
  const expected = [{ name: 'test', workflow: 'CI' }];
  sim.o.config = { ...CONFIG, ci: { ...CONFIG.ci, expected } };
  green(sim, t, 2 * MIN);
  const artifacts = mkdtempSync(join(scratchDir(), 'land-'));
  const first = await runIn(sim, ['ci', 'wait', 'o/r#7'], artifacts);
  assert.equal(first.exitCode, EXIT.OK, first.stdout);
  const b = {
    ...CONFIG,
    ci: { ...CONFIG.ci, expected: [...expected, { name: 'packaging snapshot', workflow: 'CI' }] },
  };
  sim.o.config = b;
  const file = join(artifacts, 'github.com', 'o', 'r', 'ci-wait', `pr-7-${H}.json`);
  const state = JSON.parse(readFileSync(file, 'utf8'));
  edit(state, b);
  writeFileSync(file, JSON.stringify(state));
  return { sim, clock, artifacts };
}

test('a saved state from before the fingerprint is re-derived, not trusted (review finding 5)', async () => {
  const { sim, artifacts } = await boundUnderA((state) => {
    delete state.configFingerprint;
  });
  const r = await runIn(sim, ['pr', 'land', 'o/r#7'], artifacts);
  assert.equal(r.exitCode, EXIT.CI_STALLED, r.stdout);
  const s = LandSummary.parse(r.json);
  assert.deepEqual(
    s.wait?.stalled.map((x) => x.name),
    ['packaging snapshot'],
  );
  assert.equal(puts(sim), 0);
});

test('land merges on the set its gate judged: the merge does not re-derive one (review finding 5)', async () => {
  // The stored set (without `packaging snapshot`) is the one this config's fingerprint vouches for; the
  // merge used to re-derive from the config, see CI_PENDING and refuse with exit 9 after the gate said ready.
  const { sim, artifacts } = await boundUnderA((state, b) => {
    state.configFingerprint = ciConfigFingerprint(parseConfigText(JSON.stringify(b), { kind: 'default' }).ci);
  });
  const r = await runIn(sim, ['pr', 'land', 'o/r#7'], artifacts);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const s = LandSummary.parse(r.json);
  assert.equal(s.outcome, 'merged');
  assert.equal(puts(sim), 1);
});

test('a required check missing from the bound set is added back at the gate and the merge (re-review item 2)', async () => {
  // The wait bound with the required-check reads failing (as on a private Free repo), so its set has no
  // required checks. When the reads work at land time, `build` is required and never reports: land must
  // not merge on the narrower set.
  const { sim, t } = world();
  let fail = true;
  sim.override(
    (argv) => fail && /\/rules\/branches\/|\/branches\/main$/.test(endpoint(argv) ?? ''),
    () => forbidden(),
  );
  green(sim, t, 2 * MIN);
  const artifacts = mkdtempSync(join(scratchDir(), 'land-'));
  const first = await runIn(sim, ['ci', 'wait', 'o/r#7'], artifacts);
  assert.equal(first.exitCode, EXIT.OK, first.stdout);
  assert.match(JSON.stringify(first.json.warnings), /EXPECTED_CHECKS_PARTIAL/);
  fail = false;
  sim.o.required = ['build'];
  const r = await runIn(sim, ['pr', 'land', 'o/r#7'], artifacts);
  assert.equal(r.exitCode, EXIT.CI_STALLED, r.stdout);
  const s = LandSummary.parse(r.json);
  assert.equal(s.wait?.reason, 'expected-missing');
  assert.deepEqual(
    s.wait?.stalled.map((x) => x.name),
    ['build'],
  );
  assert.equal(puts(sim), 0, 'never merged on the bound set alone');
});

// ── The merge queue ─────────────────────────────────────────────────────────
const REBASE = { ...CONFIG, merge: { method: 'merge', allowedMethods: ['merge', 'rebase'] } };

/**
 * A base branch with a merge queue (rebase). The enqueue mutation puts the PR in the queue; from then on
 * `after(ms since the enqueue)` scripts what the queue does: keep it, merge it, or drop it.
 */
function queueWorld(
  after: (ms: number) => 'queued' | 'limbo' | 'merged' | 'dropped' | 'pushed',
  o: {
    removed?: { reason: string | null; actor: { login: string } | null };
    entry?: QueueEntryFixture | null;
    /** The removal event GitHub shows while the PR is out of the queue but not merged yet. */
    limboRemoved?: { reason: string | null; actor: { login: string } | null };
  } = {},
) {
  const q: { entry: QueueEntryFixture | null; at: number | null; enqueues: number } = {
    entry: o.entry ?? null,
    at: o.entry ? 0 : null,
    enqueues: 0,
  };
  const w = world({ config: REBASE, pr: () => queueFields({ entry: q.entry }) });
  const { sim, clock } = w;
  /** Advance the scripted queue to now. */
  const step = () => {
    if (q.at === null || q.entry === null) return 'out' as const;
    const what = after(clock.monotonic() - q.at);
    if (what === 'merged' && !sim.stateAt().pr.merged) {
      sim.at(clock.monotonic(), (s) => ({ ...s, pr: { ...s.pr, state: 'closed', merged: true, mergeCommit: MC } }));
    }
    if (what === 'pushed' && sim.stateAt().pr.head !== NEW) {
      sim.at(clock.monotonic(), (s) => ({ ...s, pr: { ...s.pr, head: NEW }, checks: { ...s.checks, [NEW]: [] } }));
    }
    if (what !== 'queued' && what !== 'limbo') q.entry = null;
    return what;
  };
  sim.override(isEnqueue, () => {
    q.enqueues++;
    q.entry = { state: 'QUEUED', position: 1 };
    q.at = clock.monotonic();
    return reply(enqueueReply(q.entry));
  });
  sim.override(isQueueRead, () => {
    // limbo: the entry is gone but the PR does not read as merged yet (the two are not updated together).
    const limbo = step() === 'limbo';
    const st = sim.stateAt();
    const removedAt = sim.iso(clock.monotonic()) as string;
    return reply(
      queueReadReply({
        state: st.pr.merged ? 'MERGED' : 'OPEN',
        head: st.pr.head,
        entry: q.entry === null || limbo ? null : { ...q.entry, state: 'AWAITING_CHECKS' },
        mergeCommit: st.pr.merged ? MC : null,
        mergedAt: st.pr.merged ? removedAt : null,
        removed:
          limbo && o.limboRemoved
            ? { createdAt: removedAt, ...o.limboRemoved }
            : q.at !== null && q.entry === null && !st.pr.merged && o.removed
              ? { createdAt: removedAt, ...o.removed }
              : null,
      }),
    );
  });
  return { ...w, q };
}

test('a merge queue: green, enqueued pinned to the judged head, then land waits until the queue has merged it', async () => {
  const { sim, t, q } = queueWorld((ms) => (ms < 3 * MIN ? 'queued' : 'merged'));
  green(sim, t, 2 * MIN);
  const r = await land(sim, ['o/r#7', '--method', 'rebase']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const s = LandSummary.parse(r.json);
  assert.equal(s.outcome, 'merged');
  assert.equal(s.headSha, H);
  assert.equal(s.merge?.merged, true);
  assert.equal(s.merge?.queued, false);
  assert.equal(s.merge?.alreadyMerged, false);
  assert.equal(s.merge?.mergeCommit, MC);
  assert.equal(s.merge?.method, 'rebase');
  assert.equal(s.merge?.queue?.alreadyQueued, false);
  assert.equal(s.merge?.queue?.state, null, 'it left the queue by merging');
  assert.equal(s.merge?.plan.via, 'queue');
  assert.deepEqual(s.merge?.plan.request.body.variables, {
    input: { pullRequestId: queueFields().id, expectedHeadOid: H },
  });
  assert.equal(q.enqueues, 1);
  assert.equal(puts(sim), 0, 'never the REST merge GitHub refuses on a queued branch');
  assert.ok(sim.clock.monotonic() >= 5 * MIN, 'it waited for the queue, not just for the enqueue');
  assert.deepEqual(s.next, [`ghx ci wait branch:main@${MC}`]);
});

test('one read showing the PR open and out of the queue is not a drop: the next read shows it merged', async () => {
  const { sim, t, q } = queueWorld((ms) => (ms < MIN ? 'queued' : ms < MIN + 10_000 ? 'limbo' : 'merged'));
  green(sim, t, 2 * MIN);
  const r = await land(sim, ['o/r#7', '--method', 'rebase']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const s = LandSummary.parse(r.json);
  assert.equal(s.outcome, 'merged');
  assert.equal(s.merge?.mergeCommit, MC);
  assert.equal(q.enqueues, 1);
});

test('GitHub records the removal with reason "merged" before the PR reads as merged: land keeps waiting, then merged', async () => {
  // Seen live: a successful queue merge leaves a RemovedFromMergeQueueEvent (reason "merged") too.
  const { sim, t } = queueWorld((ms) => (ms < MIN ? 'queued' : ms < MIN + 40_000 ? 'limbo' : 'merged'), {
    limboRemoved: { reason: 'merged', actor: null },
  });
  green(sim, t, 2 * MIN);
  const r = await land(sim, ['o/r#7', '--method', 'rebase']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const s = LandSummary.parse(r.json);
  assert.equal(s.outcome, 'merged');
  assert.equal(s.merge?.queue?.enqueuedAt, ENQUEUED_AT, 'when it was queued is kept once merged');
});

test('a merge queue drops the PR: outcome queue-dropped, MERGE_QUEUE_DROPPED (exit 9) with the reason GitHub recorded', async () => {
  const { sim, t, q } = queueWorld((ms) => (ms < 2 * MIN ? 'queued' : 'dropped'), {
    removed: { reason: 'FAILED_CHECKS', actor: { login: 'github-merge-queue' } },
  });
  green(sim, t, 2 * MIN);
  const r = await land(sim, ['o/r#7', '--method', 'rebase']);
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  const s = LandSummary.parse(r.json);
  assert.equal(s.outcome, 'queue-dropped');
  assert.equal(s.reason, 'MERGE_QUEUE_DROPPED');
  assert.equal(s.error?.code, 'MERGE_QUEUE_DROPPED');
  assert.match(
    s.error?.message ?? '',
    /removed from the merge queue by github-merge-queue without merging: FAILED_CHECKS/,
  );
  assert.match(s.error?.hint ?? '', /ghx pr status o\/r#7/);
  assert.equal(s.error?.details?.reason, 'FAILED_CHECKS');
  assert.equal(s.error?.details?.lastState, 'AWAITING_CHECKS');
  assert.equal(s.merge, null);
  assert.deepEqual(s.next, ['ghx pr status o/r#7']);
  assert.equal(q.enqueues, 1);
  assert.equal(puts(sim), 0);
});

test('a push while queued takes the PR out of the queue: HEAD_MOVED (exit 9), not queue-dropped', async () => {
  const { sim, t } = queueWorld((ms) => (ms < MIN ? 'queued' : 'pushed'));
  green(sim, t, 2 * MIN);
  const r = await land(sim, ['o/r#7', '--method', 'rebase']);
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  const s = LandSummary.parse(r.json);
  assert.equal(s.outcome, 'not-merged');
  assert.equal(s.error?.code, 'HEAD_MOVED');
  assert.equal(s.error?.details?.actual, NEW);
});

test('--foreground in the queue: pending (exit 15, in-merge-queue); the identical re-run resumes the wait without a second enqueue', async () => {
  const { sim, t, q } = queueWorld((ms) => (ms < 12 * MIN ? 'queued' : 'merged'));
  green(sim, t, 2 * MIN);
  const artifacts = mkdtempSync(join(scratchDir(), 'land-'));
  const argv = ['pr', 'land', 'o/r#7', '--method', 'rebase', '--foreground'];
  const first = await runIn(sim, argv, artifacts);
  assert.equal(first.exitCode, EXIT.CI_PENDING_RESUME, first.stdout);
  const a = LandSummary.parse(first.json);
  assert.equal(a.outcome, 'pending');
  assert.equal(a.reason, 'in-merge-queue');
  assert.equal(a.merge?.queued, true);
  assert.equal(a.merge?.merged, false);
  assert.equal(a.merge?.queue?.state, 'AWAITING_CHECKS');
  assert.deepEqual(a.next, ['ghx pr land o/r#7 --method rebase --foreground']);
  assert.match(JSON.stringify(first.json.warnings), /WAIT_FOREGROUND_RETURN.*still in the merge queue/);
  assert.ok(sim.clock.monotonic() <= 9 * MIN + 30_000, 'returned under the Bash cap');

  const second = await runIn(sim, argv, artifacts);
  assert.equal(second.exitCode, EXIT.OK, second.stdout);
  const b = LandSummary.parse(second.json);
  assert.equal(b.outcome, 'merged');
  assert.equal(b.merge?.mergeCommit, MC);
  assert.equal(b.merge?.queue?.alreadyQueued, true, 'the re-run found it queued and only waited');
  assert.equal(q.enqueues, 1);
  assert.equal(puts(sim), 0);
});

test('--dry-run with a merge queue: would-queue, the plan is the enqueue, nothing is sent', async () => {
  const { sim, t, q } = queueWorld(() => 'queued');
  green(sim, t, 2 * MIN);
  const r = await land(sim, ['o/r#7', '--method', 'rebase', '--dry-run']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const s = LandSummary.parse(r.json);
  assert.equal(s.outcome, 'would-queue');
  assert.equal(s.plan?.via, 'queue');
  assert.equal(s.plan?.request.method, 'POST');
  assert.deepEqual(s.next, ['ghx pr land o/r#7 --method rebase']);
  assert.equal(q.enqueues, 0);
  assert.deepEqual(sim.mutations(), []);
});

test("a merge queue with another method than the one asked for: MERGE_BLOCKED (exit 6) naming the queue's; nothing sent", async () => {
  const { sim, t, q } = queueWorld(() => 'queued');
  green(sim, t, 2 * MIN);
  const r = await land(sim, ['o/r#7']);
  assert.equal(r.exitCode, EXIT.POLICY, r.stdout);
  const s = LandSummary.parse(r.json);
  assert.equal(s.outcome, 'not-merged');
  assert.equal(s.error?.code, 'MERGE_BLOCKED');
  assert.match(JSON.stringify(s.error?.details), /METHOD_NOT_ALLOWED/);
  assert.match(s.error?.hint ?? '', /--method rebase/);
  assert.equal(q.enqueues, 0);
  assert.equal(puts(sim), 0);
});
