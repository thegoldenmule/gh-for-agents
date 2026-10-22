// R15 (03 §5.2), the pr review half: diffs and compares cap at 300 files (gh-usage-findings §3.1, §9.10;
// G-300). `pr review` reads pulls/N/files page by page past 300 entries, so a finding on file 340 is
// still placed inline, and a file GitHub shows without a patch makes its finding body-only
// (FINDING_NOT_INLINE).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMutating } from '../../src/gh/guard.ts';
import { FakeGh } from '../helpers/fake-gh.ts';
import { runInProcess } from '../helpers/harness.ts';
import { httpReply } from '../unit/ci/_helpers.ts';
import { HEAD, isQ1, q1Pr, q1Reply } from '../unit/pr/snapshot-fixture.ts';

const FILES = Array.from({ length: 350 }, (_, i) => ({
  filename: `packages/gen/file-${i}.ts`,
  status: 'modified',
  ...(i === 150 ? {} : { patch: '@@ -1,5 +1,9 @@\n context' }),
}));
const NEXT = (page: number) => `https://api.github.com/repositories/1/pulls/3301/files?per_page=100&page=${page}`;

function page(n: number) {
  const rows = FILES.slice((n - 1) * 100, n * 100);
  const link = n < 4 ? { Link: `<${NEXT(n + 1)}>; rel="next", <${NEXT(4)}>; rel="last"` } : undefined;
  return { exitCode: 0, stdout: httpReply('HTTP/2.0 200 OK', JSON.stringify(rows), link), stderr: '' };
}

test('R15: files are paginated past 300; a patchless file is body-only; file 340 is inline', async () => {
  const gh = new FakeGh();
  gh.on(isQ1, q1Reply(q1Pr()));
  gh.on((a) => a.some((x) => x.startsWith('repos/powerhouse-inc/powerhouse/pulls/3301/files')), page(1));
  for (const n of [2, 3, 4]) gh.on((a) => a.includes(NEXT(n)), page(n));
  // The head re-check after the files (unchanged).
  const pull = {
    number: 3301,
    html_url: 'https://x/3301',
    title: 't',
    body: null,
    head: { ref: 'f', sha: HEAD },
    base: { ref: 'main' },
  };
  gh.on((a) => !isMutating(a) && a.some((x) => x === 'repos/powerhouse-inc/powerhouse/pulls/3301'), {
    exitCode: 0,
    stdout: httpReply('HTTP/2.0 200 OK', JSON.stringify(pull)),
    stderr: '',
  });
  let posted: { comments: { path: string }[]; body: string } | undefined;
  gh.on(
    (a, stdin) => {
      if (!isMutating(a)) return false;
      posted = JSON.parse(stdin ?? '{}');
      return true;
    },
    {
      exitCode: 0,
      stdout: httpReply('HTTP/2.0 200 OK', JSON.stringify({ id: 9, html_url: 'https://x/9' })),
      stderr: '',
    },
  );
  gh.on((a) => a.some((x) => x.includes('/reviews/9/comments')), {
    exitCode: 0,
    stdout: httpReply('HTTP/2.0 200 OK', '[]'),
    stderr: '',
  });
  const finding = (i: number) => ({
    severity: 'low',
    path: `packages/gen/file-${i}.ts`,
    line: 3,
    title: `Finding on file ${i}`,
    body: 'Generated code drifted.',
  });
  const r = await runInProcess(['pr', 'review', 'powerhouse-inc/powerhouse#3301', '--input', '-'], {
    gh,
    stdin: JSON.stringify({ verdict: 'comment', summary: 'Generated files.', findings: [finding(340), finding(150)] }),
  });
  assert.equal(r.exitCode, 0, r.stdout);
  assert.equal(gh.calls.filter((c) => c.argv.some((x) => x.includes('/files'))).length, 4);
  assert.deepEqual(
    r.json.findings.map((f: { inline: boolean }) => f.inline),
    [true, false],
  );
  assert.deepEqual(
    posted?.comments.map((c) => c.path),
    ['packages/gen/file-340.ts'],
  );
  assert.deepEqual(
    r.json.warnings.map((w: { code: string }) => w.code),
    ['FINDING_NOT_INLINE'],
  );
});
