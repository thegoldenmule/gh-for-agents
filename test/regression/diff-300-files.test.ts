// R15, the passthrough half (03 §5.2; research §3.1, §9.10): `gh pr diff` fails past 300 files with
// HTTP 406. `ghx pr diff` gets gh's verbatim stderr (the `passthrough` scenario) and returns
// DIFF_TOO_LARGE (exit 7) with a local git diff hint instead of a bare GH_FAILED. `--name-only` needs no
// diff: its names come from pulls/N/files, which pages past 300.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { EXIT } from '../contract/exit-table.ts';
import { FakeGh } from '../helpers/fake-gh.ts';
import { runInProcess } from '../helpers/harness.ts';
import { httpReply } from '../unit/ci/_helpers.ts';

const DIFF_406 = readFileSync(join(import.meta.dirname, '..', 'fixtures', 'gh-stderr', 'diff-406.txt'), 'utf8');

test('R15 (passthrough): pr diff past 300 files → DIFF_TOO_LARGE (7) with a local git diff hint', async () => {
  const fake = FakeGh.fromScenario('passthrough');
  const r = await runInProcess(['pr', 'diff', '3169', '-R', 'powerhouse-inc/powerhouse'], { gh: fake });
  assert.equal(r.exitCode, EXIT.GH_FAILED, r.stdout);
  const e = r.json.error;
  assert.equal(e.code, 'DIFF_TOO_LARGE');
  assert.match(e.hint, /git diff/);
  assert.match(e.hint, /ghx pr diff 3169 --name-only/);
  assert.match(e.hint, /ghx api "repos\/\{owner\}\/\{repo\}\/pulls\/3169\/files\?per_page=100" --paginate --slurp/);
  assert.equal(e.details.status, 406);
  assert.match(e.details.passthrough.stderr, /exceeded the maximum number of files \(300\)/);
  assert.equal(fake.calls.length, 1, 'a 406 is not retried');
  fake.expectNoMutations();
});

const FILES = Array.from({ length: 350 }, (_, i) => ({ filename: `packages/gen/file-${i}.ts`, status: 'added' }));
const NEXT = (page: number) => `https://api.github.com/repositories/1/pulls/3169/files?per_page=100&page=${page}`;
const page = (n: number, last = 4) => ({
  exitCode: 0,
  stdout: httpReply(
    'HTTP/2.0 200 OK',
    JSON.stringify(FILES.slice((n - 1) * 100, n * 100)),
    n < last ? { Link: `<${NEXT(n + 1)}>; rel="next", <${NEXT(last)}>; rel="last"` } : undefined,
  ),
  stderr: '',
});

function filesWorld(): FakeGh {
  const gh = new FakeGh().on({ prefix: ['pr', 'diff'] }, { exitCode: 1, stdout: '', stderr: DIFF_406 });
  gh.on((a) => a.some((x) => x.startsWith('repos/powerhouse-inc/powerhouse/pulls/3169/files')), page(1));
  for (const n of [2, 3, 4]) gh.on((a) => a.includes(NEXT(n)), page(n));
  return gh;
}

test('R15 (passthrough): pr diff --name-only past 300 files falls back to the paginated files API', async () => {
  for (const sel of ['3169', 'https://github.com/powerhouse-inc/powerhouse/pull/3169']) {
    const gh = filesWorld();
    const r = await runInProcess(['pr', 'diff', sel, '--name-only', '-R', 'powerhouse-inc/powerhouse'], { gh });
    assert.equal(r.exitCode, EXIT.OK, r.stdout);
    const p = r.json.passthrough;
    assert.deepEqual(p.argv, ['gh', 'api', 'repos/powerhouse-inc/powerhouse/pulls/3169/files']);
    assert.equal(p.exitCode, 0);
    const text = p.text ?? readFileSync(p.stdoutPath, 'utf8');
    assert.equal(text, FILES.map((f) => `${f.filename}\n`).join(''));
    assert.deepEqual(
      r.json.warnings.map((w: { code: string }) => w.code),
      ['DIFF_NAMES_FROM_FILES_API'],
    );
    assert.match(r.json.warnings[0].message, /the 350 names came from/);
    assert.equal(gh.calls.filter((c) => c.argv.some((x) => x.includes('/files'))).length, 4);
    gh.expectNoMutations();
  }
});

test('R15 (passthrough): --name-only on a branch selector keeps DIFF_TOO_LARGE (no PR number to list)', async () => {
  const gh = filesWorld();
  const r = await runInProcess(['pr', 'diff', 'feat/x', '--name-only', '-R', 'powerhouse-inc/powerhouse'], { gh });
  assert.equal(r.json.error.code, 'DIFF_TOO_LARGE');
  assert.equal(gh.calls.length, 1);
});
