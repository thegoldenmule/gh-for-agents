// Resume after SIGKILL (02 §11.1; R21 end to end): the real bin is killed mid-wait with no chance to
// clean up, and the identical re-run resumes from the state on disk: `resumed: true`, its first polls are
// conditional (the stored ETags), and no baseline, expected-set, ETA or diagnosis call is repeated.
// The scenario is recorded from two in-process runs on the sim (run 2's conditional GETs carry
// If-None-Match, a different fake-gh key from run 1's), so the spawned runs replay exactly those replies.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createShutdown } from '../../src/core/signals.ts';
import { type Recorded, recordingRunner, writeScenario } from '../commands/ci-wait-record.ts';
import { drive, GitHubSim, type SimState, sha, startWait } from '../commands/ci-wait-world.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { scratchDir } from '../helpers/harness.ts';
import { spawnGhx } from '../helpers/spawn.ts';
import { dirs } from './ci-wait-scenario.ts';
import { EXIT } from './exit-table.ts';

const H = sha('a');
const ARGV = ['o/r#7', '--until', 'settled'];
/** Calls a resumed run must not repeat: PR commits (baseline), rules/branches (expected set), Actions. */
const SETUP = /\/pulls\/7\/commits|\/rules\/|\/branches\/|\/actions\//;

const state = (): SimState => ({
  pr: { state: 'open', head: H },
  checks: {
    [H]: [
      { id: 31, runId: 600, name: 'unit', status: 'completed', conclusion: 'failure', completedAt: 0 },
      { id: 32, runId: 600, name: 'e2e', status: 'in_progress', startedAt: 0 },
    ],
  },
});

/** One in-process run's first tick (diagnosis included), then SIGTERM so the lock is released. */
async function recordRun(sim: GitHubSim, artifacts: string, rec: Recorded[]): Promise<void> {
  const shutdown = createShutdown();
  const run = startWait(sim, ARGV, { proc: recordingRunner(sim, rec), artifacts, shutdown });
  await drive(sim, () => false, { stepMs: 5_000, maxMs: 5_000 }).catch(() => {});
  shutdown.trigger('SIGTERM');
  await drive(sim, run.isDone, { maxMs: 10_000 });
}

const logLines = (path: string) =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

async function waitForCalls(path: string, n: number, timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now();
  while (logLines(path).length < n) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`only ${logLines(path).length}/${n} gh calls logged`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ~3 s: two spawned runs, each replaying its calls through fake-gh processes.
test('SIGKILL mid-wait, then the identical command resumes with no repeated baseline or diagnosis calls', {
  timeout: 60_000,
}, async () => {
  const sim = new GitHubSim(new FakeClock(Date.now()), state());
  const rec: Recorded[] = [];
  const recArtifacts = join(dirs().dir, 'artifacts');
  await recordRun(sim, recArtifacts, rec);
  const run1Calls = rec.length;
  assert.ok(
    rec.some((c) => c.argv.some((a) => /\/actions\/jobs\/31\/logs/.test(a))),
    'run 1 diagnosed unit',
  );
  await recordRun(sim, recArtifacts, rec);
  const scenario = join(scratchDir(), `wait-resume-${process.pid}-${Date.now()}`);
  writeScenario(scenario, rec, 'recorded from two runs of the ci wait GitHub sim');

  const d = dirs();
  const r1 = await spawnGhx(['ci', 'wait', ...ARGV], {
    fakeGh: true,
    env: d.env(scenario),
    onSpawn: (child) => {
      // Killed once its first tick (diagnosis and the state save after it) is done: no signal handler runs.
      void waitForCalls(d.log, run1Calls).then(() => setTimeout(() => child.kill('SIGKILL'), 500));
    },
  });
  assert.equal(r1.signal, 'SIGKILL');
  assert.equal(r1.stdout, '', 'a killed wait prints nothing');
  const setupBefore = logLines(d.log).filter((c) => SETUP.test(c.argv.join(' '))).length;
  assert.ok(setupBefore > 0);

  const before = logLines(d.log).length;
  const r2 = await spawnGhx(['ci', 'wait', ...ARGV], {
    fakeGh: true,
    env: d.env(scenario),
    onSpawn: (child) => {
      void waitForCalls(d.log, before + rec.length - run1Calls).then(() =>
        setTimeout(() => child.kill('SIGTERM'), 200),
      );
    },
  });
  assert.equal(r2.exitCode, EXIT.SIGTERM, r2.stdout + r2.stderr);
  const s = JSON.parse(r2.stdout);
  assert.equal(s.resumed, true);
  assert.equal(s.outcome, 'interrupted');
  assert.ok(
    s.warnings?.some((w: { code: string }) => w.code === 'WAIT_STATE_DISCARDED'),
    'the killed run left its lock behind; the re-run breaks it (its pid is gone)',
  );
  const run2 = logLines(d.log).slice(before);
  assert.deepEqual(
    run2.filter((c) => SETUP.test(c.argv.join(' '))).map((c) => c.argv.join(' ')),
    [],
    'no repeated baseline, expected-set, ETA or diagnosis call',
  );
  const polls = run2.filter((c) => /repos\/o\/r\/(pulls\/7|commits\/)/.test(c.argv.join(' ')));
  assert.ok(polls.length > 0 && polls.every((c) => c.argv.some((a: string) => /^if-none-match:/i.test(a))));
});
