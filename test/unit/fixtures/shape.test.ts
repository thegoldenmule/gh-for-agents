import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffShapes, fixtureShape, jsonShape } from '../../../scripts/fixtures/shape.ts';

test('jsonShape keeps key sets and types, not values', () => {
  assert.deepEqual(jsonShape({ b: 1, a: [{ x: 's' }, { x: 't' }], n: null }), {
    a: [{ x: 'string' }],
    b: 'number',
    n: 'null',
  });
});

test('same shape with different values: no diff; numbers in stderr are masked', () => {
  const a = fixtureShape({
    exitCode: 1,
    stdout:
      'HTTP/2.0 404 Not Found\nDate: x\nX-Github-Request-Id: 1\nContent-Type: json\n\n{"message":"Not Found","id":1}',
    stderr: 'gh: Not Found (HTTP 404) run 123',
  });
  const b = fixtureShape({
    exitCode: 1,
    stdout: 'HTTP/1.1 404 Not Found\r\nContent-Type: json\r\n\r\n{"message":"Gone","id":999}',
    stderr: 'gh: Not Found (HTTP 404) run 456',
  });
  assert.deepEqual(diffShapes('x', a, b), []);
});

test('a changed key set, status or exit code is reported', () => {
  const a = fixtureShape({ exitCode: 0, stdout: 'HTTP/2.0 200 OK\n\n{"a":1}', stderr: '' });
  const b = fixtureShape({ exitCode: 0, stdout: 'HTTP/2.0 200 OK\n\n{"a":1,"b":2}', stderr: '' });
  const c = fixtureShape({ exitCode: 1, stdout: 'HTTP/2.0 410 Gone\n\n', stderr: 'gh: Server Error (HTTP 410)' });
  assert.equal(diffShapes('x', a, b).length, 1);
  assert.match(diffShapes('x', a, b)[0] ?? '', /body shape/);
  assert.equal(diffShapes('x', a, c).length, 4);
});

test('non-JSON bodies are text or empty', () => {
  assert.equal(fixtureShape({ exitCode: 0, stdout: 'gh version 2.86.0', stderr: '' }).body, 'text');
  assert.equal(fixtureShape({ exitCode: 0, stdout: '', stderr: '' }).body, 'empty');
});
