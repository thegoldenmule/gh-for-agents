import assert from 'node:assert/strict';
import { test } from 'node:test';
import { goTest } from '../../../../src/ci/logs/extract/go-test.ts';
import { extractFailures } from '../../../../src/ci/logs/extract/index.ts';
import { analyzeRecorded } from './_recorded.ts';

test('recorded go test log (grpc/grpc-go): the failing subtest (not its parent), file:line error, FAIL pkg', async () => {
  const a = await analyzeRecorded('go');
  assert.equal(a.step?.name, 'Run tests');
  assert.ok(a.runners.includes('go-test'));
  assert.deepEqual(a.tests, ['Test/BidirectionalDraining_ContinuousStreaming']);
  assert.ok(a.errors[0]?.startsWith('ext_proc_ext_test.go:7055: Receiver goroutine failed'));
  assert.ok(a.errors.includes('FAIL google.golang.org/grpc/internal/xds/httpfilter/extproc'));
});

test('synthetic go test: --- FAIL TestX, subtests TestX/sub, FAIL\\tpkg, panic', () => {
  const lines = [
    '=== RUN   TestParse',
    '=== RUN   TestParse/empty',
    '    parse_test.go:12: got "", want "x"',
    '--- FAIL: TestParse (0.00s)',
    '    --- FAIL: TestParse/empty (0.00s)',
    '--- FAIL: TestOther (0.01s)',
    'FAIL',
    'FAIL\tgithub.com/acme/sandbox/parse\t0.004s',
    'ok  \tgithub.com/acme/sandbox/util\t0.002s',
    'panic: runtime error: index out of range [3] with length 3',
  ];
  assert.ok(goTest.detect(lines));
  const f = extractFailures(lines);
  assert.deepEqual(f.tests, ['TestParse/empty', 'TestOther']);
  assert.deepEqual(f.errors, [
    'parse_test.go:12: got "", want "x"',
    'panic: runtime error: index out of range [3] with length 3',
    'FAIL github.com/acme/sandbox/parse',
  ]);
});
