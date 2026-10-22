import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isControlFlow, rethrowControlFlow } from '../../../src/core/control-flow.ts';
import { GhxError } from '../../../src/core/errors.ts';
import { DryRunHalt, GhFailure } from '../../../src/gh/index.ts';

const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
const CONTROL = [
  new DryRunHalt(['gh', 'pr', 'merge', '1'], undefined),
  new GhxError('INTERRUPTED', 'Interrupted by SIGTERM.', { details: { signal: 'SIGTERM' } }),
  new GhxError('TIMEOUT', 'deadline'),
  abortError,
];
const ORDINARY = [
  new GhxError('PR_NOT_FOUND', 'nope'),
  new GhFailure({ code: 'GH_TRANSIENT', transient: true }, 'GH_FAILED', 'flaky', {}),
  new Error('boom'),
  'a string',
  undefined,
];

test('isControlFlow: DryRunHalt, INTERRUPTED, TIMEOUT and AbortError, nothing else', () => {
  for (const e of CONTROL) assert.equal(isControlFlow(e), true, String(e));
  for (const e of ORDINARY) assert.equal(isControlFlow(e), false, String(e));
});

test('rethrowControlFlow: the catch-all pattern lets control flow through and keeps the rest', async () => {
  const handler = async (thrown: unknown): Promise<string> => {
    try {
      throw thrown;
    } catch (e) {
      rethrowControlFlow(e);
      return 'swallowed';
    }
  };
  for (const e of CONTROL) await assert.rejects(handler(e), (x) => x === e);
  for (const e of ORDINARY) assert.equal(await handler(e), 'swallowed');
});
