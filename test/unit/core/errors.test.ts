import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import {
  ERROR_CODES,
  exitCodeFor,
  formatPath,
  GhxError,
  isErrorCode,
  mapZodIssues,
  objectKeysAt,
  publicCodeFor,
  toErrorObject,
} from '../../../src/core/errors.ts';
import { suggest } from '../../../src/core/suggest.ts';
import { EXIT } from '../../contract/exit-table.ts';

test('error envelope always has all four keys, null when empty', () => {
  const o = toErrorObject(new GhxError('VALIDATION', 'bad'));
  assert.deepEqual(Object.keys(o.error), ['code', 'message', 'hint', 'details']);
  assert.equal(o.error.hint, null);
  assert.equal(o.error.details, null);
});

test('empty details object becomes null; default hint fills in', () => {
  const o = toErrorObject(new GhxError('ENV_GH_MISSING', 'gh not found on PATH.', { details: {} }));
  assert.equal(o.error.details, null);
  assert.match(o.error.hint ?? '', /gh auth login/);
});

test('explicit hint and details win', () => {
  const o = toErrorObject(new GhxError('PR_NOT_FOUND', 'No PR', { hint: 'pass -R', details: { repo: 'o/r' } }));
  assert.deepEqual(o.error, { code: 'PR_NOT_FOUND', message: 'No PR', hint: 'pass -R', details: { repo: 'o/r' } });
});

test('a non-GhxError becomes INTERNAL', () => {
  const o = toErrorObject(new TypeError('boom'));
  assert.equal(o.error.code, 'INTERNAL');
  assert.match(o.error.message, /boom/);
  assert.equal(o.error.details, null);
});

test('exit codes follow the catalogue, including dynamic ones', () => {
  assert.equal(new GhxError('VALIDATION', 'x').exitCode, EXIT.USAGE);
  assert.equal(new GhxError('HEAD_MOVED', 'x').exitCode, EXIT.STATE);
  assert.equal(exitCodeFor('MERGE_BLOCKED', { exitClass: 'state' }), EXIT.STATE);
  assert.equal(exitCodeFor('MERGE_BLOCKED', { exitClass: 'policy' }), EXIT.POLICY);
  assert.equal(exitCodeFor('INTERRUPTED', { signal: 'SIGINT' }), EXIT.SIGINT);
  assert.equal(exitCodeFor('INTERRUPTED', { signal: 'SIGTERM' }), EXIT.SIGTERM);
  assert.equal(exitCodeFor('READBACK_MISMATCH'), EXIT.GH_FAILED);
  assert.equal(exitCodeFor('DIFF_TOO_LARGE'), EXIT.GH_FAILED);
  assert.equal(exitCodeFor('PASSTHROUGH_WRITE_REFUSED'), EXIT.POLICY);
});

test('isErrorCode guards the registry', () => {
  assert.ok(isErrorCode('GH_FAILED'));
  assert.ok(!isErrorCode('GH_TRANSIENT'));
  assert.ok(!isErrorCode('toString'));
});

test('error names are SCREAMING_SNAKE', () => {
  for (const k of Object.keys(ERROR_CODES)) assert.match(k, /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/);
});

test('internal gh codes map to public ones (03 §1 row 9)', () => {
  assert.equal(publicCodeFor('GH_NOT_INSTALLED'), 'ENV_GH_MISSING');
  assert.equal(publicCodeFor('GH_AUTH'), 'ENV_GH_AUTH');
  assert.equal(publicCodeFor('GH_TRANSIENT'), 'GH_FAILED');
  assert.equal(publicCodeFor('GH_TIMEOUT'), 'GH_FAILED');
  assert.equal(publicCodeFor('GH_RATE_LIMITED'), 'GH_RATE_LIMITED');
  assert.equal(publicCodeFor('GH_NOT_FOUND', 'PR_NOT_FOUND'), 'PR_NOT_FOUND');
  assert.equal(publicCodeFor('GH_NOT_FOUND', 'RUN_NOT_FOUND'), 'RUN_NOT_FOUND');
  assert.equal(publicCodeFor('GH_TOO_LARGE'), 'DIFF_TOO_LARGE');
});

test('formatPath renders dotted paths with indices', () => {
  assert.equal(formatPath(['testing', 0, 'result']), 'testing[0].result');
  assert.equal(formatPath([]), '');
  assert.equal(formatPath([2]), '[2]');
});

const Input = z.strictObject({
  title: z.string(),
  testing: z.array(z.strictObject({ kind: z.enum(['unit', 'manual']), result: z.string() })),
  components: z.array(z.string()).optional(),
});

test('zod issues map to path/message/code with expected and received', () => {
  const input = { title: 3, testing: [{ kind: 'unit', result: 1 }] };
  const r = Input.safeParse(input);
  assert.ok(!r.success);
  const issues = mapZodIssues(r.error, { schema: Input, input, suggest });
  const title = issues.find((i) => i.path === 'title');
  assert.equal(title?.code, 'invalid_type');
  assert.equal(title?.expected, 'string');
  assert.equal(title?.received, 'number');
  assert.ok(issues.some((i) => i.path === 'testing[0].result'));
});

test('unrecognized keys get a did-you-mean against the schema keys at that path', () => {
  const input = { title: 't', testing: [{ kind: 'unit', result: 'pass', reslt: 1 }], componets: [] };
  const r = Input.safeParse(input);
  assert.ok(!r.success);
  const issues = mapZodIssues(r.error, { schema: Input, input, suggest });
  assert.deepEqual(
    issues.filter((i) => i.code === 'unrecognized_keys').map((i) => [i.path, i.suggestion]),
    [
      ['testing[0].reslt', 'result'],
      ['componets', 'components'],
    ],
  );
});

test('enum misses get a suggestion', () => {
  const input = { title: 't', testing: [{ kind: 'unti', result: 'x' }] };
  const r = Input.safeParse(input);
  assert.ok(!r.success);
  const [issue] = mapZodIssues(r.error, { schema: Input, input, suggest });
  assert.equal(issue?.suggestion, 'unit');
  assert.equal(issue?.received, 'unti');
});

test('objectKeysAt unwraps optional/default/prefault wrappers', () => {
  const S = z.object({ a: z.object({ b: z.string(), c: z.number() }).prefault({ b: 'x', c: 1 }).optional() });
  assert.deepEqual(objectKeysAt(S, ['a']), ['b', 'c']);
  assert.deepEqual(objectKeysAt(S, []), ['a']);
  assert.deepEqual(objectKeysAt(S, ['nope']), []);
});
