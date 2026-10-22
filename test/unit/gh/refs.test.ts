import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isGhxError } from '../../../src/core/errors.ts';
import { formatPrRef, parseRepo, parseTargetRef, tryParseRepo, tryParseTargetRef } from '../../../src/gh/refs.ts';

const gh = (owner: string, name: string, host = 'github.com') => ({ host, owner, name });

test('repo forms', () => {
  assert.deepEqual(tryParseRepo('powerhouse-inc/powerhouse'), gh('powerhouse-inc', 'powerhouse'));
  assert.deepEqual(tryParseRepo('ghe.example.com/o/r'), gh('o', 'r', 'ghe.example.com'));
  assert.deepEqual(tryParseRepo('https://github.com/o/r.git'), gh('o', 'r'));
  assert.deepEqual(tryParseRepo('https://github.com/o/r/'), gh('o', 'r'));
  assert.deepEqual(tryParseRepo('git@github.com:o/r.git'), gh('o', 'r'));
  assert.deepEqual(tryParseRepo('ssh://git@github.com:22/o/r.git'), gh('o', 'r'));
  assert.deepEqual(tryParseRepo('o/r', 'ghe.corp'), gh('o', 'r', 'ghe.corp'));
  for (const bad of ['o', 'o/r/x', 'o r/x', '', 'a/..', 'https://github.com/o'])
    assert.equal(tryParseRepo(bad), undefined, bad);
  assert.throws(
    () => parseRepo('nope'),
    (e) => isGhxError(e, 'VALIDATION'),
  );
});

test('PR selector forms', () => {
  assert.deepEqual(tryParseTargetRef('3198'), { kind: 'pr', number: 3198 });
  assert.deepEqual(tryParseTargetRef('#3198'), { kind: 'pr', number: 3198 });
  assert.deepEqual(tryParseTargetRef('powerhouse-inc/powerhouse#3198'), {
    kind: 'pr',
    number: 3198,
    repo: gh('powerhouse-inc', 'powerhouse'),
  });
  assert.deepEqual(tryParseTargetRef('ghe.corp/o/r#5'), { kind: 'pr', number: 5, repo: gh('o', 'r', 'ghe.corp') });
  assert.deepEqual(tryParseTargetRef('https://github.com/o/r/pull/12'), { kind: 'pr', number: 12, repo: gh('o', 'r') });
  assert.deepEqual(tryParseTargetRef('https://github.com/o/r/pull/12/files?diff=split'), {
    kind: 'pr',
    number: 12,
    repo: gh('o', 'r'),
  });
});

test('run and job URLs', () => {
  assert.deepEqual(tryParseTargetRef('https://github.com/o/r/actions/runs/37948190914'), {
    kind: 'run',
    number: 37948190914,
    repo: gh('o', 'r'),
  });
  assert.deepEqual(tryParseTargetRef('https://github.com/o/r/actions/runs/37948190914/attempts/2'), {
    kind: 'run',
    number: 37948190914,
    repo: gh('o', 'r'),
  });
  assert.deepEqual(tryParseTargetRef('https://github.com/o/r/actions/runs/1/job/111978835495'), {
    kind: 'job',
    number: 111978835495,
    repo: gh('o', 'r'),
    runId: 1,
  });
});

test('bad selectors', () => {
  for (const bad of ['pr-3198', '0', '-1', '#', 'o/r#', 'https://github.com/o/r/issues/1', '1.5', 'o/r#x']) {
    assert.equal(tryParseTargetRef(bad), undefined, bad);
  }
  assert.throws(
    () => parseTargetRef('pr-3198'),
    (e) => isGhxError(e, 'USAGE_BAD_SELECTOR'),
  );
});

test('formatPrRef', () => {
  assert.equal(formatPrRef(gh('o', 'r'), 7), 'o/r#7');
});
