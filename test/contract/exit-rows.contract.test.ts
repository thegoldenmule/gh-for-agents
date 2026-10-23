// Exit rows of 02 §6.1 that need a GitHub reply, through the real bin and the fake gh (exit-codes.contract
// covers the rows producible without one). Static scenarios live in test/fixtures/gh/<name>/.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnGhx } from '../helpers/spawn.ts';
import { dirs } from './ci-wait-scenario.ts';
import { EXIT } from './exit-table.ts';

const ERROR_KEYS = ['code', 'message', 'hint', 'details'];

test('exit 4 (ENV_GH_AUTH): gh answers its first call with the auth login prompt', async () => {
  const d = dirs();
  const r = await spawnGhx(['ci', 'why', '--run', '5', '-R', 'o/r'], { fakeGh: true, env: d.env('env-gh-auth') });
  assert.equal(r.exitCode, EXIT.ENV, r.stdout + r.stderr);
  const { error } = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(error), ERROR_KEYS);
  assert.equal(error.code, 'ENV_GH_AUTH');
  assert.match(error.hint, /gh auth login/);
});
