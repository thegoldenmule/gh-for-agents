// Spill (01 §3.5 step 7): over the bound, stdout is {spilled, path, bytes, command} and the file holds
// the full JSON. GHX_MAX_BYTES is honoured.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { spawnGhx } from '../helpers/spawn.ts';
import { EXIT } from './exit-table.ts';

const HOOKS = { GHX_TEST_HOOKS: '1' };

test('--max-bytes 2000 spills; the file parses and is `bytes` long; exit 0', async () => {
  const r = await spawnGhx(['test', 'big', '--bytes', '50000', '--max-bytes', '2000'], { env: HOOKS });
  assert.equal(r.exitCode, EXIT.OK);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), ['spilled', 'path', 'bytes', 'command']);
  const file = readFileSync(out.path);
  assert.equal(file.length, out.bytes);
  assert.equal(JSON.parse(file.toString('utf8')).last, 'END');
});

test('GHX_MAX_BYTES is honoured; the default 16 KB bound applies without it', async () => {
  const env = await spawnGhx(['test', 'big', '--bytes', '5000'], { env: { ...HOOKS, GHX_MAX_BYTES: '1000' } });
  assert.equal(JSON.parse(env.stdout).spilled, true);
  const small = await spawnGhx(['test', 'big', '--bytes', '5000'], { env: HOOKS });
  assert.equal(JSON.parse(small.stdout).last, 'END');
  const over = await spawnGhx(['test', 'big', '--bytes', '20000'], { env: HOOKS });
  assert.equal(JSON.parse(over.stdout).spilled, true);
});
