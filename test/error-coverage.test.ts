// 03 §8.1 item 4: every public error code is produced by at least one test. The test tree is grepped
// for each code in ERROR_CODES as a quoted literal (an assertion on `error.code`, `isGhxError(e, …)`, a
// table row). test/unit/core/errors.test.ts is left out: it exercises the catalogue and its mappings
// (publicCodeFor), not a command producing the code. Fixtures are left out: a recorded reply is input.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { ERROR_CODES } from '../src/core/errors.ts';

const TEST_ROOT = import.meta.dirname;
const EXCLUDED = new Set(['error-coverage.test.ts', 'unit/core/errors.test.ts']);

/**
 * Codes the catalogue keeps although nothing raises them, each with the reason. Empty today: an entry
 * here is a public name agents may see documented but never receive, so it needs a reason that holds.
 */
const NEVER_RAISED: Readonly<Record<string, string>> = {};

function testSources(dir = TEST_ROOT): { file: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'fixtures' ? [] : testSources(abs);
    const file = relative(TEST_ROOT, abs).split('\\').join('/');
    return e.name.endsWith('.ts') && !EXCLUDED.has(file) ? [{ file, text: readFileSync(abs, 'utf8') }] : [];
  });
}

const sources = testSources();
const producedBy = (code: string): string[] => {
  const re = new RegExp(`['"\`]${code}['"\`]`);
  return sources.filter((s) => re.test(s.text)).map((s) => s.file);
};

test('every error code is produced by at least one test (or allowlisted with a reason)', () => {
  const missing = Object.keys(ERROR_CODES).filter((c) => !(c in NEVER_RAISED) && producedBy(c).length === 0);
  assert.deepEqual(missing, [], 'add a test that produces each code, or allowlist it in NEVER_RAISED with a reason');
});

test('the allowlist is current: each entry is a catalogue code no test produces, with a reason', () => {
  for (const [code, reason] of Object.entries(NEVER_RAISED)) {
    assert.ok(Object.hasOwn(ERROR_CODES, code), `${code} is not in ERROR_CODES`);
    assert.ok(reason.length > 0, `${code} needs a reason`);
    assert.deepEqual(producedBy(code), [], `${code} is produced by a test now; drop it from NEVER_RAISED`);
  }
});

test('the grep sees the test tree (guards against a vacuous pass)', () => {
  assert.ok(sources.length > 50, `${sources.length} test sources`);
  assert.ok(producedBy('PR_NOT_FOUND').length > 0);
  assert.deepEqual(producedBy('NOT_A_REAL_CODE_XYZ'), []);
});
