import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractFailures } from '../../../../src/ci/logs/extract/index.ts';
import { jest } from '../../../../src/ci/logs/extract/jest.ts';
import { analyzeRecorded } from './_recorded.ts';

test('recorded jest log (facebook/react): the ● test, listed once though the summary repeats it', async () => {
  const a = await analyzeRecorded('jest');
  assert.equal(a.step?.number, 9);
  assert.ok(a.runners.includes('jest'));
  assert.ok(!a.runners.includes('vitest'));
  assert.deepEqual(a.tests, ['ReactFlightDOMEdge › can pass a large typed array from two places']);
  assert.equal(a.errors[0], 'asserConsoleLogsCleared(expected)');
  assert.equal(a.exitLine, 'Process completed with exit code 1.');
});

test('synthetic jest: ● suite › test, Tests: 1 failed, matcher line, suite failed to run', () => {
  const lines = [
    ' FAIL  src/sum.test.js',
    '  ● sum › adds 1 + 2 to equal 3',
    '',
    '    expect(received).toBe(expected) // Object.is equality',
    '',
    ' FAIL  src/broken.test.js',
    '  ● Test suite failed to run',
    '',
    "    Cannot find module './missing' from 'src/broken.test.js'",
    '',
    'Test Suites: 2 failed, 2 total',
    'Tests:       1 failed, 1 passed, 2 total',
  ];
  assert.ok(jest.detect(lines));
  const f = extractFailures(lines);
  assert.deepEqual(f.runners, ['jest']);
  assert.deepEqual(f.tests, ['sum › adds 1 + 2 to equal 3']);
  assert.deepEqual(f.errors, [
    'expect(received).toBe(expected) // Object.is equality',
    "Cannot find module './missing' from 'src/broken.test.js'",
  ]);
});
