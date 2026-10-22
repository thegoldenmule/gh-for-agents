// R20 (03 §5.2; brief 2026-10-22): ci wait flags flaky jobs but never reruns them. A flaky candidate
// shows in rerunCandidates and `next` suggests `ghx ci rerun <ref> --flaky`; every call is a read.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubSim, sha, wait } from '../commands/ci-wait-world.ts';
import { EXIT } from '../contract/exit-table.ts';
import { FakeClock } from '../helpers/fake-clock.ts';

const H = sha('a');

test('an infra-error failure is a rerun candidate; nothing is rerun', async () => {
  const sim = new GitHubSim(new FakeClock(), {
    pr: { state: 'open', head: H },
    checks: {
      [H]: [
        {
          id: 77,
          runId: 600,
          name: 'unit',
          status: 'completed',
          conclusion: 'failure',
          completedAt: 0,
          logExtra: ['Error: ENOSPC: No space left on device, write'],
        },
      ],
    },
  });
  const r = await wait(sim, ['o/r#7']);
  assert.equal(r.exitCode, EXIT.CI_RED, r.stdout);
  const t = r.json.results[0];
  assert.deepEqual(t.rerunCandidates, [77]);
  assert.equal(t.diagnosis.jobs[0].flake, 'high');
  assert.ok(t.next.includes('ghx ci rerun o/r#7 --flaky'), t.next.join('\n'));
  assert.deepEqual(sim.mutations(), []);
  assert.equal(sim.callsTo(/\/rerun/).length, 0);
});
