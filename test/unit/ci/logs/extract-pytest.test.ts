import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractFailures } from '../../../../src/ci/logs/extract/index.ts';
import { pytest } from '../../../../src/ci/logs/extract/pytest.ts';
import { analyzeRecorded } from './_recorded.ts';

test('recorded pytest log (pytest-dev/pytest): the FAILED id from the short summary, not nested pytest output', async () => {
  const a = await analyzeRecorded('pytest');
  assert.equal(a.step?.name, 'Test with coverage');
  assert.ok(a.runners.includes('pytest'));
  assert.deepEqual(a.tests, [
    'testing/test_collection.py::TestOverlappingCollectionArguments::test_multiple_file_args_do_not_rescan_parent_directory',
  ]);
  assert.ok(a.errors[0]?.startsWith('ValueError: Pytest terminal summary report not found.'));
  assert.ok(a.errors.every((e) => e.length <= 300));
});

test('synthetic pytest: FAILED path::test - AssertionError, parametrised ids, ERROR lines, === 1 failed', () => {
  const lines = [
    '============================= test session starts ==============================',
    'py/test_sandbox.py F.                                                     [100%]',
    '=================================== FAILURES ===================================',
    '___________________________________ test_x ____________________________________',
    'E       assert 3 == 4',
    '=========================== short test summary info ============================',
    'FAILED py/test_sandbox.py::test_x - AssertionError',
    'FAILED py/test_sandbox.py::test_p[a-1]',
    'ERROR py/test_conf.py - ImportError: no module named x',
    '========================= 2 failed, 1 passed, 1 error in 0.12s =========================',
  ];
  assert.ok(pytest.detect(lines));
  const f = extractFailures(lines);
  assert.deepEqual(f.tests, ['py/test_sandbox.py::test_x', 'py/test_sandbox.py::test_p[a-1]']);
  assert.deepEqual(f.errors.slice(0, 2), ['AssertionError', 'py/test_conf.py - ImportError: no module named x']);
});

test('without a short summary, E lines are the errors', () => {
  const lines = ['=== test session starts ===', 'E       assert 3 == 4', '=== 1 failed in 0.01s ==='];
  assert.deepEqual(extractFailures(lines).errors, ['assert 3 == 4']);
});
