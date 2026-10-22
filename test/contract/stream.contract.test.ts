// The stream runner through the real bin, real signals and real pipes (03 §2 M1.10, §4.3).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawnGhx } from '../helpers/spawn.ts';
import { EXIT } from './exit-table.ts';

const HOOKS = { GHX_TEST_HOOKS: '1' };

test('final mode: stdout is exactly one JSON document; events file has gapless seq', async () => {
  const r = await spawnGhx(['test', 'tick', '--count', '3', '--interval-ms', '10'], { env: HOOKS });
  assert.equal(r.exitCode, EXIT.OK);
  assert.ok(r.stdout.endsWith('\n'));
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.outcome, 'ok');
  const seqs = readFileSync(doc.eventsPath, 'utf8')
    .trimEnd()
    .split('\n')
    .map((l) => JSON.parse(l).seq);
  assert.deepEqual(seqs, [0, 1, 2, 3]);
});

test('ndjson: 1 MiB of lines arrives in full, last line is the summary (pipe flush)', async () => {
  const r = await spawnGhx(
    ['test', 'tick', '--stream', '--count', '256', '--interval-ms', '0', '--payload-bytes', '4000'],
    { env: HOOKS },
  );
  assert.equal(r.exitCode, EXIT.OK);
  assert.ok(Buffer.byteLength(r.stdout) > 1_000_000);
  assert.ok(r.stdout.endsWith('\n'));
  const lines = r.stdout
    .trimEnd()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(lines.length, 257);
  assert.deepEqual(
    lines.map((l) => l.seq),
    [...Array(257).keys()],
  );
  assert.equal(lines.at(-1).type, 'summary');
  assert.ok(
    r.stdout
      .trimEnd()
      .split('\n')
      .slice(0, -1)
      .every((l) => Buffer.byteLength(l) <= 4096),
  );
});

test('no deadline: still running with empty stdout; SIGTERM then gives the interrupted document, exit 143', async () => {
  let child: import('node:child_process').ChildProcess | undefined;
  const p = spawnGhx(['test', 'tick', '--count', '5', '--interval-ms', '600000'], {
    env: HOOKS,
    onSpawn: (c) => (child = c),
  });
  let early = '';
  child?.stdout?.on('data', (c: Buffer) => (early += c.toString()));
  await sleep(2_000);
  assert.equal(child?.exitCode, null, 'still running');
  assert.equal(early, '');
  child?.kill('SIGTERM');
  const r = await p;
  assert.equal(r.exitCode, EXIT.SIGTERM);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.outcome, 'interrupted');
  assert.equal(r.stdout.trimEnd().split('\n').length, 1);
});

test('SIGINT gives exit 130; ndjson keeps exactly one terminal line, last', async () => {
  let child: import('node:child_process').ChildProcess | undefined;
  const p = spawnGhx(['test', 'tick', '--stream', '--count', '5', '--interval-ms', '600000'], {
    env: HOOKS,
    onSpawn: (c) => (child = c),
  });
  await sleep(1_500);
  child?.kill('SIGINT');
  const r = await p;
  assert.equal(r.exitCode, EXIT.SIGINT);
  const lines = r.stdout
    .trimEnd()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(lines.filter((l) => l.type === 'summary' || l.type === 'error').length, 1);
  assert.equal(lines.at(-1).type, 'summary');
});

test('an ungraceful command: a second signal inside the grace window still produces the document', async () => {
  let child: import('node:child_process').ChildProcess | undefined;
  const p = spawnGhx(['test', 'tick', '--count', '5', '--ignore-abort'], { env: HOOKS, onSpawn: (c) => (child = c) });
  await sleep(1_500);
  child?.kill('SIGTERM');
  await sleep(200);
  child?.kill('SIGTERM');
  const r = await p;
  assert.ok(r.ms < 1_500 + 2_900, `exited after ${r.ms} ms (grace skipped)`);
  assert.equal(r.exitCode, EXIT.SIGTERM);
  assert.equal(JSON.parse(r.stdout).error.code, 'INTERRUPTED');
});
