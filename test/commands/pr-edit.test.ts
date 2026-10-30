// ghx pr edit (02 §3, 03 M10.1): the call sequence, the PATCH via --input -, the draft toggle through
// GraphQL, the base retarget with the stack re-checked and HAS_CHILDREN, the merged object re-validated
// (createRules and the network rules), the dry-run halt, idempotent re-runs and the exact read-back.
// R12 (block preservation, drift, NO_BLOCK, CONCURRENT_EDIT) lives in test/regression/.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_FOOTER } from '../../src/config/sections/render.ts';
import { buildGraphqlArgs } from '../../src/gh/graphql.ts';
import { readPrBlock } from '../../src/meta/schemas.ts';
import { buildPreflightQuery, preflightVars } from '../../src/pr/create/preflight.ts';
import { SNAPSHOT_QUERY } from '../../src/pr/edit/snapshot.ts';
import { renderPrBody, toPrBlock } from '../../src/render/pr-body.ts';
import { EXIT } from '../contract/exit-table.ts';
import { FakeGh } from '../helpers/fake-gh.ts';
import { argvKey, GH_FIXTURE_ROOT } from '../helpers/fixture-match.ts';
import { runInProcess } from '../helpers/harness.ts';
import { CONFIG, ok, PARENT_OID } from './pr-create-scene.ts';
import { BLOCK_ID, bodyOf, CONTENT, editLabel, editScene, editSequence, PR_NODE_ID, RENDER } from './pr-edit-scene.ts';

const ARGV = ['pr', 'edit', 'octo/demo#12', '--input', '-'];
const run = (gh: FakeGh, patch: unknown, extra: string[] = []) =>
  runInProcess([...ARGV, ...extra], { gh, stdin: JSON.stringify(patch) });
const codes = (r: { json: { warnings?: { code: string }[] } }) => (r.json.warnings ?? []).map((w) => w.code);
const blockOf = (body: string) => {
  const b = readPrBlock(body);
  assert.equal(b.status, 'ok');
  return b.status === 'ok' ? b.block : (undefined as never);
};

const NEW_DESCRIPTION = 'Requests retried after a transient failure now show a banner the user can dismiss.';

test('happy path: snapshot, preflight, compare, re-read, PATCH via --input -, read-back; nothing else', async () => {
  const s = editScene();
  const r = await run(s.gh, { description: NEW_DESCRIPTION });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(editSequence(s.gh), ['config', 'snapshot', 'preflight', 'compare', 'snapshot', 'patch', 'readback']);
  const patch = s.gh.calls[5];
  assert.ok(patch);
  assert.deepEqual(patch.argv.slice(0, 4), ['api', '--include', '-X', 'PATCH']);
  assert.ok(patch.argv.includes('repos/octo/demo/pulls/12'));
  assert.deepEqual(patch.argv.slice(-2), ['--input', '-']);
  assert.ok(!patch.argv.some((a) => a.includes(NEW_DESCRIPTION)), 'the body never travels in argv');
  assert.deepEqual(Object.keys(s.patched[0] ?? {}), ['body'], 'only the changed field is sent');
  const want = bodyOf({ ...CONTENT, description: NEW_DESCRIPTION }, 2);
  assert.equal(s.patched[0]?.body, want);
  assert.deepEqual(r.json, {
    ref: 'octo/demo#12',
    url: 'https://github.com/octo/demo/pull/12',
    rev: 2,
    blockId: BLOCK_ID,
    adopted: false,
    changed: ['body'],
    title: CONTENT.title,
    base: 'main',
    draft: false,
    body: want,
    next: ['ghx pr status octo/demo#12'],
  });
});

test('re-running the same edit is a no-op: rev stays, no re-read, no PATCH', async () => {
  const s = editScene({ pr: { body: bodyOf({ ...CONTENT, description: NEW_DESCRIPTION }, 2) } });
  const r = await run(s.gh, { description: NEW_DESCRIPTION });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.rev, 2);
  assert.deepEqual(r.json.changed, []);
  assert.deepEqual(editSequence(s.gh), ['config', 'snapshot', 'preflight', 'compare']);
  s.gh.expectNoMutations();
});

test('draft:false goes through GraphQL markPullRequestReadyForReview; the block is untouched', async () => {
  const s = editScene({ pr: { isDraft: true } });
  const r = await run(s.gh, { draft: false });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(editSequence(s.gh), ['config', 'snapshot', 'preflight', 'compare', 'snapshot', 'ready', 'readback']);
  const call = s.gh.calls[5];
  assert.ok(call);
  const sent = JSON.parse(call.stdin ?? '{}') as { query: string; variables: unknown };
  assert.match(sent.query, /^mutation\(\$id:ID!\)\{markPullRequestReadyForReview\(input:\{pullRequestId:\$id\}\)/);
  assert.deepEqual(sent.variables, { id: PR_NODE_ID });
  assert.deepEqual(r.json.changed, ['draft']);
  assert.equal(r.json.draft, false);
  assert.equal(r.json.rev, 1, 'draft is not in the block');
  assert.equal(s.patched.length, 0);
});

test('draft:true goes through GraphQL convertPullRequestToDraft', async () => {
  const s = editScene();
  const r = await run(s.gh, { draft: true });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(s.drafts, ['to-draft']);
  assert.equal(r.json.draft, true);
  assert.deepEqual(r.json.changed, ['draft']);
});

test('a base retarget re-runs the stack checks: stackedOn filled, HAS_CHILDREN and STACKED_NOT_DRAFT warned', async () => {
  const s = editScene({
    branches: { 'feat/parent': { oid: PARENT_OID, prs: [{ number: 7 }] } },
    children: [20, 21],
  });
  const r = await run(s.gh, { base: 'feat/parent' });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(editSequence(s.gh), [
    'config',
    'snapshot',
    'preflight',
    'compare',
    'children',
    'snapshot',
    'patch',
    'readback',
  ]);
  assert.equal(s.patched[0]?.base, 'feat/parent');
  assert.match(String(s.patched[0]?.body), /· Stacked on #7\n/);
  assert.equal(blockOf(String(s.patched[0]?.body)).refs?.stackedOn, '#7');
  assert.deepEqual(r.json.changed, ['body', 'base']);
  assert.deepEqual(codes(r), ['STACKED_ON_UPDATED', 'HAS_CHILDREN', 'STACKED_NOT_DRAFT']);
  assert.match(r.json.warnings[1].message, /#20, #21 are stacked on octo\/demo#12/);
});

test('an explicit stackedOn that disagrees with the new base is refs.stack_mismatch', async () => {
  const s = editScene({ branches: { 'feat/parent': { oid: PARENT_OID, prs: [{ number: 7 }] } } });
  const r = await run(s.gh, { base: 'feat/parent', refs: { stackedOn: '#8' } });
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  assert.deepEqual(
    r.json.error.details.issues.map((i: { code: string }) => i.code),
    ['refs.stack_mismatch'],
  );
  s.gh.expectNoMutations();
});

test('after GitHub auto-retargets to main, a stale stackedOn is dropped instead of failing the edit', async () => {
  const stacked = { ...CONTENT, refs: { stackedOn: '#7' } };
  const s = editScene({ pr: { body: bodyOf(stacked) } });
  const r = await run(s.gh, { description: NEW_DESCRIPTION });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(codes(r), ['STACKED_ON_UPDATED']);
  assert.equal(blockOf(String(s.patched[0]?.body)).refs, undefined);
  assert.doesNotMatch(String(s.patched[0]?.body), /Stacked on/);
});

test('an empty patch is VALIDATION with no gh call', async () => {
  const s = editScene();
  const r = await run(s.gh, {});
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  assert.equal(r.json.error.code, 'VALIDATION');
  assert.match(JSON.stringify(r.json.error.details), /empty patch/);
  assert.equal(s.gh.calls.length, 0);
});

test('head is not patchable', async () => {
  const s = editScene();
  const r = await run(s.gh, { head: 'other' });
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  assert.equal(s.gh.calls.length, 0);
});

test('the merged object is re-validated with the full createRules: medium risk needs riskNote', async () => {
  const s = editScene();
  const r = await run(s.gh, { risk: 'medium' });
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  assert.deepEqual(
    r.json.error.details.issues.map((i: { code: string }) => i.code),
    ['risk.note_required'],
  );
  assert.deepEqual(editSequence(s.gh), ['config', 'snapshot']);
});

test('the network checks run on the merged object: a touched component is added to the block', async () => {
  const s = editScene({ files: ['src/banner.ts', 'docs/retry.md'] });
  const r = await run(s.gh, { description: NEW_DESCRIPTION });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(
    r.json.warnings.map((w: { code: string }) => w.code),
    ['COMPONENTS_ADDED'],
  );
  assert.deepEqual(blockOf(String(s.patched[0]?.body)).components, ['app', 'docs']);
});

test('arrays replace: the patch testing list is the new list', async () => {
  const testing = [
    { kind: 'unit', command: 'pnpm test', result: 'pass' },
    { kind: 'typecheck', command: 'pnpm typecheck', result: 'pass' },
  ];
  const s = editScene();
  const r = await run(s.gh, { testing });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const block = blockOf(String(s.patched[0]?.body));
  assert.deepEqual(block.testing, testing);
  assert.match(String(s.patched[0]?.body), /Tests: 2\/2 pass \(unit, typecheck\)/);
});

test('a title patch sends title and the re-rendered body', async () => {
  const s = editScene();
  const title = 'feat(app): show a dismissable retry banner';
  const r = await run(s.gh, { title });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(s.patched[0], { title, body: bodyOf({ ...CONTENT, title }, 2) });
  assert.deepEqual(r.json.changed, ['title', 'body']);
});

test('a description patch ending in a harness footer is stripped with FOOTER_STRIPPED', async () => {
  const s = editScene();
  const footer = '\n\nGenerated with [Claude Code](https://claude.ai/code)\n';
  const r = await run(s.gh, { description: `${NEW_DESCRIPTION}${footer}` });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(codes(r), ['FOOTER_STRIPPED']);
  assert.equal(s.patched[0]?.body, bodyOf({ ...CONTENT, description: NEW_DESCRIPTION }, 2));
});

test('a closed PR is PR_NOT_OPEN (exit 9)', async () => {
  const s = editScene({ pr: { state: 'MERGED' } });
  const r = await run(s.gh, { description: NEW_DESCRIPTION });
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.equal(r.json.error.code, 'PR_NOT_OPEN');
  assert.deepEqual(editSequence(s.gh), ['config', 'snapshot']);
});

test('a base that is not on the remote is BRANCH_MISSING (exit 9)', async () => {
  const s = editScene({ branches: { 'feat/gone': { oid: null } } });
  const r = await run(s.gh, { base: 'feat/gone' });
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.equal(r.json.error.code, 'BRANCH_MISSING');
  s.gh.expectNoMutations();
});

test('a READ viewer who is not the author is GH_FORBIDDEN, even under --dry-run', async () => {
  for (const permission of ['READ', 'TRIAGE']) {
    const s = editScene({ permission, pr: { author: { login: 'someone-else' } } });
    const r = await run(s.gh, { description: NEW_DESCRIPTION }, ['--dry-run']);
    assert.equal(r.exitCode, EXIT.GH_FAILED, r.stdout);
    assert.equal(r.json.error.code, 'GH_FORBIDDEN');
    assert.equal(r.json.error.details.permission, permission);
    s.gh.expectNoMutations();
  }
});

test('the PR author may edit their own PR without write permission (GitHub lets authors edit)', async () => {
  const s = editScene({ permission: 'READ' });
  const r = await run(s.gh, { description: NEW_DESCRIPTION });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(r.json.changed, ['body']);
});

test('a WRITE viewer may edit a PR someone else opened', async () => {
  const s = editScene({ permission: 'WRITE', pr: { author: { login: 'someone-else' } } });
  const r = await run(s.gh, { description: NEW_DESCRIPTION });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
});

test('--dry-run reads, validates and renders, then halts at the PATCH', async () => {
  const s = editScene();
  const r = await run(s.gh, { description: NEW_DESCRIPTION }, ['--dry-run']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.dryRun, true);
  assert.deepEqual(r.json.wouldRun[0].argv.slice(1, 5), ['api', '--include', '-X', 'PATCH']);
  assert.equal(r.json.preview.rev, 2);
  assert.deepEqual(r.json.preview.changed, ['body']);
  assert.equal(r.json.preview.body, bodyOf({ ...CONTENT, description: NEW_DESCRIPTION }, 2));
  s.gh.expectNoMutations();
  assert.equal(s.patched.length, 0);
});

test('a read-back with a different body is READBACK_MISMATCH (exit 7)', async () => {
  const s = editScene({ stored: { body: 'mangled' } });
  const r = await run(s.gh, { description: NEW_DESCRIPTION });
  assert.equal(r.exitCode, EXIT.GH_FAILED, r.stdout);
  assert.equal(r.json.error.code, 'READBACK_MISMATCH');
  assert.equal(r.json.error.details.field, 'body');
  assert.equal(r.json.error.details.stored, 'mangled');
});

test('a run URL is not a PR selector', async () => {
  const s = editScene();
  const r = await runInProcess(['pr', 'edit', 'https://github.com/octo/demo/actions/runs/5', '--input', '-'], {
    gh: s.gh,
    stdin: JSON.stringify({ description: NEW_DESCRIPTION }),
  });
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  assert.equal(r.json.error.code, 'USAGE_BAD_SELECTOR');
});

test('a block from a newer schema is refused even with adopt', async () => {
  const s = editScene({ pr: { body: 'Text.\n\n<!-- ghx:v2 {"t":"pr","id":"p_abc234"} -->' } });
  const r = await run(s.gh, { ...CONTENT, adopt: true });
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.equal(r.json.error.code, 'NO_BLOCK');
  assert.match(r.json.error.message, /newer schema/);
});

test('an invalid block is NO_BLOCK, and adopt rewrites it in place with a fresh id', async () => {
  const broken = 'Text.\n\n<!-- ghx:v1 {"t":"pr","id":"p_abc234","rev":"x"} -->';
  const s1 = editScene({ pr: { body: broken } });
  const r1 = await run(s1.gh, { description: NEW_DESCRIPTION });
  assert.equal(r1.json.error.code, 'NO_BLOCK');
  assert.ok(r1.json.error.details.blockError);

  const s2 = editScene({ pr: { body: broken } });
  const r2 = await run(s2.gh, { ...CONTENT, adopt: true });
  assert.equal(r2.exitCode, EXIT.OK, r2.stdout);
  assert.equal(r2.json.adopted, true);
  assert.equal(r2.json.rev, 1);
  assert.notEqual(r2.json.blockId, BLOCK_ID);
  assert.equal((String(s2.patched[0]?.body).match(/<!-- ghx:v1 /g) ?? []).length, 1);
});

test('a trailer edited in the UI is re-rendered with a TRAILER_UI_EDIT_DISCARDED warning', async () => {
  const s = editScene({ pr: { body: bodyOf().replace('Risk: low', 'Risk: low (I think)') } });
  const r = await run(s.gh, { description: NEW_DESCRIPTION });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.ok(codes(r).includes('TRAILER_UI_EDIT_DISCARDED'));
  assert.ok(!String(s.patched[0]?.body).includes('(I think)'));
  const plain = await run(editScene().gh, { description: NEW_DESCRIPTION });
  assert.ok(!codes(plain).includes('TRAILER_UI_EDIT_DISCARDED'));
});

test('BASE_NOT_A_PR warns only when the base changes, not on every edit of a PR on such a base', async () => {
  const same = await run(editScene({ pr: { baseRefName: 'release/1.x' } }).gh, { description: NEW_DESCRIPTION });
  assert.equal(same.exitCode, EXIT.OK, same.stdout);
  assert.ok(!codes(same).includes('BASE_NOT_A_PR'), codes(same).join());
  const moved = await run(editScene().gh, { base: 'release/1.x' });
  assert.equal(moved.exitCode, EXIT.OK, moved.stdout);
  assert.ok(codes(moved).includes('BASE_NOT_A_PR'));
});

/** The body pr create rendered under an earlier `render.footer`. */
const bodyWithFooter = (footer: string | null) =>
  renderPrBody(toPrBlock(CONTENT as never, { id: BLOCK_ID, rev: 1 }), { ...RENDER, footer });

/** Serve a config with this render.footer instead of the default one. */
function withFooter(gh: FakeGh, footer: string | null): void {
  const config = { ...CONFIG, render: { footer } };
  gh.on(
    (argv) => editLabel({ argv }) === 'config',
    ok({ content: Buffer.from(JSON.stringify(config)).toString('base64'), encoding: 'base64' }),
  );
}

test('a PR rendered under an older render.footer is not DESCRIPTION_DRIFT; the footer is replaced, with a warning', async () => {
  const s = editScene({ pr: { body: bodyWithFooter('Shipped by the release bot.') } });
  const r = await run(s.gh, { description: NEW_DESCRIPTION });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(s.patched[0]?.body, bodyOf({ ...CONTENT, description: NEW_DESCRIPTION }, 2));
  assert.ok(codes(r).includes('FOOTER_REPLACED'));
  assert.match(r.json.warnings.find((w: { code: string }) => w.code === 'FOOTER_REPLACED').message, /release bot/);
});

test('a PR rendered with no footer gains the current one without drift or warning', async () => {
  const s = editScene({ pr: { body: bodyWithFooter(null) } });
  const r = await run(s.gh, { description: NEW_DESCRIPTION });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.ok(String(s.patched[0]?.body).includes(DEFAULT_FOOTER));
  assert.ok(!codes(r).includes('FOOTER_REPLACED'));
});

test('render.footer set to null drops the old footer instead of reporting drift', async () => {
  const s = editScene();
  withFooter(s.gh, null);
  const r = await run(s.gh, { description: NEW_DESCRIPTION });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.ok(!String(s.patched[0]?.body).includes(DEFAULT_FOOTER));
  assert.ok(codes(r).includes('FOOTER_REPLACED'));
});

test('a multi-paragraph tail after the trailer is still DESCRIPTION_DRIFT under a changed footer', async () => {
  const s = editScene({
    pr: { body: bodyWithFooter('Old footer.').replace('Old footer.', 'Old footer.\n\nCC @someone.') },
  });
  const r = await run(s.gh, { description: NEW_DESCRIPTION });
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.equal(r.json.error.code, 'DESCRIPTION_DRIFT');
  assert.deepEqual(r.json.error.details.drift, ['appended']);
});

test('the snapshot and preflight queries match the smoke fixture byte for byte', () => {
  const dir = join(GH_FIXTURE_ROOT, 'smoke', 'pr-edit');
  const fixture = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8')).argv as string[];
  const repo = { host: 'github.com', owner: 'octo', name: 'demo' };
  const snap = buildGraphqlArgs(SNAPSHOT_QUERY, { owner: 'octo', name: 'demo', number: 12 }, { repo }).args;
  assert.equal(argvKey(fixture('002-snapshot.json')), argvKey(snap));
  const pre = buildGraphqlArgs(buildPreflightQuery([]), preflightVars(repo, 'main', 'feat/retry-banner'), {
    repo,
  }).args;
  assert.equal(argvKey(fixture('003-preflight.json')), argvKey(pre));
});

test('the smoke/pr-edit scenario replays the example to the PATCH halt under --dry-run', async () => {
  const gh = FakeGh.fromScenario('smoke/pr-edit');
  const r = await runInProcess([...ARGV, '--dry-run'], { gh, stdin: JSON.stringify({ description: NEW_DESCRIPTION }) });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.dryRun, true);
  assert.equal(r.json.preview.rev, 2);
  gh.expectNoMutations();
});
