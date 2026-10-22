// ci wait --stream end to end (03 §4.3): every line is JSON with type, gapless seq and at; exactly one
// terminal line (summary or error) and it is last, under SIGTERM too; non-terminal lines are ≤4 096
// bytes; and the lines are identical to the eventsPath file.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { sha } from '../commands/ci-wait-world.ts';
import { spawnGhx } from '../helpers/spawn.ts';
import { dirs, recordScenario } from './ci-wait-scenario.ts';
import { EXIT } from './exit-table.ts';

function invariants(stdout: string): Record<string, unknown>[] {
  const raw = stdout.trim().split('\n');
  const lines = raw.map((l) => JSON.parse(l) as Record<string, unknown>);
  lines.forEach((l, i) => {
    assert.equal(typeof l.type, 'string');
    assert.equal(l.seq, i, 'gapless seq');
    assert.ok(!Number.isNaN(Date.parse(String(l.at))), 'at is a timestamp');
  });
  const terminal = lines.filter((l) => l.type === 'summary' || l.type === 'error');
  assert.equal(terminal.length, 1);
  assert.equal(lines.at(-1), terminal[0]);
  for (const l of raw.slice(0, -1)) assert.ok(Buffer.byteLength(l) <= 4_096);
  return lines;
}

test('--stream: NDJSON invariants, and the lines equal the eventsPath file', async () => {
  const d = dirs();
  const r = await spawnGhx(['ci', 'wait', '3301', '-R', 'powerhouse-inc/powerhouse', '--stream'], {
    fakeGh: true,
    env: d.env('smoke/ci-wait'),
  });
  assert.equal(r.exitCode, EXIT.OK, r.stdout + r.stderr);
  const lines = invariants(r.stdout);
  assert.equal(lines[0]?.type, 'start');
  const summary = lines.at(-1) as { eventsPath: string };
  assert.ok(existsSync(summary.eventsPath));
  assert.equal(readFileSync(summary.eventsPath, 'utf8'), r.stdout);
});

test('--stream under SIGTERM: the last line is still the (interrupted) summary', async () => {
  const H = sha('a');
  const { scenario, calls } = await recordScenario(
    {
      pr: { state: 'open', head: H },
      checks: { [H]: [{ id: 1, runId: 2, name: 't', status: 'in_progress', startedAt: 0 }] },
    },
    ['o/r#7', '--stream'],
  );
  const d = dirs();
  const r = await spawnGhx(['ci', 'wait', 'o/r#7', '--stream'], {
    fakeGh: true,
    env: d.env(scenario),
    onSpawn: (child) => {
      const poll = setInterval(() => {
        const n = existsSync(d.log) ? readFileSync(d.log, 'utf8').trim().split('\n').length : 0;
        if (n >= calls) {
          clearInterval(poll);
          setTimeout(() => child.kill('SIGTERM'), 200);
        }
      }, 25);
    },
  });
  assert.equal(r.exitCode, EXIT.SIGTERM, r.stdout + r.stderr);
  const lines = invariants(r.stdout);
  assert.equal(lines.at(-1)?.type, 'summary');
  assert.equal(lines.at(-1)?.outcome, 'interrupted');
});
