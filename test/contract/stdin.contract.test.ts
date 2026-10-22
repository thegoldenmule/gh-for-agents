// No implicit stdin read (01 Pushback, 03 §4.3): a harness may leave stdin as an open pipe that is
// never written or closed; ghx must not wait on it. Stdin is read only with an explicit --input -.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnGhx } from '../helpers/spawn.ts';
import { EXIT } from './exit-table.ts';

const HOOKS = { GHX_TEST_HOOKS: '1' };

test('an open, never-closed stdin pipe does not block a command (doctor, fake gh)', async () => {
  const r = await spawnGhx(['doctor'], {
    openStdin: true,
    fakeGh: true,
    env: { GHX_FAKE_SCENARIO: 'doctor-ok' },
    timeoutMs: 5_000,
  });
  assert.ok(r.ms < 5_000);
  assert.ok(JSON.parse(r.stdout).gh);
});

test('missing --input with an open stdin pipe is USAGE_INPUT_MISSING, exit 2, within 5 s', async () => {
  const r = await spawnGhx(['test', 'needs-input'], { openStdin: true, env: HOOKS, timeoutMs: 5_000 });
  assert.equal(r.exitCode, EXIT.USAGE);
  assert.equal(JSON.parse(r.stdout).error.code, 'USAGE_INPUT_MISSING');
});

test('--input - reads the pipe once it closes', async () => {
  const r = await spawnGhx(['test', 'needs-input', '--input', '-', '--dry-run'], {
    stdin: '{"title":"from stdin"}',
    env: HOOKS,
  });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(JSON.parse(r.stdout).preview, { title: 'from stdin' });
});

test('stdin over 1 MiB is USAGE_INPUT_JSON with a size message', async () => {
  const big = `{"title":"${'x'.repeat(1024 * 1024)}"}`;
  const r = await spawnGhx(['test', 'needs-input', '--input', '-', '--dry-run'], { stdin: big, env: HOOKS });
  assert.equal(r.exitCode, EXIT.USAGE);
  const err = JSON.parse(r.stdout).error;
  assert.equal(err.code, 'USAGE_INPUT_JSON');
  assert.match(err.message, /exceeds 1048576 bytes/);
});
