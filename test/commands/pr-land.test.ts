// ghx pr land (wait until mergeable, then merge pinned to that head): merges on green, never on red CI, a
// moved head or a merge refusal, and returns one JSON outcome whose exit code is the outcome.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { LandSummary } from '../../src/commands/pr/land.ts';
import { EXIT } from '../contract/exit-table.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { fakeGit } from '../helpers/fake-git.ts';
import { runInProcess, scratchDir } from '../helpers/harness.ts';
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
import { drive, endpoint, GitHubSim, type ProcResultLike, type SimJob, sha } from './ci-wait-world.ts';
import { CONFIG } from './pr-status-world.ts';

const H = sha('a');
const NEW = sha('c');
const MC = sha('e');
const MIN = 60_000;

const reply = (r: { exitCode: number; stdout: string; stderr: string }): ProcResultLike => ({ status: 200, ...r });
const isPut = (argv: string[]) => argv.includes('PUT') && endpoint(argv) === 'repos/o/r/pulls/7/merge';

/** The PR snapshot's GraphQL mirrored from the sim (as in ci-wait-mergeable.test.ts), plus the merge PUT. */
function world(o: { merge?: [string, string]; jobs?: SimJob[]; repo?: Record<string, unknown> } = {}) {
  const clock = new FakeClock();
  const t: SimJob = { id: 21, runId: 600, name: 'test', status: 'in_progress', startedAt: 0 };
  const sim = new GitHubSim(
    clock,
    { pr: { state: 'open', head: H }, checks: { [H]: o.jobs ?? [t] } },
    { config: CONFIG },
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
