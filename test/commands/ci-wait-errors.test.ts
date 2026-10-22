// A bound target whose polls keep failing (02 §11.10): each failed tick is retried 30 s later, and the
// MAX_TICK_FAILURES-th in a row is fatal: an {error} document with exit 7, or under --stream one terminal
// error line after the events already printed. In-process on FakeClock (the spawned bin would need
// minutes of real time); ci-wait-fatal.contract.test.ts covers the immediate fatal path end to end.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_TICK_FAILURES } from '../../src/ci/wait/driver.ts';
import { EXIT } from '../contract/exit-table.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { GitHubSim, type SimJob, sha, wait } from './ci-wait-world.ts';

const H = sha('a');
const MIN = 60_000;

function failingFrom(atMs: number) {
  const job: SimJob = { id: 21, runId: 600, name: 'test', status: 'in_progress', startedAt: 0 };
  const sim = new GitHubSim(new FakeClock(), { pr: { state: 'open', head: H }, checks: { [H]: [job] } });
  sim.override(
    () => sim.clock.monotonic() >= atMs,
    () => ({
      status: 502,
      exitCode: 1,
      stdout: 'HTTP/2.0 502 Bad Gateway\r\nContent-Type: text/html\r\n\r\n<html>502</html>',
      stderr: 'gh: HTTP 502\n',
    }),
  );
  return sim;
}

for (const stream of [false, true]) {
  test(`${stream ? '--stream' : 'default'}: ${MAX_TICK_FAILURES} failed polls in a row after binding end in exit 7`, async () => {
    const sim = failingFrom(MIN);
    const r = await wait(sim, ['o/r#7', ...(stream ? ['--stream'] : [])]);
    assert.equal(r.exitCode, EXIT.GH_FAILED, r.stdout);
    const lines = r.stdout
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown> & { error?: { code: string } });
    const last = lines.at(-1);
    assert.match(String(last?.error?.code), /^GH_/, r.stdout);
    assert.ok(sim.clock.monotonic() >= MIN + (MAX_TICK_FAILURES - 1) * 30_000, 'retried before giving up');
    if (!stream) {
      assert.equal(lines.length, 1, 'one document');
      return;
    }
    assert.equal(last?.type, 'error');
    assert.equal(lines[0]?.type, 'start', 'the wait had started');
    assert.equal(lines.filter((l) => l.type === 'error' || l.type === 'summary').length, 1);
  });
}
