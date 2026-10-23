// Spawn the real bin (01 §9 commit 9): stdout is one complete JSON document ending in a newline.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { BIN, baseEnv, spawnGhx } from '../helpers/spawn.ts';
import { EXIT } from './exit-table.ts';

test('bin/ghx.js version: one JSON document, exit 0, complete final byte', async () => {
  const r = await spawnGhx(['version']);
  assert.equal(r.exitCode, EXIT.OK);
  assert.ok(r.stdout.endsWith('}\n'), JSON.stringify(r.stdout.slice(-20)));
  assert.equal(r.stdout.split('\n').length, 2);
  assert.equal(JSON.parse(r.stdout).name, 'ghx');
  assert.equal(r.stderr, '');
});

test('bin/ghx.js: a 1 MB document reaches the pipe in full before exit (macOS pipe flush)', async () => {
  const r = await spawnGhx(['test', 'big', '--bytes', '1000000', '--max-bytes', '4000000'], {
    env: { GHX_TEST_HOOKS: '1' },
  });
  assert.equal(r.exitCode, EXIT.OK);
  assert.ok(r.stdout.length > 1_000_000);
  assert.ok(r.stdout.endsWith('"last":"END"}\n'));
  assert.equal(JSON.parse(r.stdout).last, 'END');
});

test('bin/ghx.js: unknown command is an error document with exit 2', async () => {
  const r = await spawnGhx(['nope']);
  assert.equal(r.exitCode, EXIT.USAGE);
  assert.deepEqual(Object.keys(JSON.parse(r.stdout).error), ['code', 'message', 'hint', 'details']);
});

test('bin/ghx.js on Node < 24: an ENV_NODE_UNSUPPORTED error document, exit 4, before anything loads', async () => {
  const script = `Object.defineProperty(process.versions, 'node', { value: '22.11.0' }); await import(${JSON.stringify(pathToFileURL(BIN).href)});`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: baseEnv(), encoding: 'utf8' });
  assert.equal(r.status, EXIT.ENV, r.stdout + r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.error.code, 'ENV_NODE_UNSUPPORTED');
  assert.match(doc.error.message, /Node\.js 24 or newer; this is Node\.js 22\.11\.0/);
  assert.deepEqual(Object.keys(doc.error), ['code', 'message', 'hint', 'details']);
  assert.equal(r.stderr, '');
});
