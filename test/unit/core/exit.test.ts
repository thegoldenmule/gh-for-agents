import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ERROR_CODES, type ErrorSpec } from '../../../src/core/errors.ts';
import { CI_WAIT_EXIT_PRECEDENCE, ExitCode, exitForSignal } from '../../../src/core/exit.ts';
import { EXIT, EXIT_TABLE } from '../../contract/exit-table.ts';

test('src ExitCode matches the contract table copy exactly', () => {
  assert.deepEqual({ ...ExitCode }, { ...EXIT });
  const tableExits = EXIT_TABLE.map((r) => r.exit).sort((a, b) => a - b);
  assert.deepEqual(
    Object.values(ExitCode).sort((a, b) => a - b),
    tableExits,
  );
});

test('every static exit in ERROR_CODES is a row of the table', () => {
  const exits = new Set<number>(EXIT_TABLE.map((r) => r.exit));
  for (const [code, spec] of Object.entries(ERROR_CODES) as [string, ErrorSpec][]) {
    if (typeof spec.exit === 'number') assert.ok(exits.has(spec.exit), `${code} exits ${spec.exit}`);
  }
});

test('signal exits: SIGINT 130, everything else 143', () => {
  assert.equal(exitForSignal('SIGINT'), EXIT.SIGINT);
  assert.equal(exitForSignal('SIGTERM'), EXIT.SIGTERM);
  assert.equal(exitForSignal('SIGHUP'), EXIT.SIGTERM);
  assert.equal(exitForSignal('EPIPE'), EXIT.SIGTERM);
});

test('ci wait aggregate precedence is 10 > 14 > 13 > 12 > 15 > 11 > 0', () => {
  assert.deepEqual(CI_WAIT_EXIT_PRECEDENCE, [
    EXIT.CI_RED,
    EXIT.CI_STALLED,
    EXIT.NO_CHECKS,
    EXIT.SUPERSEDED,
    EXIT.CI_PENDING_RESUME,
    EXIT.CI_RED_SHARED,
    EXIT.OK,
  ]);
});
