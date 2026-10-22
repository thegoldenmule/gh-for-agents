// assertReadback (02 §2.6 step 8, 03 §1 row 11): shared by `pr create` (title, body) and `pr edit`
// (title, body, base, draft); only the fields sent are compared.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isGhxError } from '../../../../src/core/errors.ts';
import { assertReadback, type PullData } from '../../../../src/pr/create/submit.ts';

const repo = { host: 'github.com', owner: 'o', name: 'r' };
const stored: PullData = {
  number: 7,
  html_url: 'https://github.com/o/r/pull/7',
  title: 'feat: x',
  body: null,
  draft: true,
  head: { ref: 'h', sha: 'a'.repeat(40) },
  base: { ref: 'main' },
};

function mismatch(fn: () => void): Record<string, unknown> {
  try {
    fn();
  } catch (e) {
    assert.ok(isGhxError(e) && e.code === 'READBACK_MISMATCH', String(e));
    return { message: e.message, hint: e.hint, ...(e.details as object) };
  }
  assert.fail('expected READBACK_MISMATCH');
}

test('matching fields pass; a null body equals the empty string', () => {
  assertReadback(repo, stored, { title: 'feat: x', body: '', base: 'main', draft: true });
});

test('absent keys are not compared (pr create sends no base or draft check)', () => {
  assertReadback(repo, stored, { title: 'feat: x', body: '' });
});

test('base and draft are compared when sent', () => {
  const b = mismatch(() => assertReadback(repo, stored, { base: 'dev' }));
  assert.equal(b.field, 'base');
  assert.equal(b.sent, 'dev');
  assert.equal(b.stored, 'main');
  const d = mismatch(() => assertReadback(repo, stored, { draft: false }));
  assert.equal(d.field, 'draft');
  assert.equal(d.stored, true);
});

test('verb and hint are overridable; defaults keep the pr create wording', () => {
  const def = mismatch(() => assertReadback(repo, stored, { title: 'other' }));
  assert.match(String(def.message), /was created, but GitHub stored a different title/);
  assert.match(String(def.hint), /do not re-run pr create/);
  const edit = mismatch(() =>
    assertReadback(repo, stored, { title: 'other' }, { verb: 'edited', hint: (f, ref) => `re-read ${ref} ${f}` }),
  );
  assert.match(String(edit.message), /o\/r#7 was edited/);
  assert.equal(edit.hint, 're-read o/r#7 title');
});
