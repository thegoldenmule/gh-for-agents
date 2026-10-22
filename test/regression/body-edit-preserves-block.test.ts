// R12 (03 §5.2): 35 PR body edits, some bodies edited up to 4 times (docs/research/gh-usage-findings.md
// §4.2). `pr edit` must keep exactly one hidden block (same id, rev+1, other fields preserved, trailer
// re-rendered), refuse to silently overwrite UI edits (DESCRIPTION_DRIFT), refuse a PR without a block
// unless adopted (NO_BLOCK), and refuse when the PR changed between read and PATCH (CONCURRENT_EDIT).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readPrBlock } from '../../src/meta/schemas.ts';
import { parsePrBody, renderTrailer } from '../../src/render/pr-body.ts';
import { BLOCK_ID, bodyOf, CONTENT, editScene, editSequence, RENDER } from '../commands/pr-edit-scene.ts';
import { EXIT } from '../contract/exit-table.ts';
import type { FakeGh } from '../helpers/fake-gh.ts';
import { runInProcess } from '../helpers/harness.ts';

const run = (gh: FakeGh, patch: unknown, extra: string[] = []) =>
  runInProcess(['pr', 'edit', 'octo/demo#12', '--input', '-', ...extra], { gh, stdin: JSON.stringify(patch) });

const NEW = 'Retried requests now show a banner; it hides itself once the retry succeeds.';
const blocks = (body: string) => (body.match(/<!-- ghx:v1 /g) ?? []).length;

test('a description edit keeps one block: same id, rev 1 → 2, other fields kept, trailer re-rendered', async () => {
  // The trailer was hand-edited in the UI; it is derived, so the edit simply re-renders it.
  const uiTrailer = bodyOf().replace('Risk: low', 'Risk: low (I think)');
  const s = editScene({ pr: { body: uiTrailer } });
  const r = await run(s.gh, { description: NEW });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const body = String(s.patched[0]?.body);
  assert.equal(blocks(body), 1);
  const read = readPrBlock(body);
  assert.equal(read.status, 'ok');
  if (read.status !== 'ok') return;
  const { t, id, gen: _gen, rev, description, ...rest } = read.block;
  assert.equal(t, 'pr');
  assert.equal(id, BLOCK_ID);
  assert.equal(rev, 2);
  assert.equal(description, NEW);
  const { description: _old, ...kept } = CONTENT;
  assert.deepEqual(rest, kept);
  const parsed = parsePrBody(body, { footer: RENDER.footer });
  assert.equal(parsed.description, NEW);
  assert.equal(parsed.trailer, renderTrailer(read.block));
  assert.equal(parsed.footer, RENDER.footer);
});

test('a UI-edited description plus a patch without description is DESCRIPTION_DRIFT (exit 9), no PATCH', async () => {
  const visible = 'Edited in the GitHub UI by a human.';
  const s = editScene({ pr: { body: bodyOf().replace(CONTENT.description, visible) } });
  const r = await run(s.gh, { risk: 'trivial' });
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.equal(r.json.error.code, 'DESCRIPTION_DRIFT');
  assert.equal(r.json.error.details.visible, visible);
  assert.deepEqual(r.json.error.details.drift, ['description']);
  assert.match(r.json.error.hint, /--discard-ui-edits/);
  assert.deepEqual(editSequence(s.gh), ['config', 'snapshot']);
  s.gh.expectNoMutations();
});

test('--discard-ui-edits proceeds: the block description wins, with a warning', async () => {
  const s = editScene({ pr: { body: bodyOf().replace(CONTENT.description, 'UI text.') } });
  const r = await run(s.gh, { risk: 'trivial' }, ['--discard-ui-edits']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(s.patched[0]?.body, bodyOf({ ...CONTENT, risk: 'trivial' }, 2));
  assert.deepEqual(
    r.json.warnings.map((w: { code: string }) => w.code),
    ['UI_EDITS_DISCARDED'],
  );
});

test('a patch that includes description resolves the drift without the flag', async () => {
  const s = editScene({ pr: { body: bodyOf().replace(CONTENT.description, 'UI text.') } });
  const r = await run(s.gh, { description: NEW });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.rev, 2);
});

test('title drift: a UI-edited title is not reset silently', async () => {
  const s = editScene({ pr: { title: 'feat(app): renamed in the UI' } });
  const r = await run(s.gh, { description: NEW });
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.equal(r.json.error.code, 'DESCRIPTION_DRIFT');
  assert.deepEqual(r.json.error.details.drift, ['title']);
  assert.equal(r.json.error.details.title, 'feat(app): renamed in the UI');
  s.gh.expectNoMutations();

  const s2 = editScene({ pr: { title: 'feat(app): renamed in the UI' } });
  const r2 = await run(s2.gh, { description: NEW, title: 'feat(app): renamed in the UI' });
  assert.equal(r2.exitCode, EXIT.OK, r2.stdout);
  assert.deepEqual(r2.json.changed, ['body']);
});

test('a PR without a block is NO_BLOCK (exit 9); adopt:true with every field writes the first block', async () => {
  const human = 'A PR opened by hand.\n\n- with a list';
  const s = editScene({ pr: { body: human } });
  const r = await run(s.gh, { description: NEW });
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.equal(r.json.error.code, 'NO_BLOCK');
  assert.match(r.json.error.hint, /"adopt": true/);
  s.gh.expectNoMutations();

  const s2 = editScene({ pr: { body: human } });
  const r2 = await run(s2.gh, { ...CONTENT, description: NEW, adopt: true });
  assert.equal(r2.exitCode, EXIT.OK, r2.stdout);
  assert.equal(r2.json.adopted, true);
  assert.equal(r2.json.rev, 1);
  assert.match(r2.json.blockId, /^p_[0-9a-hjkmnp-tv-z]{6}$/);
  const body = String(s2.patched[0]?.body);
  assert.equal(blocks(body), 1);
  assert.equal(body, bodyOf({ ...CONTENT, description: NEW }, 1, r2.json.blockId));
});

test('adopt with a partial object is VALIDATION listing the missing fields', async () => {
  const s = editScene({ pr: { body: 'Hand-written.' } });
  const r = await run(s.gh, { description: NEW, adopt: true });
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  const paths = r.json.error.details.issues.map((i: { path: string }) => i.path);
  for (const p of ['title', 'testing', 'risk', 'components', 'revertPolicy']) assert.ok(paths.includes(p), p);
  s.gh.expectNoMutations();
});

test('updatedAt changed before the PATCH is CONCURRENT_EDIT (exit 9), no PATCH', async () => {
  const s = editScene({ reread: { updatedAt: '2026-10-22T10:00:22Z' } });
  const r = await run(s.gh, { description: NEW });
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.equal(r.json.error.code, 'CONCURRENT_EDIT');
  assert.match(r.json.error.message, /10:00:00Z → 2026-10-22T10:00:22Z/);
  assert.deepEqual(editSequence(s.gh), ['config', 'snapshot', 'preflight', 'compare', 'snapshot']);
  s.gh.expectNoMutations();
});

test('a body changed before the PATCH (same updatedAt) is CONCURRENT_EDIT too', async () => {
  const s = editScene({ reread: { body: `${bodyOf()}\n\nappended` } });
  const r = await run(s.gh, { description: NEW });
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.equal(r.json.error.code, 'CONCURRENT_EDIT');
  assert.equal(r.json.error.details.bodyChanged, true);
  s.gh.expectNoMutations();
});

test('text a human appended after the footer is not dropped silently', async () => {
  const s = editScene({
    pr: { body: bodyOf().replace(RENDER.footer, `${RENDER.footer}\n\nCC @someone, see the thread.`) },
  });
  const r = await run(s.gh, { description: NEW });
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.equal(r.json.error.code, 'DESCRIPTION_DRIFT');
  assert.deepEqual(r.json.error.details.drift, ['appended']);
  assert.match(r.json.error.details.appended, /CC @someone/);
  s.gh.expectNoMutations();

  const s2 = editScene({ pr: { body: bodyOf().replace(RENDER.footer, `${RENDER.footer}\n\nCC @someone.`) } });
  const r2 = await run(s2.gh, { description: NEW }, ['--discard-ui-edits']);
  assert.equal(r2.exitCode, EXIT.OK, r2.stdout);
  assert.doesNotMatch(String(s2.patched[0]?.body), /CC @someone/);
});
