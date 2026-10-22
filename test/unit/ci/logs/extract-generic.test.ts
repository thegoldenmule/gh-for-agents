import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capLine, excerpt, extractFailures } from '../../../../src/ci/logs/extract/index.ts';
import { corpusLog } from './_recorded.ts';

test('cancelled (corpus-shape): ##[error]The operation was canceled. is an error; end-action lines are ignored', () => {
  const f = extractFailures(corpusLog('cancelled.log'));
  assert.deepEqual(f.errors, ['The operation was canceled.']);
  assert.equal(f.exitLine, null);
  assert.deepEqual(f.tests, []);
});

test('pnpm-err (corpus-shape): ERR_PNPM_* line and the exit line', () => {
  const f = extractFailures(corpusLog('pnpm-err.log'));
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0] ?? '', /^ERR_PNPM_OUTDATED_LOCKFILE {2}Cannot install with "frozen-lockfile"/);
  assert.equal(f.exitLine, 'Process completed with exit code 1.');
  // Nothing recognised as a runner: the excerpt is the tail before the exit line.
  const ex = excerpt(corpusLog('pnpm-err.log'), null);
  assert.ok(ex.includes('ERR_PNPM_OUTDATED_LOCKFILE'));
  assert.ok(!ex.includes('Process completed'));
});

test('ci.logPatterns add matching lines to errors; an invalid pattern is skipped', () => {
  const lines = ['building', 'TS2322: Type string is not assignable to type number', 'done'];
  assert.deepEqual(extractFailures(lines, { logPatterns: ['^TS\\d+:', '('] }).errors, [
    'TS2322: Type string is not assignable to type number',
  ]);
});

test('caps: 30 tests, 20 errors, 300 chars per line; duplicates collapse', () => {
  const lines = [
    ...Array.from({ length: 40 }, (_, i) => `--- FAIL: Test${i} (0.00s)`),
    ...Array.from({ length: 30 }, (_, i) => `Error: e${i}`),
    'Error: e1',
    `Error: ${'x'.repeat(400)}`,
  ];
  const f = extractFailures(lines);
  assert.equal(f.tests.length, 30);
  assert.equal(f.errors.length, 20);
  assert.equal(new Set(f.errors).size, 20);
  assert.equal(capLine('y'.repeat(400)).length, 300);
  assert.ok(capLine('y'.repeat(400)).endsWith('…'));
});

test('excerpt: starts 2 lines before the first failure, drops markers, honours line and char caps', () => {
  const lines = ['a', 'b', 'c', '##[group]x', 'FAIL here', ...Array.from({ length: 100 }, (_, i) => `l${i}`)];
  const ex = excerpt(lines, 4);
  assert.deepEqual(ex.split('\n').slice(0, 3), ['b', 'c', 'FAIL here']);
  assert.equal(ex.split('\n').length, 20);
  assert.equal(excerpt(lines, 4, { maxLines: 500 }).split('\n').length, 60);
  const long = Array.from({ length: 60 }, () => 'z'.repeat(299));
  assert.ok(excerpt(long, 0, { maxLines: 60 }).length <= 2000);
});

test('extractFailures flags a test list cut at the cap', () => {
  const lines = Array.from({ length: 35 }, (_, i) => `--- FAIL: Test${i} (0.00s)`);
  const f = extractFailures(lines);
  assert.equal(f.tests.length, 30);
  assert.equal(f.testsTruncated, true);
  assert.equal(extractFailures(lines.slice(0, 30)).testsTruncated, false);
});
