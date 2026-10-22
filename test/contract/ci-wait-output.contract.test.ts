// ci wait's default protocol end to end (02 §11.0, §11.9; 03 §4.3): the real bin against the fake gh.
// stdout is exactly one WaitSummary document (never spilled, under 16 KB even with 10 red targets);
// a signal gives the interrupted summary; there is no deadline. Scenarios other than smoke/ci-wait are
// recorded from the in-process GitHub sim into a temp dir (the spawned run makes the same first-tick calls).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PROTOCOL } from '../../src/commands/ci/wait.ts';
import { Warning } from '../../src/core/command.ts';
import { WaitSummary } from '../../src/schemas/ci.ts';
import { type SimJob, type SimState, sha } from '../commands/ci-wait-world.ts';
import { spawnGhx } from '../helpers/spawn.ts';
import { dirs, recordScenario } from './ci-wait-scenario.ts';
import { EXIT } from './exit-table.ts';

const Summary = WaitSummary.extend({ warnings: Warning.array().optional() }).strict();

const lines = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : []);

async function waitForLines(path: string, n: number, timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now();
  while (lines(path).length < n) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`only ${lines(path).length}/${n} gh calls logged`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const H = sha('a');
const pendingState = (): SimState => ({
  pr: { state: 'open', head: H },
  checks: { [H]: [{ id: 21, runId: 600, name: 'test', status: 'in_progress', startedAt: 0 }] },
});

test('smoke/ci-wait: stdout is exactly one WaitSummary document; eventsPath is gapless NDJSON', async () => {
  const d = dirs();
  const r = await spawnGhx(['ci', 'wait', '3301', '-R', 'powerhouse-inc/powerhouse'], {
    fakeGh: true,
    env: d.env('smoke/ci-wait'),
  });
  assert.equal(r.exitCode, EXIT.OK, r.stdout + r.stderr);
  assert.ok(r.stdout.endsWith('}\n') && r.stdout.indexOf('\n') === r.stdout.length - 1, 'one line, one document');
  const s = Summary.parse(JSON.parse(r.stdout));
  assert.equal(s.outcome, 'green');
  assert.equal((s as Record<string, unknown>).spilled, undefined);
  const ev = lines(s.eventsPath).map((l) => JSON.parse(l));
  assert.deepEqual(
    ev.map((e) => e.seq),
    ev.map((_, i) => i),
  );
  assert.equal(ev.at(-1).type, 'summary');
  assert.ok(lines(d.log).length > 0);
});

test('10 targets, each with 5 failing jobs: one document under 16 384 bytes, never spilled, full detail on disk', async () => {
  const checks: SimState['checks'] = {};
  const prs: NonNullable<SimState['prs']> = {};
  for (let n = 1; n <= 10; n++) {
    const head = sha(n.toString(16));
    prs[n] = { state: 'open', head };
    checks[head] = Array.from(
      { length: 5 },
      (_, k): SimJob => ({
        id: n * 100 + k,
        runId: n * 10,
        name: `Test shard ${k + 1}/5 of a matrix with a very long display name ${'x'.repeat(120)}`,
        status: 'completed',
        conclusion: 'failure',
        completedAt: 0,
      }),
    );
  }
  const targets = Array.from({ length: 10 }, (_, i) => `o/r#${i + 1}`);
  const { scenario } = await recordScenario(
    { pr: prs[1] as NonNullable<SimState['prs']>[number], prs, checks },
    [...targets, '--no-diagnose'],
    { number: 1 },
  );
  const d = dirs();
  const r = await spawnGhx(['ci', 'wait', ...targets, '--no-diagnose'], {
    fakeGh: true,
    env: d.env(scenario),
    timeoutMs: 120_000,
  });
  assert.equal(r.exitCode, EXIT.CI_RED, r.stdout.slice(0, 500) + r.stderr);
  assert.ok(Buffer.byteLength(r.stdout) < 16_384, `${Buffer.byteLength(r.stdout)} bytes`);
  const s = Summary.parse(JSON.parse(r.stdout));
  assert.equal(s.results.length, 10);
  assert.ok(s.diagnosisPath && existsSync(s.diagnosisPath));
  const full = JSON.parse(readFileSync(s.diagnosisPath, 'utf8'));
  assert.equal(full.results[0].ci.failing.length, 5, 'the full form keeps every failing job');
  assert.ok(existsSync(s.eventsPath));
});

for (const [sig, code] of [
  ['SIGTERM', EXIT.SIGTERM],
  ['SIGINT', EXIT.SIGINT],
] as const) {
  test(`${sig} mid-wait gives one document with outcome interrupted, exit ${code}`, async () => {
    const { scenario, calls } = await recordScenario(pendingState(), ['o/r#7']);
    const d = dirs();
    const r = await spawnGhx(['ci', 'wait', 'o/r#7'], {
      fakeGh: true,
      env: d.env(scenario),
      onSpawn: (child) => {
        void waitForLines(d.log, calls).then(() => setTimeout(() => child.kill(sig), 200));
      },
    });
    assert.equal(r.exitCode, code, r.stdout + r.stderr);
    const s = Summary.parse(JSON.parse(r.stdout));
    assert.equal(s.outcome, 'interrupted');
    assert.equal(s.exitCode, code);
    assert.deepEqual(s.results[0]?.next, ['ghx ci wait o/r#7']);
  });
}

test('no default deadline: a healthy pending CI is still waiting after 5 s, with nothing on stdout', async () => {
  const { scenario, calls } = await recordScenario(pendingState(), ['o/r#7']);
  const d = dirs();
  let stdoutAt5s = 'unset';
  let alive = false;
  const r = await spawnGhx(['ci', 'wait', 'o/r#7'], {
    fakeGh: true,
    env: d.env(scenario),
    onSpawn: (child) => {
      let out = '';
      child.stdout?.on('data', (c: Buffer) => {
        out += c.toString();
      });
      void waitForLines(d.log, calls).then(() =>
        setTimeout(() => {
          stdoutAt5s = out;
          alive = child.exitCode === null;
          child.kill('SIGTERM');
        }, 5_000),
      );
    },
  });
  assert.equal(alive, true, 'still running after 5 s');
  assert.equal(stdoutAt5s, '');
  assert.equal(r.exitCode, EXIT.SIGTERM);
  assert.equal(JSON.parse(r.stdout).outcome, 'interrupted');
});

test('unattended (env unset) with the test clock offset: pending, exit 15, at once', async () => {
  const { scenario } = await recordScenario(pendingState(), ['o/r#7']);
  const d = dirs();
  const r = await spawnGhx(['ci', 'wait', 'o/r#7'], {
    fakeGh: true,
    env: d.env(scenario, { GHX_TEST_HOOKS: '1', GHX_TEST_CLOCK_OFFSET_MS: String(25 * 60_000) }),
  });
  assert.equal(r.exitCode, EXIT.CI_PENDING_RESUME, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).outcome, 'pending');
});

test('--timeout is refused: ci wait has no caller duration', async () => {
  const r = await spawnGhx(['ci', 'wait', 'o/r#7', '--timeout', '5m'], {
    fakeGh: true,
    env: dirs().env('smoke/ci-wait'),
  });
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
});

test('--help carries the 02 §11.0 protocol sentence; --schema reports kind read', async () => {
  const help = await spawnGhx(['ci', 'wait', '--help']);
  assert.equal(help.exitCode, EXIT.OK);
  assert.ok(help.stdout.includes(JSON.stringify(PROTOCOL).slice(1, -1)), help.stdout);
  const schema = JSON.parse((await spawnGhx(['ci', 'wait', '--schema'])).stdout);
  assert.equal(schema.kind, 'read');
});
