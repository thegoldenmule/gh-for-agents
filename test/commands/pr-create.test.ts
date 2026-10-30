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

test('missing --input is USAGE_INPUT_MISSING (exit 2) with no gh call; the hint names --example', async () => {
  const s = scene();
  const r = await runInProcess(['pr', 'create', '-R', 'octo/demo'], { gh: s.gh });
  assert.equal(r.exitCode, EXIT.USAGE);
  assert.equal(r.json.error.code, 'USAGE_INPUT_MISSING');
  assert.match(r.json.error.hint, /ghx pr create --example/);
  assert.deepEqual(s.gh.calls, []);
});

test('PR fields are JSON-only: --title is not a flag', async () => {
  const r = await runInProcess([...ARGV, '--title', 'x'], { gh: scene().gh, stdin: JSON.stringify(INPUT) });
  assert.equal(r.exitCode, EXIT.USAGE);
  assert.equal(r.json.error.code, 'USAGE_UNKNOWN_FLAG');
});

test('VALIDATION lists every offline issue at once, after the reads, with no POST', async () => {
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
  assert.deepEqual(sequence(s.gh), ['config', 'preflight', 'compare']);
  assert.match(r.json.error.hint, /ghx pr create --example prints a valid input for this repo$/);
  s.gh.expectNoMutations();
});

test('one pass: structure, rule and network issues come back together', async () => {
  const s = scene({ files: ['src/banner.ts'], missingAliases: ['r0'] });
  const { risk: _r, ...noRisk } = INPUT;
  const r = await run(s.gh, {
    ...noRisk,
    title: 'feat(app): retry banner',
    testing: [
      { kind: 'unit', command: 'pnpm test', result: 'passed' },
      { kind: 'manual', result: 'pass' },
    ],
    refs: { closes: ['#999'] },
    labels: ['bug'],
  });
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  const got = r.json.error.details.issues.map((i: { path: string; code: string }) => `${i.path} ${i.code}`);
  assert.deepEqual(got, [
    'labels unrecognized_keys',
    'testing[0].result invalid_value',
    'risk invalid_type',
    'testing[1].steps testing.steps_required',
    'refs.closes[0] refs.not_found',
  ]);
  const byPath = Object.fromEntries(
    r.json.error.details.issues.map((i: { path: string; message: string }) => [i.path, i.message]),
  );
  assert.match(byPath.labels, /ghx does not set labels/);
  assert.match(byPath.risk, /^missing required field 'risk': one of trivial, low, medium, high; e.g. "low"$/);
  assert.deepEqual(sequence(s.gh), ['config', 'preflight', 'compare']);
});

test('a state failure beside VALIDATION issues rides in details.blocked; alone it is its own error', async () => {
  const s = scene({ branches: { 'feat/retry-banner': { oid: null } } });
  const r = await run(s.gh, { ...INPUT, risk: 'medium' });
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  assert.deepEqual(
    r.json.error.details.issues.map((i: { code: string }) => i.code),
    ['risk.note_required'],
  );
  assert.equal(r.json.error.details.blocked.code, 'HEAD_NOT_PUSHED');
  assert.equal(r.json.error.details.blocked.hint, 'git push -u origin feat/retry-banner');
});

test('normalisation: body, a trailing period, a scope alias, a chained command; each with a warning', async () => {
  const config = {
    version: 1,
    components: { app: { paths: ['src/**'], aliases: ['web'] }, docs: { paths: ['docs/**'] } },
  };
  const s = scene({ config, files: ['src/banner.ts', 'docs/banner.md'] });
  const { description, components: _c, ...rest } = INPUT;
  const r = await run(
    s.gh,
    {
      ...rest,
      title: 'feat(web): show a banner when a request is retried.',
      body: description,
      testing: [{ kind: 'unit', command: 'cd packages/app && pnpm typecheck && pnpm test', result: 'pass' }],
    },
    ['--dry-run'],
  );
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(
    r.json.warnings.map((w: { code: string }) => w.code),
    ['FIELD_RENAMED', 'TITLE_PERIOD_REMOVED', 'TESTING_SPLIT', 'COMPONENT_ALIAS', 'COMPONENTS_ADDED'],
  );
  const posted = JSON.parse(r.json.wouldRun[0].stdin);
  assert.equal(posted.title, 'feat(app): show a banner when a request is retried');
  assert.match(posted.body, /Components: app, docs/);
  assert.match(posted.body, /"command":"pnpm typecheck","cwd":"packages\/app"/);
});

test('base and head default to the default branch and the current branch, with warnings', async () => {
  const s = scene();
  s.gh.on((a) => a.some((x) => x.includes('defaultBranchRef{name}}}')), {
    exitCode: 0,
    stderr: '',
    stdout: `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ data: { repository: { defaultBranchRef: { name: 'main' } } } })}`,
  });
  const { base: _b, head: _h, ...rest } = INPUT;
  const git = gitCheckout('octo/demo', { toplevel: localCheckout(), branch: 'feat/retry-banner' });
  const r = await runInProcess(['pr', 'create', '--input', '-', '--dry-run'], {
    gh: s.gh,
    git,
    stdin: JSON.stringify(rest),
  });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(
    r.json.warnings.map((w: { code: string }) => w.code),
    ['HEAD_DEFAULTED', 'BASE_DEFAULTED'],
  );
  assert.equal(r.json.preview.base, 'main');
  assert.equal(r.json.preview.head.ref, 'feat/retry-banner');
});

test('--example prints a valid input for this repo that passes as is', async () => {
  const s = scene();
  const ex = await runInProcess(['pr', 'create', '-R', 'octo/demo', '--example'], { gh: s.gh });
  assert.equal(ex.exitCode, EXIT.OK, ex.stdout);
  assert.deepEqual(ex.json.components, ['app', 'docs', 'reactor']);
  assert.equal(ex.json.example.title, 'feat(app): show a banner when a request is retried');
  assert.ok(ex.json.rules.some((r: string) => r.includes('no &&')));
  const r = await run(scene().gh, { ...ex.json.example, base: 'main', head: 'feat/retry-banner' }, ['--dry-run']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
});

test('network VALIDATION: a missing ref; a touched component is added, not an issue', async () => {
  const s = scene({ files: ['src/banner.ts', 'docs/banner.md'], missingAliases: ['r0'] });
  const r = await run(s.gh, { ...INPUT, refs: { closes: ['#999'] } });
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  const issues = r.json.error.details.issues.map((i: { path: string; code: string }) => `${i.path} ${i.code}`);
  assert.deepEqual(issues, ['refs.closes[0] refs.not_found']);
  assert.deepEqual(sequence(s.gh), ['config', 'preflight', 'compare']);
  assert.deepEqual(
    r.json.error.details.warnings.map((w: { code: string }) => w.code),
    ['COMPONENTS_ADDED'],
  );
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

test('a harness footer at the end of the description is stripped with FOOTER_STRIPPED, not VALIDATION', async () => {
  const s = scene();
  const footer = '\n\n---\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n';
  const r = await run(s.gh, { ...INPUT, description: `${INPUT.description}${footer}` }, ['--dry-run']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(
    r.json.warnings.map((w: { code: string }) => w.code),
    ['FOOTER_STRIPPED'],
  );
  assert.ok(r.json.preview.body.startsWith(`${INPUT.description}\n\nRisk: low`), r.json.preview.body);
  assert.equal(r.json.preview.body.split('Generated with').length, 2, 'only the rendered footer remains');
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
