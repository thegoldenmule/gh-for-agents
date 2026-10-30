// ghx pr create --batch (03 M9.4, 02 §2.4): defaults deep-merged into items (arrays replace), unique
// heads, topological order with stackedOn filled from the batch, every item validated (network checks
// included) before the first POST, and PARTIAL_FAILURE with created / failed / notAttempted.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { batchOrder, deepMerge } from '../../src/pr/create/batch.ts';
import { EXIT } from '../contract/exit-table.ts';
import { runInProcess } from '../helpers/harness.ts';
import { fail, INPUT, scene, sequence } from './pr-create-scene.ts';

const ARGV = ['pr', 'create', '--batch', '-R', 'octo/demo', '--input', '-'];
const { title: _t, head: _h, ...SHARED } = INPUT;
const item = (n: string, extra: Record<string, unknown> = {}) => ({
  title: `feat(app): part ${n} of the retry banner`,
  head: `feat/part-${n}`,
  ...extra,
});
const batch = (items: unknown[], defaults: unknown = SHARED) => JSON.stringify({ defaults, items });
const OIDS = {
  'feat/part-1': { oid: '1'.repeat(40) },
  'feat/part-2': { oid: '2'.repeat(40) },
  'feat/part-3': { oid: '3'.repeat(40) },
};

test('deepMerge: objects merge key by key, arrays and scalars replace, undefined is skipped', () => {
  const a = { risk: 'low', components: ['app', 'docs'], refs: { splitFrom: '#1', closes: ['#2'] } };
  const b = { risk: 'medium', components: ['app'], refs: { closes: ['#3'] }, draft: undefined };
  assert.deepEqual(deepMerge(a, b), {
    risk: 'medium',
    components: ['app'],
    refs: { splitFrom: '#1', closes: ['#3'] },
  });
  assert.deepEqual(a.components, ['app', 'docs'], 'inputs are not mutated');
});

test('batchOrder: parents first, input order otherwise; duplicate heads and cycles are issues', () => {
  const r = batchOrder([
    { base: 'b', head: 'c' },
    { base: 'main', head: 'a' },
    { base: 'a', head: 'b' },
    { base: 'main', head: 'd' },
  ]);
  assert.deepEqual(r.order, [1, 2, 3, 0]);
  assert.deepEqual(r.issues, []);
  const dup = batchOrder([{ head: 'x' }, { head: 'x' }]);
  assert.deepEqual(
    dup.issues.map((i) => `${i.path} ${i.code}`),
    ['items[1].head batch.duplicate_head'],
  );
  const cyc = batchOrder([
    { base: 'b', head: 'a' },
    { base: 'a', head: 'b' },
    { base: 'main', head: 'c' },
  ]);
  assert.deepEqual(cyc.order, [2]);
  assert.deepEqual(
    cyc.issues.map((i) => i.code),
    ['batch.cycle'],
  );
  assert.match(cyc.issues[0]?.message ?? '', /items 0, 1/);
});

test('a stacked pair: every item is checked before the first POST; parent first; child gets stackedOn', async () => {
  const s = scene({ branches: OIDS });
  const stdin = batch([item('2', { base: 'feat/part-1' }), item('1')]);
  const r = await runInProcess(ARGV, { gh: s.gh, stdin });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(sequence(s.gh), [
    'config',
    'preflight',
    'compare',
    'preflight',
    'compare',
    'post',
    'readback',
    'post',
    'readback',
  ]);
  assert.deepEqual(
    s.posted.map((p) => p.head),
    ['feat/part-1', 'feat/part-2'],
  );
  assert.equal(s.posted[0]?.draft, false);
  assert.equal(s.posted[1]?.draft, true, 'a stacked item defaults to draft');
  assert.match(String(s.posted[1]?.body), /· Stacked on #101\n/);
  const out = r.json;
  assert.deepEqual(
    out.created.map((c: { ref: string; stackedOn: string | null }) => [c.ref, c.stackedOn]),
    [
      ['octo/demo#101', null],
      ['octo/demo#102', 'octo/demo#101'],
    ],
  );
  assert.equal(out.failed, null);
  assert.deepEqual(out.notAttempted, []);
});

test('a title of $2 stays literal (the shell-function bug of gh-usage-findings §4.1)', async () => {
  const s = scene({ branches: OIDS });
  const titles = ['feat(app): route $2 to the retry handler', 'fix(app): keep "$1" and `x` as typed'];
  const stdin = batch([item('1', { title: titles[0] }), item('2', { title: titles[1] })]);
  const r = await runInProcess(ARGV, { gh: s.gh, stdin });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(
    s.posted.map((p) => p.title),
    titles,
  );
  for (const c of s.gh.calls) assert.ok(!c.argv.some((a) => a.includes('$2')));
});

test('offline issues of every item come back at once, prefixed items[i]; no network call', async () => {
  const s = scene({ branches: OIDS });
  const stdin = batch([
    item('1', { title: 'Add a banner.' }),
    item('2', { description: '# heading' }),
    item('2', { title: 'feat(app): again' }),
  ]);
  const r = await runInProcess(ARGV, { gh: s.gh, stdin });
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  const issues = r.json.error.details.issues.map((i: { path: string; code: string }) => `${i.path} ${i.code}`);
  assert.ok(issues.includes('items[0].title title.format'), issues.join('\n'));
  assert.ok(issues.includes('items[1].description description.markdown_structure'), issues.join('\n'));
  assert.ok(issues.includes('items[2].head batch.duplicate_head'), issues.join('\n'));
  assert.deepEqual(sequence(s.gh), ['config']);
});

test('a stacking cycle is VALIDATION before any network call', async () => {
  const s = scene({ branches: OIDS });
  const stdin = batch([item('1', { base: 'feat/part-2' }), item('2', { base: 'feat/part-1' })]);
  const r = await runInProcess(ARGV, { gh: s.gh, stdin });
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  assert.deepEqual(
    r.json.error.details.issues.map((i: { code: string }) => i.code),
    ['batch.cycle'],
  );
  assert.deepEqual(sequence(s.gh), ['config']);
});

test('a network failure on a later item stops the batch before the first POST', async () => {
  const s = scene({ branches: { ...OIDS, 'feat/part-2': { oid: null } } });
  const r = await runInProcess(ARGV, { gh: s.gh, stdin: batch([item('1'), item('2'), item('3')]) });
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.equal(r.json.error.code, 'HEAD_NOT_PUSHED');
  assert.match(r.json.error.message, /^items\[1\]: /);
  assert.equal(r.json.error.details.index, 1);
  assert.deepEqual(r.json.error.details.created, []);
  assert.deepEqual(r.json.error.details.notAttempted, [0, 2]);
  s.gh.expectNoMutations();
});

test('network VALIDATION issues of every item are collected before any POST', async () => {
  const s = scene({ branches: OIDS, missingAliases: ['r0'] });
  const refs = { refs: { closes: ['#999'] } };
  const r = await runInProcess(ARGV, { gh: s.gh, stdin: batch([item('1', refs), item('2', refs)]) });
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  assert.deepEqual(
    r.json.error.details.issues.map((i: { path: string; code: string }) => `${i.path} ${i.code}`),
    ['items[0].refs.closes[0] refs.not_found', 'items[1].refs.closes[0] refs.not_found'],
  );
  s.gh.expectNoMutations();
});

test('batch items get the touched components the input left out, with COMPONENTS_ADDED', async () => {
  const s = scene({ branches: OIDS, files: ['src/a.ts', 'docs/a.md'] });
  const r = await runInProcess(ARGV, { gh: s.gh, stdin: batch([item('1'), item('2')]) });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.ok(r.json.warnings.some((w: { code: string }) => w.code === 'COMPONENTS_ADDED'));
  assert.match(String(s.posted[0]?.body), /Components: app, docs/);
});

test('a mid-batch failure is PARTIAL_FAILURE (exit 7) with created, failed and notAttempted', async () => {
  const s = scene({
    branches: OIDS,
    post: [
      'echo',
      fail(422, { message: 'Validation Failed', errors: [{ message: 'base is protected' }] }, 'Unprocessable Entity'),
    ],
  });
  const r = await runInProcess(ARGV, { gh: s.gh, stdin: batch([item('1'), item('2'), item('3')]) });
  assert.equal(r.exitCode, EXIT.GH_FAILED, r.stdout);
  assert.equal(r.json.error.code, 'PARTIAL_FAILURE');
  const d = r.json.error.details;
  assert.deepEqual(d.created, ['octo/demo#101']);
  assert.equal(d.failed.index, 1);
  assert.equal(d.failed.head, 'feat/part-2');
  assert.equal(d.failed.code, 'GH_FAILED');
  assert.deepEqual(d.notAttempted, [2]);
  assert.match(r.json.error.message, /created 1 of 3 PRs; items\[1\] failed/);
  assert.equal(sequence(s.gh).filter((c) => c === 'post').length, 2, 'the batch stops at the failure');
});

test('a created PR whose read-back differs counts as created, flagged, and is never suggested for a re-run', async () => {
  const s = scene({ branches: OIDS, readback: { title: 'feat(app): drifted' } });
  const r = await runInProcess(ARGV, { gh: s.gh, stdin: batch([item('1'), item('2')]) });
  assert.equal(r.exitCode, EXIT.GH_FAILED, r.stdout);
  assert.equal(r.json.error.code, 'PARTIAL_FAILURE');
  const d = r.json.error.details;
  assert.deepEqual(d.created, ['octo/demo#101']);
  assert.deepEqual(
    [d.failed.index, d.failed.code, d.failed.created, d.failed.readbackMismatch],
    [0, 'READBACK_MISMATCH', true, true],
  );
  assert.deepEqual(d.notAttempted, [1]);
  assert.match(r.json.error.message, /created 1 of 2 PRs/);
  assert.match(r.json.error.hint, /ghx pr edit octo\/demo#101/);
  assert.match(r.json.error.hint, /re-run --batch with only items 1\./);
  assert.doesNotMatch(r.json.error.hint, /items 0/);
});

test('a failure on the first POST is that item’s own error, not PARTIAL_FAILURE', async () => {
  const s = scene({
    branches: OIDS,
    post: [
      fail(422, { message: 'Validation Failed', errors: [{ message: 'base is protected' }] }, 'Unprocessable Entity'),
    ],
  });
  const r = await runInProcess(ARGV, { gh: s.gh, stdin: batch([item('1'), item('2')]) });
  assert.equal(r.exitCode, EXIT.GH_FAILED, r.stdout);
  assert.equal(r.json.error.code, 'GH_FAILED');
  assert.equal(r.json.error.details.index, 0);
  assert.deepEqual(r.json.error.details.notAttempted, [1]);
});

test('--batch --dry-run checks every item, halts at the first POST, and previews them all', async () => {
  const s = scene({ branches: OIDS });
  const stdin = batch([item('2', { base: 'feat/part-1' }), item('1')]);
  const r = await runInProcess([...ARGV, '--dry-run'], { gh: s.gh, stdin });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  s.gh.expectNoMutations();
  assert.equal(r.json.dryRun, true);
  assert.equal(JSON.parse(r.json.wouldRun[0].stdin).head, 'feat/part-1');
  const items = r.json.preview.items;
  assert.deepEqual(
    items.map((p: { index: number; draft: boolean; stackedOnItem?: number }) => [p.index, p.draft, p.stackedOnItem]),
    [
      [1, false, undefined],
      [0, true, 1],
    ],
  );
});

test('--batch strips a harness footer per item, with the warning prefixed items[i]', async () => {
  const s = scene({ branches: OIDS });
  const footer = '\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)';
  const stdin = batch([item('1'), item('2', { description: `${SHARED.description}${footer}` })]);
  const r = await runInProcess([...ARGV, '--dry-run'], { gh: s.gh, stdin });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const stripped = r.json.warnings.filter((w: { code: string }) => w.code === 'FOOTER_STRIPPED');
  assert.equal(stripped.length, 1);
  assert.match(stripped[0].message, /^items\[1\]: Removed '🤖 Generated with/);
});

test('--batch input shape: PR fields at the top level, or items without --batch, are VALIDATION', async () => {
  const top = await runInProcess(ARGV, {
    gh: scene().gh,
    stdin: JSON.stringify({ title: INPUT.title, items: [item('1')] }),
  });
  assert.equal(top.exitCode, EXIT.USAGE);
  assert.equal(top.json.error.details.issues[0].code, 'batch.top_level_field');
  const noFlag = await runInProcess(['pr', 'create', '-R', 'octo/demo', '--input', '-'], {
    gh: scene().gh,
    stdin: batch([item('1')]),
  });
  assert.equal(noFlag.exitCode, EXIT.USAGE);
  assert.equal(noFlag.json.error.details.issues[0].code, 'batch.flag_required');
  const titleInDefaults = await runInProcess(ARGV, {
    gh: scene().gh,
    stdin: batch([item('1')], { ...SHARED, title: 'x' }),
  });
  assert.equal(titleInDefaults.exitCode, EXIT.USAGE);
  assert.match(titleInDefaults.json.error.details.issues[0].path, /^defaults\.title/);
});
