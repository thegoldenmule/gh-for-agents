// R10 (03 §5.2). Guards sektar #3258 (§3.1, §4.1; 02 §1.2 [G-CWD]): the cwd is a checkout of another repo,
// so a bare PR number resolves against the wrong repo. pr status must say so, name the cwd repo and show
// how to pass the right one; an explicit owner/repo#N reads the target and warns CWD_REPO_MISMATCH.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { install, NOW, REF } from '../commands/pr-status-world.ts';
import { EXIT } from '../contract/exit-table.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { FakeGh } from '../helpers/fake-gh.ts';
import { gitCheckout } from '../helpers/fake-git.ts';
import { runInProcess, scratchDir } from '../helpers/harness.ts';
import { isQ1, q1Reply } from '../unit/pr/snapshot-fixture.ts';

const sektar = () => gitCheckout('powerhouse-inc/sektar');

async function status(argv: string[], fake: FakeGh, git = sektar()) {
  return runInProcess(['pr', 'status', ...argv], {
    gh: fake,
    git,
    clock: new FakeClock(NOW),
    env: { GHX_ARTIFACT_DIR: mkdtempSync(join(scratchDir(), 'r10-')) },
  });
}

test('R10: a bare number resolved from the cwd repo is PR_NOT_FOUND (exit 5) naming the cwd repo, with the fix', async () => {
  const fake = new FakeGh().on(isQ1, q1Reply(null));
  const r = await status(['3258'], fake);
  assert.equal(r.exitCode, EXIT.NOT_FOUND, r.stdout);
  assert.equal(r.json.error.code, 'PR_NOT_FOUND');
  assert.match(r.json.error.message, /powerhouse-inc\/sektar/);
  assert.equal(r.json.error.details.repo, 'powerhouse-inc/sektar');
  assert.equal(r.json.error.details.repoSource, 'cwd');
  assert.match(r.json.error.hint, /ghx pr status owner\/repo#3258/);
  assert.match(r.json.error.hint, /-R owner\/repo/);
  assert.ok(
    fake.calls.some((c) => c.argv.includes('name=sektar')),
    'the read went to the cwd repo',
  );
});

test('R10: owner/repo#N from another checkout reads the target and warns CWD_REPO_MISMATCH', async () => {
  const r = await status([REF], install());
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const w = r.json.warnings.find((x: { code: string }) => x.code === 'CWD_REPO_MISMATCH');
  assert.match(w.message, /powerhouse-inc\/powerhouse.*powerhouse-inc\/sektar/);
  assert.equal(r.json.ref, REF);
});

test('R10: --repo disagreeing with the selector is refused before any gh call', async () => {
  const fake = new FakeGh();
  const r = await status([REF, '-R', 'powerhouse-inc/sektar'], fake);
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  assert.equal(r.json.error.code, 'USAGE_REPO_MISMATCH');
  assert.deepEqual(fake.calls, []);
});

test('R10: a cwd outside any checkout with a bare number is REPO_NOT_FOUND (exit 5)', async () => {
  const fake = new FakeGh();
  const r = await runInProcess(['pr', 'status', '3258'], { gh: fake, clock: new FakeClock(NOW) });
  assert.equal(r.exitCode, EXIT.NOT_FOUND, r.stdout);
  assert.equal(r.json.error.code, 'REPO_NOT_FOUND');
  assert.deepEqual(fake.calls, []);
});
