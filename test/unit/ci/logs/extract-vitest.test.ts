import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractFailures } from '../../../../src/ci/logs/extract/index.ts';
import { vitest, vitestFailName } from '../../../../src/ci/logs/extract/vitest.ts';
import { analyzeRecorded } from './_recorded.ts';

test('recorded vitest log (vitest-dev/vitest): one test despite three FAIL blocks; snapshot error; exit line', async () => {
  const a = await analyzeRecorded('vitest');
  assert.deepEqual(a.step, { number: 8, name: 'Test E2E' });
  assert.ok(a.runners.includes('vitest'));
  assert.deepEqual(a.tests, ['test/watch/snapshot-review.test.ts > updates accepted snapshots']);
  assert.ok(
    a.errors.some((e) => e.startsWith('Error: Snapshot `updates accepted snapshots > review-11-47 1` mismatched')),
  );
  assert.equal(a.exitLine, 'Process completed with exit code 1.');
  assert.ok(a.excerpt.includes('FAIL') && a.excerpt.split('\n').length <= 20 && a.excerpt.length <= 2000);
  assert.ok(a.logPath?.endsWith('job-119784717653.log'));
});

test('synthetic vitest: ×/✗ lines, FAIL path > suite > test, Test Files summary, AssertionError', () => {
  const lines = [
    ' RUN  v3.2.4 /home/runner/work/sandbox/sandbox',
    ' ❯ src/math.test.ts (2 tests | 1 failed) 4ms',
    '   ✓ math > subtracts 1ms',
    '   × math > adds 3ms',
    '   ✗ math > divides',
    '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
    ' FAIL  src/math.test.ts > math > adds',
    'AssertionError: expected 3 to equal 4',
    ' ❯ src/math.test.ts:5:17',
    ' Test Files  1 failed (1)',
    '      Tests  1 failed | 1 passed (2)',
  ];
  assert.ok(vitest.detect(lines));
  const f = extractFailures(lines);
  // `× math > adds` is the same test as the FAIL line, listed once; `✗ math > divides` has no FAIL line.
  assert.deepEqual(f.tests, ['src/math.test.ts > math > adds', 'math > divides']);
  assert.deepEqual(f.errors, ['AssertionError: expected 3 to equal 4']);
  assert.equal(f.firstLine, 3);
});

test('FAIL names drop the project label and the :line suffix', () => {
  assert.equal(vitestFailName(' main  test/a.test.ts:18 > suite > it works'), 'test/a.test.ts > suite > it works');
  assert.equal(vitestFailName('packages/x/src/b.spec.tsx:3:9 > b'), 'packages/x/src/b.spec.tsx > b');
  assert.equal(vitestFailName('src/broken.test.ts [ src/broken.test.ts ]'), 'src/broken.test.ts');
  assert.equal(vitestFailName('not a file at all'), null);
});
