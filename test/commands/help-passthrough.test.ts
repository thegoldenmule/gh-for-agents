// `ghx help <gh read>` (02 §10): an allowlisted passthrough read is explained, not called unknown.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInProcess } from '../helpers/harness.ts';

test('ghx help pr diff explains that it runs through passthrough, with no gh call', async () => {
  for (const words of [['pr', 'diff'], ['run', 'view'], ['api']]) {
    const r = await runInProcess(['help', ...words]);
    assert.equal(r.exitCode, 0, r.stdout);
    assert.equal(r.json.name, words.join(' '));
    assert.equal(r.json.passthrough, true);
    assert.match(r.json.summary, /through passthrough, an allowlisted gh read/);
    assert.deepEqual(r.calls, []);
  }
});

test('ghx help still refuses wrapped and unknown commands', async () => {
  const wrapped = await runInProcess(['help', 'pr', 'view']);
  assert.equal(wrapped.json.error.code, 'USAGE_UNKNOWN_COMMAND');
  assert.deepEqual(wrapped.json.error.details.suggestion, ['ghx', 'pr', 'status', '<pr>']);
  const unknown = await runInProcess(['help', 'nope', 'never']);
  assert.equal(unknown.json.error.code, 'USAGE_UNKNOWN_COMMAND');
});
