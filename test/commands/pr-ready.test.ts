// ghx pr ready (gh pr ready): a draft toggle on any open PR, ghx block or not; no config needed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT } from '../contract/exit-table.ts';
import { FakeGh } from '../helpers/fake-gh.ts';
import { runInProcess } from '../helpers/harness.ts';
import { editScene, editSequence } from './pr-edit-scene.ts';

const run = (gh: FakeGh, extra: string[] = []) => runInProcess(['pr', 'ready', 'octo/demo#12', ...extra], { gh });

test('marks a draft PR without a ghx block ready: snapshot, mutation, read-back; no config', async () => {
  const s = editScene({ pr: { isDraft: true, body: 'Opened with gh.' } });
  const r = await run(s.gh);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(editSequence(s.gh), ['snapshot', 'ready', 'snapshot']);
  assert.deepEqual(r.json, {
    ref: 'octo/demo#12',
    url: 'https://github.com/octo/demo/pull/12',
    draft: false,
    changed: true,
    next: ['ghx pr status octo/demo#12'],
  });
});

test('--undo and --draft convert back to draft; the wanted state already is a no-op', async () => {
  for (const flag of ['--undo', '--draft']) {
    const s = editScene();
    const r = await run(s.gh, [flag]);
    assert.equal(r.exitCode, EXIT.OK, r.stdout);
    assert.deepEqual(s.drafts, ['to-draft']);
    assert.equal(r.json.draft, true);
  }
  const s = editScene();
  const r = await run(s.gh);
  assert.equal(r.json.changed, false);
  s.gh.expectNoMutations();
});

test('--dry-run halts at the mutation; a closed PR is PR_NOT_OPEN; --brief keeps the preset', async () => {
  const s = editScene({ pr: { isDraft: true } });
  const d = await run(s.gh, ['--dry-run']);
  assert.equal(d.json.dryRun, true, d.stdout);
  assert.deepEqual(d.json.preview, { ref: 'octo/demo#12', draft: false });
  s.gh.expectNoMutations();
  const closed = await run(editScene({ pr: { state: 'CLOSED', isDraft: true } }).gh);
  assert.equal(closed.json.error.code, 'PR_NOT_OPEN');
  const brief = await run(editScene({ pr: { isDraft: true } }).gh, ['--brief']);
  assert.deepEqual(Object.keys(brief.json).sort(), ['changed', 'draft', 'next', 'ref']);
});

test('a read-back that disagrees is READBACK_MISMATCH', async () => {
  const s = editScene({ pr: { isDraft: true }, reread: { isDraft: true } });
  const r = await run(s.gh);
  assert.equal(r.json.error.code, 'READBACK_MISMATCH', r.stdout);
});

test('the smoke/pr-ready scenario replays the example to the mutation halt under --dry-run', async () => {
  const gh = FakeGh.fromScenario('smoke/pr-ready');
  const r = await runInProcess(['pr', 'ready', 'octo/demo#12', '--dry-run'], { gh });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.dryRun, true);
  gh.expectNoMutations();
});
