import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { stripAnsi, stripLine, stripLineWithTs, stripLogFile, stripText } from '../../../../src/ci/logs/strip.ts';
import { tempRoot } from '../_helpers.ts';

const E = '\u001b';

test('SGR colour codes are removed, including bold/dim pairs', () => {
  assert.equal(stripAnsi(`${E}[36;1mgo test ./...${E}[0m`), 'go test ./...');
  assert.equal(stripAnsi(`${E}[2mdim${E}[22m and ${E}[41m${E}[1m FAIL ${E}[22m${E}[49m`), 'dim and  FAIL ');
  assert.equal(stripAnsi(`${E}[K${E}[2Jcleared`), 'cleared');
});

test('OSC 8 hyperlinks keep their visible text (BEL and ST terminators)', () => {
  assert.equal(stripAnsi(`see ${E}]8;;https://example.com${E}\\docs${E}]8;;${E}\\ now`), 'see docs now');
  assert.equal(stripAnsi(`${E}]8;;https://x.test\u0007link${E}]8;;\u0007`), 'link');
});

test('lone CR progress redraws keep only the final state; a CRLF ending is just a line end', () => {
  assert.equal(stripLine('progress 10%\rprogress 50%\rprogress 100%'), 'progress 100%');
  assert.equal(stripLine('done\r'), 'done');
  assert.equal(stripLine('2026-10-21T16:55:29.0214049Z a\rb\r'), 'b');
});

test('the BOM at byte 0 is removed', () => {
  assert.equal(stripLine('\ufeff2026-10-21T09:10:37.8931002Z Current runner version'), 'Current runner version');
});

test('the ISO timestamp prefix is removed and returned', () => {
  assert.deepEqual(stripLineWithTs('2026-10-21T16:55:29.0214049Z ##[group]Run pnpm test'), {
    text: '##[group]Run pnpm test',
    ts: '2026-10-21T16:55:29.0214049Z',
  });
  assert.deepEqual(stripLineWithTs('2026-10-21T16:55:29.0214049Z'), { text: '', ts: '2026-10-21T16:55:29.0214049Z' });
  assert.deepEqual(stripLineWithTs('no timestamp here'), { text: 'no timestamp here', ts: null });
});

test("gh's --log-failed prefix (job, UNKNOWN STEP, timestamp) is removed (§6)", () => {
  assert.equal(
    stripLine('test (ubuntu)\tUNKNOWN STEP\t2026-10-21T16:55:29.0214049Z  FAIL  src/a.test.ts'),
    ' FAIL  src/a.test.ts',
  );
  assert.equal(stripLine('build\tUNKNOWN STEP\t2026-10-21T16:55:29.0214049Z\t##[error]boom'), '##[error]boom');
  // A tab inside ordinary output is untouched.
  assert.equal(stripLine('FAIL\tgithub.com/x/y\t0.12s'), 'FAIL\tgithub.com/x/y\t0.12s');
});

test('stripText cleans a whole log', () => {
  assert.deepEqual(stripText(`\ufeff2026-10-21T09:10:37.1Z ${E}[31ma${E}[0m\n2026-10-21T09:10:37.2Z b\n`), ['a', 'b']);
});

test('stripLogFile streams a 2.3 MB log line by line, reporting timestamps per line', async () => {
  const dir = tempRoot();
  const src = join(dir, 'big.raw');
  const dest = join(dir, 'big.log');
  const line = `2026-10-21T16:55:29.0214049Z ${E}[36;1m${'x'.repeat(80)}${E}[0m\n`;
  const n = Math.ceil((2.3 * 1024 * 1024) / Buffer.byteLength(line));
  writeFileSync(src, `\ufeff${line.repeat(n)}`);
  assert.ok(statSync(src).size >= 2.3 * 1024 * 1024);
  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  const before = process.memoryUsage().heapUsed;
  let peak = before;
  let withTs = 0;
  const r = await stripLogFile(src, dest, (_t, i, ts) => {
    if (ts) withTs++;
    if (i % 2000 === 0) peak = Math.max(peak, process.memoryUsage().heapUsed);
  });
  assert.equal(r.lines, n);
  assert.equal(withTs, n);
  assert.equal(r.bytes, statSync(dest).size);
  assert.equal(r.bytes, n * 81);
  const out = readFileSync(dest, 'utf8');
  assert.ok(!out.includes(E) && !out.includes('\ufeff') && !out.includes('2026-10-21T'));
  // Heap growth is only meaningful with --expose-gc; without it, correctness is what is asserted.
  if (gc) assert.ok(peak - before < 3 * statSync(src).size, `heap grew ${peak - before} bytes`);
});

test('stripLogFile with a start offset drops the partial first line and keeps the tail', async () => {
  const src = join(tempRoot(), 'offset.raw');
  const dest = join(tempRoot(), 'offset.log');
  writeFileSync(src, 'first line\nsecond line\nthird line\n');
  const r = await stripLogFile(src, dest, undefined, { start: 3 });
  assert.equal(readFileSync(dest, 'utf8'), 'second line\nthird line\n');
  assert.equal(r.lines, 2);
});
