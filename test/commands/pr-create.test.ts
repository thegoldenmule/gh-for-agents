// ghx pr create (03 M9.3): the 02 §2.6 call sequence, draft and stack derivation, duplicates from the
// preflight and from a 422 race, the transient re-check before a re-POST, the local head check, and
// the dry-run halt. FakeGh records every gh call; tests assert the exact sequence.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildGraphqlArgs } from '../../src/gh/graphql.ts';
import { buildPreflightQuery, preflightVars } from '../../src/pr/create/preflight.ts';
import { EXIT } from '../contract/exit-table.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { FakeGh } from '../helpers/fake-gh.ts';
import { gitCheckout } from '../helpers/fake-git.ts';
import { argvKey, GH_FIXTURE_ROOT } from '../helpers/fixture-match.ts';
import { runInProcess } from '../helpers/harness.ts';
import { fail, HEAD_OID, INPUT, localCheckout, PARENT_OID, scene, sequence } from './pr-create-scene.ts';

const ARGV = ['pr', 'create', '-R', 'octo/demo', '--input', '-'];
const run = (gh: FakeGh, input: unknown = INPUT, extra: string[] = [], o: Parameters<typeof runInProcess>[1] = {}) =>
  runInProcess([...ARGV, ...extra], { gh, stdin: JSON.stringify(input), ...o });

test('happy path: config, preflight, compare, POST via --input -, read-back; nothing else', async () => {
  const s = scene();
  const r = await run(s.gh);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(sequence(s.gh), ['config', 'preflight', 'compare', 'post', 'readback']);
  const post = s.gh.calls[3];
  assert.ok(post);
  assert.deepEqual(post.argv.slice(0, 4), ['api', '--include', '-X', 'POST']);
  assert.ok(post.argv.includes('repos/octo/demo/pulls'));
  assert.deepEqual(post.argv.slice(-2), ['--input', '-']);
  assert.ok(!post.argv.some((a) => a.includes(INPUT.title)), 'the title never travels in argv');
  const sent = s.posted[0] as Record<string, unknown>;
  assert.equal(sent.title, INPUT.title);
  assert.equal(sent.head, INPUT.head);
  assert.equal(sent.base, 'main');
  assert.equal(sent.draft, false);
  const body = String(sent.body);
  assert.ok(
    body.startsWith(
      `${INPUT.description}\n\nRisk: low · Components: app · Revert: revert-safe · Tests: 1/1 pass (unit)\n\n`,
    ),
  );
  assert.match(body, /<!-- ghx:v1 \{.*"id":"p_[0-9a-hjkmnp-tv-z]{6}".*\} -->$/);

  const out = r.json;
  assert.equal(out.ref, 'octo/demo#101');
  assert.equal(out.number, 101);
  assert.equal(out.url, 'https://github.com/octo/demo/pull/101');
  assert.equal(out.title, INPUT.title);
  assert.deepEqual(out.head, { ref: INPUT.head, sha: HEAD_OID });
  assert.equal(out.draft, false);
  assert.equal(out.draftDerived, true);
  assert.equal(out.stackedOn, null);
  assert.equal(out.body, body);
  assert.ok(body.includes(`"id":"${out.blockId}"`));
  assert.deepEqual(out.next, ['ghx ci wait octo/demo#101', 'ghx pr status octo/demo#101']);
  assert.equal(out.warnings, undefined);
});

test('draft is derived from the base, and stackedOn is auto-filled from the parent PR', async () => {
  const s = scene({ branches: { 'feat/parent': { oid: PARENT_OID, prs: [{ number: 7 }] } } });
  const r = await run(s.gh, { ...INPUT, base: 'feat/parent' });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.draft, true);
  assert.equal(r.json.draftDerived, true);
  assert.equal(r.json.stackedOn, 'octo/demo#7');
  assert.equal(s.posted[0]?.draft, true);
  assert.match(String(s.posted[0]?.body), /· Stacked on #7\n/);
  assert.match(String(s.posted[0]?.body), /"stackedOn":"#7"/);
});

test('a fork PR from a same-named branch is neither a duplicate nor the stack parent', async () => {
  const s = scene({
    branches: {
      'feat/parent': { oid: PARENT_OID, prs: [{ number: 9, repo: 'someone/demo' }] },
      'feat/retry-banner': { oid: HEAD_OID, prs: [{ number: 8, repo: 'someone/demo' }] },
    },
  });
  const r = await run(s.gh, { ...INPUT, base: 'feat/parent' });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.stackedOn, null);
  assert.deepEqual(
    r.json.warnings.map((w: { code: string }) => w.code),
    ['BASE_NOT_A_PR'],
  );
});

test('explicit draft:false on a stacked base warns STACKED_NOT_DRAFT', async () => {
  const s = scene({ branches: { 'feat/parent': { oid: PARENT_OID, prs: [{ number: 7 }] } } });
  const r = await run(s.gh, { ...INPUT, base: 'feat/parent', draft: false });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.draft, false);
  assert.equal(r.json.draftDerived, false);
  assert.deepEqual(
    r.json.warnings.map((w: { code: string }) => w.code),
    ['STACKED_NOT_DRAFT'],
  );
});

test('DUPLICATE_PR from the preflight: exit 6, existing ref, hint names pr edit, no POST', async () => {
  const s = scene({ branches: { 'feat/retry-banner': { oid: HEAD_OID, prs: [{ number: 41 }] } } });
  const r = await run(s.gh);
  assert.equal(r.exitCode, EXIT.POLICY, r.stdout);
  assert.equal(r.json.error.code, 'DUPLICATE_PR');
  assert.deepEqual(r.json.error.details, { existing: 'octo/demo#41' });
  assert.match(r.json.error.hint, /ghx pr edit octo\/demo#41 --input patch\.json/);
  assert.deepEqual(sequence(s.gh), ['config', 'preflight']);
  s.gh.expectNoMutations();
});

test('a closed PR on the head only warns', async () => {
  const s = scene({ branches: { 'feat/retry-banner': { oid: HEAD_OID, prs: [{ number: 40, state: 'CLOSED' }] } } });
  const r = await run(s.gh);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(
    r.json.warnings.map((w: { code: string }) => w.code),
    ['CLOSED_PR_ON_HEAD'],
  );
});

test('DUPLICATE_PR from a 422 race: the re-check names the PR that won', async () => {
  const s = scene({
    post: [
      fail(
        422,
        {
          message: 'Validation Failed',
          errors: [{ code: 'custom', message: 'A pull request already exists for octo:feat/retry-banner.' }],
        },
        'Unprocessable Entity',
      ),
    ],
    recheck: [{ number: 41, body: 'opened by someone else' }],
  });
  const r = await run(s.gh);
  assert.equal(r.exitCode, EXIT.POLICY, r.stdout);
  assert.equal(r.json.error.code, 'DUPLICATE_PR');
  assert.deepEqual(r.json.error.details, { existing: 'octo/demo#41' });
  assert.deepEqual(sequence(s.gh), ['config', 'preflight', 'compare', 'post', 'recheck']);
});

test('a transient POST failure re-checks for an open PR before re-posting', async () => {
  const clock = new FakeClock();
  const s = scene({ post: [fail(502, { message: 'Server Error' }, 'Bad Gateway'), 'echo'] });
  let done = false;
  const p = run(s.gh, INPUT, [], { clock }).finally(() => {
    done = true;
  });
  await clock.runUntil(() => done, { stepMs: 250 });
  const r = await p;
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(sequence(s.gh), ['config', 'preflight', 'compare', 'post', 'recheck', 'post', 'readback']);
  assert.equal(r.json.recoveredFromTransient, undefined);
  assert.deepEqual(s.posted[0], s.posted[1], 'the retry sends the same payload');
});

test('a transient failure whose PR did go through is recovered by block id: exactly one POST', async () => {
  const s = scene({
    post: [fail(502, { message: 'Server Error' }, 'Bad Gateway')],
    recheck: (posted) => [{ number: 55, body: String(posted[0]?.body) }],
  });
  const r = await run(s.gh);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(sequence(s.gh), ['config', 'preflight', 'compare', 'post', 'recheck', 'readback']);
  assert.equal(r.json.ref, 'octo/demo#55');
  assert.equal(r.json.recoveredFromTransient, true);
});

test('repeated transient failures end in GH_FAILED (exit 7) after 3 POSTs, each preceded by a re-check', async () => {
  const clock = new FakeClock();
  const s = scene({ post: [fail(502, { message: 'Server Error' }, 'Bad Gateway')] });
  let done = false;
  const p = run(s.gh, INPUT, [], { clock }).finally(() => {
    done = true;
  });
  await clock.runUntil(() => done, { stepMs: 250 });
  const r = await p;
  assert.equal(r.exitCode, EXIT.GH_FAILED, r.stdout);
  assert.equal(r.json.error.code, 'GH_FAILED');
  assert.match(r.json.error.hint, /re-checks for a created PR/);
  assert.deepEqual(sequence(s.gh).slice(3), ['post', 'recheck', 'post', 'recheck', 'post', 'recheck']);
});

test('HEAD_DIFFERS_FROM_LOCAL when the cwd checkout has the head at another commit; config is local', async () => {
  const dir = localCheckout();
  const s = scene({ remoteConfig: false });
  const git = gitCheckout('octo/demo', { toplevel: dir, refs: { 'refs/heads/feat/retry-banner': 'd'.repeat(40) } });
  const r = await runInProcess(['pr', 'create', '--input', '-'], { gh: s.gh, git, stdin: JSON.stringify(INPUT) });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(sequence(s.gh), ['preflight', 'compare', 'post', 'readback']);
  assert.deepEqual(
    r.json.warnings.map((w: { code: string }) => w.code),
    ['HEAD_DIFFERS_FROM_LOCAL'],
  );
  assert.match(r.json.warnings[0].message, /dddddddd?.*bbbbbbb/);
});

test('missing --input is USAGE_INPUT_MISSING (exit 2) with no gh call', async () => {
  const s = scene();
  const r = await runInProcess(['pr', 'create', '-R', 'octo/demo'], { gh: s.gh });
  assert.equal(r.exitCode, EXIT.USAGE);
  assert.equal(r.json.error.code, 'USAGE_INPUT_MISSING');
  assert.deepEqual(s.gh.calls, []);
});

test('PR fields are JSON-only: --title is not a flag', async () => {
  const r = await runInProcess([...ARGV, '--title', 'x'], { gh: scene().gh, stdin: JSON.stringify(INPUT) });
  assert.equal(r.exitCode, EXIT.USAGE);
  assert.equal(r.json.error.code, 'USAGE_UNKNOWN_FLAG');
});

test('VALIDATION lists every offline issue at once and makes no GitHub call after the config', async () => {
  const s = scene();
  const r = await run(s.gh, {
    ...INPUT,
    title: `feat(app): ${'x'.repeat(80)}`,
    description: '- a list item',
    testing: [{ kind: 'unit', command: 'pnpm test | tee log', result: 'pass' }],
  });
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  assert.equal(r.json.error.code, 'VALIDATION');
  const codes = r.json.error.details.issues.map((i: { code: string }) => i.code);
  assert.deepEqual(codes, ['title.too_long', 'description.markdown_structure', 'testing.compound_command']);
  assert.deepEqual(sequence(s.gh), ['config']);
});

test('a structural issue (missing field) is VALIDATION before any rule or network call', async () => {
  const s = scene();
  const { risk: _r, ...noRisk } = INPUT;
  const r = await run(s.gh, noRisk);
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  assert.equal(r.json.error.details.issues[0].path, 'risk');
  assert.deepEqual(sequence(s.gh), ['config']);
});

test('network VALIDATION: an undeclared touched component and a missing ref, together; no POST', async () => {
  const s = scene({ files: ['src/banner.ts', 'docs/banner.md'], missingAliases: ['r0'] });
  const r = await run(s.gh, { ...INPUT, refs: { closes: ['#999'] } });
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  const issues = r.json.error.details.issues.map((i: { path: string; code: string }) => `${i.path} ${i.code}`);
  assert.deepEqual(issues, ['components components.undeclared_touched', 'refs.closes[0] refs.not_found']);
  assert.deepEqual(sequence(s.gh), ['config', 'preflight', 'compare']);
  s.gh.expectNoMutations();
});

test('refs.stacked_on_default_base is checked once the default branch is known', async () => {
  const s = scene();
  const r = await run(s.gh, { ...INPUT, refs: { stackedOn: '#7' } });
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  const codes = r.json.error.details.issues.map((i: { code: string }) => i.code);
  assert.ok(codes.includes('refs.stacked_on_default_base'), codes.join());
});

for (const [name, opts, code] of [
  ['base branch missing', { branches: { main: { oid: null } } }, 'BRANCH_MISSING'],
  ['head not pushed', { branches: { 'feat/retry-banner': { oid: null } } }, 'HEAD_NOT_PUSHED'],
  ['no commits ahead', { aheadBy: 0 }, 'NO_COMMITS'],
] as const) {
  test(`${name}: ${code}, exit 9, no POST`, async () => {
    const s = scene(opts);
    const r = await run(s.gh);
    assert.equal(r.exitCode, EXIT.STATE, r.stdout);
    assert.equal(r.json.error.code, code);
    s.gh.expectNoMutations();
  });
}

test('viewerPermission READ is GH_FORBIDDEN (exit 7)', async () => {
  const s = scene({ permission: 'READ' });
  const r = await run(s.gh);
  assert.equal(r.exitCode, EXIT.GH_FAILED, r.stdout);
  assert.equal(r.json.error.code, 'GH_FORBIDDEN');
  s.gh.expectNoMutations();
});

test('--dry-run runs every read, halts at the POST and previews the PR without ref/number/url', async () => {
  const s = scene({ branches: { 'feat/parent': { oid: PARENT_OID, prs: [{ number: 7 }] } } });
  const r = await run(s.gh, { ...INPUT, base: 'feat/parent' }, ['--dry-run']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  s.gh.expectNoMutations();
  assert.deepEqual(sequence(s.gh), ['config', 'preflight', 'compare']);
  assert.equal(r.json.dryRun, true);
  const would = r.json.wouldRun[0];
  assert.ok(would.argv.includes('POST') && would.argv.includes('repos/octo/demo/pulls'));
  assert.equal(JSON.parse(would.stdin).title, INPUT.title);
  const preview = r.json.preview;
  assert.equal(preview.ref, undefined);
  assert.equal(preview.number, undefined);
  assert.equal(preview.draft, true);
  assert.equal(preview.stackedOn, 'octo/demo#7');
  assert.equal(preview.body, JSON.parse(would.stdin).body);
});

test('smoke/pr-create: the example reaches the halt, and the fixture query matches the builder', async () => {
  const gh = FakeGh.fromScenario('smoke/pr-create');
  const r = await runInProcess([...ARGV, '--dry-run'], { gh, stdin: JSON.stringify(INPUT) });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.dryRun, true);
  const fixture = JSON.parse(readFileSync(join(GH_FIXTURE_ROOT, 'smoke/pr-create/002-preflight.json'), 'utf8'));
  const repo = { host: 'github.com', owner: 'octo', name: 'demo' };
  const built = buildGraphqlArgs(buildPreflightQuery([]), preflightVars(repo, 'main', 'feat/retry-banner'), { repo });
  assert.equal(argvKey(fixture.argv), argvKey(built.args), 'regenerate the pr-create fixtures: the query changed');
});
