import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { realClock } from '../../../src/core/clock.ts';
import { createSpawnRunner, KILL_GRACE_MS, type ProcRequest } from '../../../src/proc/runner.ts';
import { FakeClock } from '../../helpers/fake-clock.ts';

const tmp = mkdtempSync(join(tmpdir(), 'ghx-proc-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const node = process.execPath;
const run = createSpawnRunner({ clock: realClock });
const req = (script: string, extra: Partial<ProcRequest> = {}): ProcRequest => ({
  cmd: node,
  args: ['-e', script],
  env: { PATH: process.env.PATH },
  signal: new AbortController().signal,
  ...extra,
});

test('captures stdout, stderr and the exit code', async () => {
  const r = await run(req('process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 3'));
  assert.equal(r.exitCode, 3);
  assert.equal(r.stdout, 'out');
  assert.equal(r.stderr, 'err');
  assert.equal(r.timedOut, false);
  assert.equal(r.aborted, false);
});

test('passes stdin, and the env is exactly what was given', async () => {
  const r = await run(
    req(
      'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(s+"|"+(process.env.HOME??"none")+"|"+process.env.X))',
      {
        stdin: '{"a":1}',
        env: { PATH: process.env.PATH, X: 'y', DROPPED: undefined },
      },
    ),
  );
  assert.equal(r.stdout, '{"a":1}|none|y');
});

test('stdin is never inherited: a child reading stdin sees EOF at once', async () => {
  const r = await run(req('process.stdin.on("data",()=>{}).on("end",()=>process.stdout.write("eof"))'));
  assert.equal(r.stdout, 'eof');
});

test('timeout kills the child', async () => {
  const r = await run(req('setInterval(()=>{}, 1000)', { timeoutMs: 150 }));
  assert.equal(r.timedOut, true);
  assert.equal(r.signal, 'SIGTERM');
});

test('timeout kills the whole process tree, not just the direct child', {
  skip: process.platform === 'win32',
}, async () => {
  const started = performance.now();
  const r = await run({
    cmd: 'sh',
    args: ['-c', 'sleep 6 & wait'],
    env: { PATH: process.env.PATH },
    signal: new AbortController().signal,
    timeoutMs: 300,
  });
  const elapsed = performance.now() - started;
  assert.equal(r.timedOut, true);
  assert.ok(elapsed < 1_500, `returned after ${Math.round(elapsed)} ms`);
});

test('abort kills the child', async () => {
  const c = new AbortController();
  const p = run(req('setInterval(()=>{}, 1000)', { signal: c.signal }));
  setTimeout(() => c.abort(), 100);
  const r = await p;
  assert.equal(r.aborted, true);
  assert.equal(r.exitCode, null);
});

test('an already-aborted signal never spawns', async () => {
  const c = new AbortController();
  c.abort();
  const r = await run(req('process.exit(0)', { signal: c.signal }));
  assert.equal(r.aborted, true);
  assert.equal(r.exitCode, null);
});

test('SIGTERM-ignoring child is SIGKILLed after the grace (fake clock)', async () => {
  const clock = new FakeClock();
  const fake = createSpawnRunner({ clock });
  const ready = join(tmp, 'ready');
  const p = fake(
    req(
      `process.on("SIGTERM",()=>{}); require("fs").writeFileSync(${JSON.stringify(ready)},"1"); setInterval(()=>{},1000)`,
      {
        timeoutMs: 1_000,
      },
    ),
  );
  while (!existsSync(ready)) await new Promise((r) => setTimeout(r, 10));
  await clock.advance(1_000);
  await new Promise((r) => setTimeout(r, 100));
  await clock.advance(KILL_GRACE_MS);
  const r = await p;
  assert.equal(r.timedOut, true);
  assert.equal(r.signal, 'SIGKILL');
});

test('stdoutFile streams stdout to a file', async () => {
  const file = join(tmp, 'out.log');
  const r = await run(req('process.stdout.write("x".repeat(100000))', { stdoutFile: file }));
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, '');
  assert.equal(readFileSync(file, 'utf8').length, 100_000);
});

test('ENOENT is a spawnError, not a throw', async () => {
  const r = await run({ ...req(''), cmd: join(tmp, 'no-such-binary') });
  assert.equal(r.spawnError?.code, 'ENOENT');
  assert.equal(r.exitCode, null);
});

test('output over maxBuffer kills the child and flags it', async () => {
  const r = await run(req('setInterval(()=>process.stdout.write("y".repeat(4096)), 1)', { maxBuffer: 16_384 }));
  assert.equal(r.outputTooLarge, true);
  assert.ok(r.stdout.length <= 16_384);
});
