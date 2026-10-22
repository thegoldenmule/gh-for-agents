// --override / --reason validation (03 §5.1 overrides.test.ts). The unused-override warning lives in
// merge.test.ts, since only evaluation knows whether a check failed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isGhxError } from '../../../src/core/errors.ts';
import { OVERRIDABLE_CODES } from '../../../src/policy/checks.ts';
import { MAX_REASON_CHARS, parseOverrides } from '../../../src/policy/overrides.ts';

function issues(codes: string[], reason?: string | null): string[] {
  try {
    parseOverrides(codes, reason);
  } catch (e) {
    assert.ok(isGhxError(e, 'VALIDATION'));
    return ((e.details?.issues ?? []) as { code: string }[]).map((i) => i.code);
  }
  assert.fail('expected VALIDATION');
}

test('no override gives null; a reason alone is ignored', () => {
  assert.equal(parseOverrides([], 'why'), null);
  assert.equal(parseOverrides([' , '], null), null);
});

test('valid overrides: comma lists split, duplicates collapse, the reason is trimmed', () => {
  assert.deepEqual(parseOverrides(['AUTHOR_NOT_VIEWER,CI_RED', 'CI_RED'], '  user asked in chat '), {
    codes: ['AUTHOR_NOT_VIEWER', 'CI_RED'],
    reason: 'user asked in chat',
  });
});

test('an unknown code gives VALIDATION', () => {
  assert.deepEqual(issues(['NOT_A_CODE'], 'r'), ['override.unknown']);
});

test('a non-overridable code (METHOD_NOT_ALLOWED, HEAD_MOVED, CONFIG_MISSING) gives VALIDATION', () => {
  for (const code of ['METHOD_NOT_ALLOWED', 'HEAD_MOVED', 'CI_PENDING', 'CONFIG_MISSING']) {
    assert.deepEqual(issues([code], 'r'), ['override.not_overridable'], code);
  }
});

test('a missing reason, or one over 200 chars or on two lines, gives VALIDATION', () => {
  assert.deepEqual(issues(['CI_RED']), ['override.reason_required']);
  assert.deepEqual(issues(['CI_RED'], '   '), ['override.reason_required']);
  assert.deepEqual(issues(['CI_RED'], 'x'.repeat(MAX_REASON_CHARS + 1)), ['override.reason_too_long']);
  assert.ok(parseOverrides(['CI_RED'], 'x'.repeat(MAX_REASON_CHARS)));
  assert.deepEqual(issues(['CI_RED'], 'a\nb'), ['override.reason_too_long']);
});

test('all issues are reported together, and the hint lists the overridable codes', () => {
  try {
    parseOverrides(['NOPE', 'HEAD_MOVED'], '');
    assert.fail('expected VALIDATION');
  } catch (e) {
    assert.ok(isGhxError(e, 'VALIDATION'));
    assert.equal(e.message, '3 override issues.');
    for (const code of OVERRIDABLE_CODES) assert.ok(e.hint?.includes(code), code);
  }
});

test('the overridable set is exactly 02 §8.2 rows 4, 10b, 11–15, plus FEEDBACK_TRUNCATED (14b)', () => {
  assert.deepEqual(OVERRIDABLE_CODES, [
    'AUTHOR_NOT_VIEWER',
    'CI_NO_CHECKS',
    'CI_RED',
    'KEY_STEP_SKIPPED',
    'CHANGES_REQUESTED',
    'FINDINGS_OPEN',
    'FEEDBACK_TRUNCATED',
    'PRECONDITION_UNMET',
  ]);
});
