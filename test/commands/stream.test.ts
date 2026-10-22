// The stream runner on FakeClock (01 §9 commit 10, 03 §2 M1.10).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createShutdown } from '../../src/core/signals.ts';
import { EXIT } from '../contract/exit-table.ts';
import { FakeClock, flush } from '../helpers/fake-clock.ts';
import { runInProcess } from '../helpers/harness.ts';
import { makeTick } from '../helpers/stream-fixture.ts';

const parse = (lines: string[]) => lines.map((l) => JSON.parse(l) as Record<string, any>);

async function run(
  argv: string[],
  o: { clock?: FakeClock; advance?: number; commands?: ReturnType<typeof makeTick>[] } = {},
) {
  const clock = o.clock ?? new FakeClock();
  const p = runInProcess(['test', 'tick', ...argv], { clock, ...(o.commands ? { commands: o.commands } : {}) });
  await clock.advance(o.advance ?? 60_000);
  return p;
}

test('ndjson: envelope with gapless seq, one terminal summary last, exit from the summary', async () => {
  const r = await run(['--stream', '--count', '3', '--red']);
  const lines = parse(r.lines);
  assert.deepEqual(
    lines.map((l) => l.type),
    ['tick', 'tick', 'tick', 'summary'],
  );
  assert.deepEqual(
    lines.map((l) => l.seq),
    [0, 1, 2, 3],
  );
  for (const l of lines) assert.match(l.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(lines[1]?.n, 2);
  assert.equal(lines[3]?.outcome, 'red');
  assert.equal(r.exitCode, EXIT.CI_RED);
});

test('ndjson: stdout lines are identical to the events file', async () => {
  const r = await run(['--stream', '--count', '2']);
  const summary = parse(r.lines).at(-1);
  const file = readFileSync(summary?.eventsPath, 'utf8').trimEnd().split('\n');
  assert.deepEqual(file, r.lines);
});

test('final: stdout is exactly one JSON document; the events file has every line with gapless seq', async () => {
  const r = await run(['--count', '3']);
  assert.equal(r.lines.length, 1);
  assert.equal(r.exitCode, 0);
  const doc = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(doc).sort(), ['eventsPath', 'outcome', 'ticks']);
  assert.equal(doc.outcome, 'ok');
  const events = parse(readFileSync(doc.eventsPath, 'utf8').trimEnd().split('\n'));
  assert.deepEqual(
    events.map((e) => e.seq),
    [0, 1, 2, 3],
  );
  assert.deepEqual(
    events.map((e) => e.type),
    ['tick', 'tick', 'tick', 'summary'],
  );
});

test('warnings: lines in ndjson; folded into the final document', async () => {
  const nd = parse((await run(['--stream', '--count', '2', '--warn-at', '1'])).lines);
  assert.deepEqual(
    nd.map((l) => l.type),
    ['warning', 'tick', 'tick', 'summary'],
  );
  assert.equal(nd[0]?.code, 'TICK_WARNING');
  const fin = await run(['--count', '2', '--warn-at', '1']);
  assert.deepEqual(JSON.parse(fin.stdout).warnings, [{ code: 'TICK_WARNING', message: 'warning at 1' }]);
});

test('a thrown error is the terminal error line with its exit code', async () => {
  const nd = await run(['--stream', '--count', '3', '--fail-at', '2']);
  const lines = parse(nd.lines);
  assert.deepEqual(
    lines.map((l) => l.type),
    ['tick', 'error'],
  );
  assert.equal(lines[1]?.error.code, 'GH_FAILED');
  assert.deepEqual(Object.keys(lines[1]?.error), ['code', 'message', 'hint', 'details']);
  assert.equal(nd.exitCode, EXIT.GH_FAILED);
  const fin = await run(['--count', '3', '--fail-at', '2']);
  assert.equal(fin.lines.length, 1);
  assert.equal(JSON.parse(fin.stdout).error.code, 'GH_FAILED');
});

test('an event that violates its schema (or uses a reserved type) ends in INTERNAL_OUTPUT_CONTRACT', async () => {
  for (const flag of ['--bad-event-at', '--reserved-at']) {
    const r = await run(['--stream', '--count', '3', flag, '2']);
    const lines = parse(r.lines);
    assert.deepEqual(
      lines.map((l) => l.type),
      ['tick', 'error'],
      flag,
    );
    assert.equal(lines[1]?.error.code, 'INTERNAL_OUTPUT_CONTRACT');
    assert.equal(r.exitCode, EXIT.INTERNAL);
  }
});

test('heartbeat after silence (ndjson only)', async () => {
  const hb = makeTick({ name: ['hb'], heartbeatMs: 60_000 });
  const clock = new FakeClock();
  const p = runInProcess(['hb', '--stream', '--count', '1', '--interval-ms', '150000'], { clock, commands: [hb] });
  await clock.advance(150_000);
  const lines = parse((await p).lines);
  assert.deepEqual(
    lines.map((l) => l.type),
    ['heartbeat', 'heartbeat', 'tick', 'summary'],
  );
  assert.deepEqual(
    lines.slice(0, 2).map((l) => l.elapsedMs),
    [60_000, 120_000],
  );
  const fin = makeTick({ name: ['hbf'], heartbeatMs: 60_000 });
  const c2 = new FakeClock();
  const p2 = runInProcess(['hbf', '--count', '1', '--interval-ms', '150000'], { clock: c2, commands: [fin] });
  await c2.advance(150_000);
  const doc = JSON.parse((await p2).stdout);
  const events = parse(readFileSync(doc.eventsPath, 'utf8').trimEnd().split('\n'));
  assert.ok(!events.some((e) => e.type === 'heartbeat'));
});

test('SIGTERM, graceful: the generator returns its interrupted summary; exit 143', async () => {
  for (const mode of [[], ['--stream']]) {
    const clock = new FakeClock();
    const shutdown = createShutdown();
    const p = runInProcess(['test', 'tick', '--count', '5', ...mode], { clock, shutdown });
    await clock.advance(1_500);
    shutdown.trigger('SIGTERM');
    const r = await p;
    assert.equal(r.exitCode, EXIT.SIGTERM);
    assert.equal(r.forced, false);
    const last = JSON.parse(r.lines.at(-1) as string);
    assert.equal(last.outcome, 'interrupted');
    if (mode.length) assert.equal(last.type, 'summary');
    else assert.equal(r.lines.length, 1);
  }
});

test('SIGINT, ungraceful (abort propagates): terminal INTERRUPTED error; exit 130', async () => {
  const clock = new FakeClock();
  const shutdown = createShutdown();
  const p = runInProcess(['test', 'tick', '--stream', '--count', '5', '--no-graceful'], { clock, shutdown });
  await clock.advance(1_500);
  shutdown.trigger('SIGINT');
  const r = await p;
  const lines = parse(r.lines);
  assert.deepEqual(
    lines.map((l) => l.type),
    ['tick', 'error'],
  );
  assert.equal(lines[1]?.error.code, 'INTERRUPTED');
  assert.equal(r.exitCode, EXIT.SIGINT);
});

test('a generator that never settles is abandoned after the 3 s grace window (forced)', async () => {
  const clock = new FakeClock();
  const shutdown = createShutdown();
  const p = runInProcess(['test', 'tick', '--count', '5', '--ignore-abort'], { clock, shutdown });
  await flush();
  shutdown.trigger('SIGTERM');
  await clock.advance(2_999);
  let settled = false;
  void p.then(() => {
    settled = true;
  });
  await flush();
  assert.equal(settled, false);
  await clock.advance(1);
  const r = await p;
  assert.equal(r.forced, true);
  assert.equal(r.lines.length, 1);
  assert.equal(JSON.parse(r.stdout).error.code, 'INTERRUPTED');
  assert.equal(r.exitCode, EXIT.SIGTERM);
});

test('a second signal skips the grace window', async () => {
  const clock = new FakeClock();
  const shutdown = createShutdown();
  const p = runInProcess(['test', 'tick', '--stream', '--count', '5', '--ignore-abort'], { clock, shutdown });
  await flush();
  shutdown.trigger('SIGTERM');
  await flush();
  shutdown.trigger('SIGTERM');
  const r = await p;
  assert.equal(r.forced, true);
  assert.equal(clock.monotonic(), 0);
  assert.equal(parse(r.lines).at(-1)?.type, 'error');
});

test('deadline: a graceful generator returns its timeout summary; otherwise TIMEOUT exit 8', async () => {
  const dl = makeTick({ name: ['dl'], timeout: { defaultMs: 10_000, maxMs: 60_000 } });
  const clock = new FakeClock();
  const p = runInProcess(['dl', '--count', '100'], { clock, commands: [dl] });
  await clock.advance(10_000);
  const r = await p;
  assert.equal(JSON.parse(r.stdout).outcome, 'timeout');
  assert.equal(r.exitCode, 0);
  const c2 = new FakeClock();
  const p2 = runInProcess(['dl', '--count', '100', '--no-graceful', '--timeout', '5s'], { clock: c2, commands: [dl] });
  await c2.advance(5_000);
  const r2 = await p2;
  assert.equal(JSON.parse(r2.stdout).error.code, 'TIMEOUT');
  assert.equal(r2.exitCode, EXIT.TIMEOUT);
});

test('no deadline: runs past any default and refuses --timeout', async () => {
  const clock = new FakeClock();
  const p = runInProcess(['test', 'tick', '--count', '2', '--interval-ms', '7200000'], { clock });
  await clock.advance(4 * 3_600_000);
  assert.equal(JSON.parse((await p).stdout).outcome, 'ok');
  const r = await runInProcess(['test', 'tick', '--timeout', '1m']);
  assert.equal(r.json.error.code, 'USAGE_UNKNOWN_FLAG');
});

test('oversized event lines are spilled; the terminal line is bounded by maxBytes', async () => {
  const r = await run(['--stream', '--count', '2', '--payload-bytes', '5000']);
  const lines = parse(r.lines);
  assert.ok(r.lines.slice(0, 2).every((l) => Buffer.byteLength(l) <= 4096));
  assert.equal(typeof lines[0]?.spilled, 'string');
  assert.equal(JSON.parse(readFileSync(lines[0]?.spilled, 'utf8')).pad.length, 5000);
  const big = await run(['--count', '1', '--summary-bytes', '20000']);
  assert.equal(big.json.spilled, true);
  assert.equal(JSON.parse(readFileSync(big.json.path, 'utf8')).pad.length, 20000);
});

test('ndjson: a spilled terminal line still has type, seq and at, so the last line is the summary', async () => {
  const r = await run(['--stream', '--count', '1', '--summary-bytes', '20000']);
  const lines = parse(r.lines);
  const last = lines.at(-1);
  assert.equal(last?.type, 'summary');
  assert.equal(last?.seq, lines.length - 1);
  assert.match(last?.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(last?.spilled, true);
  assert.deepEqual(Object.keys(last ?? {}), ['type', 'seq', 'at', 'spilled', 'path', 'bytes']);
  const full = readFileSync(last?.path, 'utf8');
  assert.equal(Buffer.byteLength(full), last?.bytes);
  assert.equal(JSON.parse(full).pad.length, 20000);
  const file = readFileSync(lines[0]?.eventsPath ?? JSON.parse(full).eventsPath, 'utf8')
    .trimEnd()
    .split('\n');
  assert.deepEqual(file, r.lines, 'stdout lines are identical to the events file');
});

test('stream --schema reports event and summary; --dry-run on a read stream is refused', async () => {
  const s = await runInProcess(['test', 'tick', '--schema']);
  assert.equal(s.json.mode, 'stream');
  assert.ok(s.json.event.oneOf || s.json.event.anyOf);
  assert.ok(s.json.summary.properties.outcome);
  const d = await runInProcess(['test', 'tick', '--dry-run']);
  assert.equal(d.json.error.code, 'USAGE_UNKNOWN_FLAG');
});
