// Warnings survive a failure (02 §1.3): what a command warned before it failed rides in the error
// envelope as error.details.warnings, so a normalized-then-rejected input still says what was changed.
// The envelope keeps its four keys; details is created when the error had none.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ErrorEnvelope } from '../../src/core/envelopes.ts';
import { spawnGhx } from '../helpers/spawn.ts';
import { EXIT } from './exit-table.ts';

const HOOKS = { GHX_TEST_HOOKS: '1' };
const WARNING = { code: 'T_NORMALIZED', message: 'rewrote the input before failing' };

const run = async (fail: string, ...extra: string[]) => {
  const r = await spawnGhx(['test', 'warn-fail', '--fail', fail, ...extra], { env: HOOKS });
  const doc = JSON.parse(r.stdout);
  assert.ok(ErrorEnvelope.safeParse(doc).success, r.stdout);
  assert.deepEqual(Object.keys(doc.error), ['code', 'message', 'hint', 'details']);
  return { exitCode: r.exitCode, error: doc.error };
};

test('an error without details gets details.warnings', async () => {
  const { exitCode, error } = await run('bare');
  assert.equal(exitCode, EXIT.GH_FAILED);
  assert.equal(error.code, 'GH_FAILED');
  assert.deepEqual(error.details, { warnings: [WARNING] });
});

test("an error's own details are kept, and its own warnings come first", async () => {
  const { exitCode, error } = await run('details');
  assert.equal(exitCode, EXIT.USAGE);
  assert.equal(error.details.issues[0].code, 'x.bad');
  assert.deepEqual(error.details.warnings, [{ code: 'T_OWN', message: 'carried by the error' }, WARNING]);
});

test('an unexpected throw (INTERNAL) keeps the stack path and the warnings', async () => {
  const { exitCode, error } = await run('internal');
  assert.equal(exitCode, EXIT.INTERNAL);
  assert.equal(error.code, 'INTERNAL');
  assert.equal(typeof error.details.stackPath, 'string');
  assert.deepEqual(error.details.warnings, [WARNING]);
});

test('--fields never trims the error envelope or its warnings', async () => {
  const { error } = await run('bare', '--fields', 'ok');
  assert.deepEqual(error.details, { warnings: [WARNING] });
});

test('a final-mode stream carries them too; NDJSON already printed them as warning lines', async () => {
  const argv = ['test', 'tick', '--count', '2', '--interval-ms', '0', '--warn-at', '1', '--fail-at', '2'];
  const final = await spawnGhx(argv, { env: HOOKS });
  assert.equal(final.exitCode, EXIT.GH_FAILED, final.stdout);
  const doc = JSON.parse(final.stdout);
  assert.ok(ErrorEnvelope.safeParse(doc).success, final.stdout);
  assert.deepEqual(doc.error.details.warnings, [{ code: 'TICK_WARNING', message: 'warning at 1' }]);
  const nd = await spawnGhx([...argv, '--stream'], { env: HOOKS });
  const lines = nd.stdout
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.type === 'warning' && l.code === 'TICK_WARNING'));
  assert.equal(lines.at(-1).type, 'error');
  assert.equal(lines.at(-1).error.details, null);
});
