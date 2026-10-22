import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractFailures } from '../../../../src/ci/logs/extract/index.ts';
import { nodeTest } from '../../../../src/ci/logs/extract/node-test.ts';
import { analyzeRecorded } from './_recorded.ts';

test('recorded node:test spec log (nodejs/undici): ✖ test once, the ##[error] message, not the header', async () => {
  const a = await analyzeRecorded('node-test');
  assert.equal(a.step?.name, 'Test unit');
  assert.ok(a.runners.includes('node-test'));
  assert.deepEqual(a.tests, ['Should handle http2 stream timeout']);
  assert.ok(a.errors.includes('Error: read ECONNRESET'));
  assert.ok(!a.tests.includes('failing tests:'));
});

test('synthetic TAP: not ok lines (nested), SKIP/TODO ignored', () => {
  const lines = [
    'TAP version 13',
    '# Subtest: math',
    '    # Subtest: adds',
    '    not ok 1 - adds',
    '      ---',
    "      error: 'Expected values to be strictly equal:\\n\\n3 !== 4\\n'",
    '      ...',
    '    not ok 2 - flaky # SKIP',
    '    not ok 3 - later # TODO',
    'not ok 1 - math',
    '1..1',
    '# tests 3',
    '# fail 1',
  ];
  assert.ok(nodeTest.detect(lines));
  assert.deepEqual(extractFailures(lines).tests, ['adds', 'math']);
});

test('synthetic spec reporter: ✖ name (duration), repeated under failing tests:, AssertionError', () => {
  const lines = [
    '▶ math',
    '  ✖ adds (1.2ms)',
    '    AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    '✖ math (2.0ms)',
    'ℹ tests 2',
    'ℹ fail 1',
    '✖ failing tests:',
    'test at test/math.test.js:3:3',
    '✖ adds (1.2ms)',
  ];
  const f = extractFailures(lines);
  assert.deepEqual(f.tests, ['adds', 'math']);
  assert.deepEqual(f.errors, ['AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:']);
});

test('node:test names keep a # that is not a TAP directive', () => {
  const lines = [
    'TAP version 13',
    'not ok 1 - handles issue #42',
    'not ok 2 - flaky # SKIP',
    '✖ parses # comments (1.1ms)',
    '# tests 3',
    '# fail 2',
  ];
  assert.deepEqual(extractFailures(lines).tests, ['handles issue #42', 'parses # comments']);
});
