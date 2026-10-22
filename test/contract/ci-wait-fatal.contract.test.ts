// A fatal gh error mid-wait (02 §11.10): the real bin prints an {error} document with exit 7, and under
// --stream the error is the one terminal line, last, after the events already printed. The fatal error is
// target 2's first poll answering a shape ghx does not know (GH_OUTPUT_UNEXPECTED) while target 1 has
// already bound and emitted `start`; a bound target's gh failures are retried, which spawned tests cannot
// wait out (MAX_TICK_FAILURES × 30 s), so that path is covered in-process in ci-wait-errors.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { endpoint, type GitHubSim, type SimState, sha } from '../commands/ci-wait-world.ts';
import { spawnGhx } from '../helpers/spawn.ts';
import { dirs, recordScenario } from './ci-wait-scenario.ts';
import { EXIT } from './exit-table.ts';

const H7 = sha('a');
const H8 = sha('b');
const state = (): SimState => ({
  pr: { state: 'open', head: H7 },
  prs: { 8: { state: 'open', head: H8 } },
  checks: {
    [H7]: [{ id: 21, runId: 600, name: 'test', status: 'in_progress', startedAt: 0 }],
    [H8]: [{ id: 31, runId: 700, name: 'test', status: 'in_progress', startedAt: 0 }],
  },
});

/** pulls/8 answers 200 with a body that is not a pull request. */
const drift = (sim: GitHubSim) =>
  sim.override(
    (argv) => endpoint(argv) === 'repos/o/r/pulls/8',
    () => ({
      status: 200,
      exitCode: 0,
      stdout: 'HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n{"message":"not a pull request"}',
      stderr: '',
    }),
  );

for (const stream of [false, true]) {
  test(`${stream ? '--stream' : 'default'}: a fatal gh error mid-wait gives the {error} document, exit 7`, async () => {
    const argv = ['o/r#7', 'o/r#8', ...(stream ? ['--stream'] : [])];
    const { scenario } = await recordScenario(state(), argv, {}, drift);
    const d = dirs();
    const r = await spawnGhx(['ci', 'wait', ...argv], { fakeGh: true, env: d.env(scenario) });
    assert.equal(r.exitCode, EXIT.GH_FAILED, r.stdout + r.stderr);
    const lines = r.stdout
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown> & { error?: { code: string } });
    const last = lines.at(-1);
    assert.equal(last?.error?.code, 'GH_OUTPUT_UNEXPECTED', r.stdout);
    assert.deepEqual(Object.keys(last?.error ?? {}).sort(), ['code', 'details', 'hint', 'message']);
    if (!stream) {
      assert.equal(lines.length, 1, 'one document');
      return;
    }
    assert.equal(last?.type, 'error');
    assert.deepEqual(
      lines.map((l) => l.seq),
      lines.map((_, i) => i),
      'gapless seq',
    );
    assert.equal(lines.filter((l) => l.type === 'error' || l.type === 'summary').length, 1);
    assert.ok(
      lines.some((l) => l.type === 'start' && l.target === 'o/r#7'),
      'target 1 had already started: the error is mid-wait',
    );
  });
}
