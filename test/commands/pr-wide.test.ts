// Wide PRs (06): more touched components than `components` holds; the rest go to alsoTouched.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readPrBlock } from '../../src/meta/schemas.ts';
import { renderPrBody, toPrBlock } from '../../src/render/pr-body.ts';
import { EXIT } from '../contract/exit-table.ts';
import type { FakeGh } from '../helpers/fake-gh.ts';
import { runInProcess } from '../helpers/harness.ts';
import { INPUT, scene } from './pr-create-scene.ts';
import { BLOCK_ID, CONTENT, editScene, editSequence, RENDER } from './pr-edit-scene.ts';

const NAMES = ['app', 'docs', 'reactor', 'api', 'cli', 'core', 'ui'] as const;
const WIDE_CONFIG = {
  version: 1,
  components: {
    app: { paths: ['src/**'] },
    docs: { paths: ['docs/**'] },
    reactor: { paths: ['packages/reactor/**'] },
    api: { paths: ['packages/api/**'] },
    cli: { paths: ['packages/cli/**'] },
    core: { paths: ['packages/core/**'] },
    ui: { paths: ['packages/ui/**'] },
  },
};
const FILES = ['src/a.ts', 'docs/a.md', ...NAMES.slice(2).map((n) => `packages/${n}/a.ts`)];
const PRIMARY = ['app', 'docs', 'reactor', 'api', 'cli'];

const codes = (r: { json: { warnings?: { code: string }[] } }) => (r.json.warnings ?? []).map((w) => w.code);
const blockOf = (body: string) => {
  const b = readPrBlock(body);
  assert.equal(b.status, 'ok');
  return b.status === 'ok' ? b.block : (undefined as never);
};
const create = (gh: FakeGh, input: unknown) =>
  runInProcess(['pr', 'create', '-R', 'octo/demo', '--input', '-'], { gh, stdin: JSON.stringify(input) });
const edit = (gh: FakeGh, patch: unknown, extra: string[] = []) =>
  runInProcess(['pr', 'edit', 'octo/demo#12', '--input', '-', ...extra], { gh, stdin: JSON.stringify(patch) });

test('pr create: 5 declared of 7 touched records the other 2 as alsoTouched, with a warning', async () => {
  const s = scene({ config: WIDE_CONFIG, files: FILES });
  const r = await create(s.gh, { ...INPUT, components: PRIMARY });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(codes(r), ['COMPONENTS_ALSO_TOUCHED']);
  const body = String(s.posted[0]?.body);
  assert.match(body, /Components: app, docs, reactor, api, cli \(\+2 more\) · /);
  const block = blockOf(body);
  assert.deepEqual(block.components, PRIMARY);
  assert.deepEqual(block.alsoTouched, ['core', 'ui']);
});

test('pr create: fewer than 5 declared on a wide diff is one components.undeclared_touched issue', async () => {
  const s = scene({ config: WIDE_CONFIG, files: FILES });
  const r = await create(s.gh, { ...INPUT, components: ['app', 'docs'] });
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  const issues = r.json.error.details.issues as { code: string; message: string }[];
  assert.deepEqual(
    issues.map((i) => i.code),
    ['components.undeclared_touched'],
  );
  assert.match(issues[0]?.message ?? '', /touches 7 components, more than components can list \(5\)/);
  assert.match(issues[0]?.message ?? '', /undeclared: reactor, api, cli, \+2 more\)$/);
  s.gh.expectNoMutations();
});

test('pr edit: adopting a wide PR without a block, with draft:false, writes alsoTouched and marks it ready', async () => {
  const s = editScene({ config: WIDE_CONFIG, files: FILES, pr: { isDraft: true, body: 'Opened without ghx.' } });
  const r = await edit(s.gh, { ...CONTENT, components: PRIMARY, adopt: true, draft: false });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.adopted, true);
  assert.deepEqual(r.json.changed, ['body', 'draft']);
  assert.deepEqual(s.drafts, ['ready']);
  assert.deepEqual(blockOf(String(s.patched[0]?.body)).alsoTouched, ['core', 'ui']);
});

test('pr edit: a dry-run adoption of a wide PR validates and reports draft false without writing', async () => {
  const s = editScene({ config: WIDE_CONFIG, files: FILES, pr: { isDraft: true, body: 'Opened without ghx.' } });
  const r = await edit(s.gh, { ...CONTENT, components: PRIMARY, adopt: true, draft: false }, ['--dry-run']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.dryRun, true);
  assert.equal(r.json.preview.draft, false);
  assert.deepEqual(r.json.preview.changed, ['body', 'draft']);
  s.gh.expectNoMutations();
});

test('pr edit: re-running an edit on an unchanged wide PR keeps rev and body', async () => {
  const content = { ...CONTENT, components: PRIMARY };
  const body = renderPrBody(toPrBlock(content as never, { id: BLOCK_ID, rev: 2, alsoTouched: ['core', 'ui'] }), RENDER);
  const s = editScene({ config: WIDE_CONFIG, files: FILES, pr: { body } });
  const r = await edit(s.gh, { description: CONTENT.description });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.rev, 2);
  assert.deepEqual(r.json.changed, []);
  assert.ok(!codes(r).includes('TRAILER_UI_EDIT_DISCARDED'), r.stdout);
  assert.deepEqual(editSequence(s.gh), ['config', 'snapshot', 'preflight', 'compare']);
  s.gh.expectNoMutations();
});

test('pr edit: when the diff narrows to 5 components, alsoTouched is dropped', async () => {
  const content = { ...CONTENT, components: PRIMARY };
  const body = renderPrBody(toPrBlock(content as never, { id: BLOCK_ID, rev: 1, alsoTouched: ['core', 'ui'] }), RENDER);
  const s = editScene({ config: WIDE_CONFIG, files: FILES.slice(0, 5), pr: { body } });
  const r = await edit(s.gh, { description: CONTENT.description });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.rev, 2);
  const written = String(s.patched[0]?.body);
  assert.equal(blockOf(written).alsoTouched, undefined);
  assert.match(written, /Components: app, docs, reactor, api, cli · /);
});

test('pr edit: when the diff is unknown (300 files, no checkout), the block keeps its alsoTouched', async () => {
  const content = { ...CONTENT, components: PRIMARY };
  const body = renderPrBody(toPrBlock(content as never, { id: BLOCK_ID, rev: 1, alsoTouched: ['core', 'ui'] }), RENDER);
  const capped = Array.from({ length: 300 }, (_, i) => `src/f${i}.ts`);
  const s = editScene({ config: WIDE_CONFIG, files: capped, pr: { body } });
  const r = await edit(s.gh, { description: 'Requests retried after a failure now show a banner.' });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.ok(codes(r).includes('COMPONENTS_UNCHECKED'), r.stdout);
  assert.deepEqual(blockOf(String(s.patched[0]?.body)).alsoTouched, ['core', 'ui']);

  const floored = {
    ...WIDE_CONFIG,
    components: { ...WIDE_CONFIG.components, ui: { paths: ['x/**'], minRisk: 'high' } },
  };
  const s2 = editScene({ config: floored, files: capped, pr: { body } });
  const r2 = await edit(s2.gh, { description: 'Requests retried after a failure now show a banner.' });
  assert.equal(r2.exitCode, EXIT.USAGE, r2.stdout);
  assert.deepEqual(
    r2.json.error.details.issues.map((i: { code: string }) => i.code),
    ['risk.below_component_floor'],
  );
  s2.gh.expectNoMutations();
});
