import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigSchema } from '../../src/config/schema.ts';
import { createExample } from '../../src/pr/create/example.ts';
import { PrCreateInput } from '../../src/pr/create/schema.ts';
import { renderOptions, renderPrBody, toPrBlock } from '../../src/render/pr-body.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { FakeGh } from '../helpers/fake-gh.ts';
import { gitCheckout } from '../helpers/fake-git.ts';
import { runInProcess, scratchDir } from '../helpers/harness.ts';
import { BASE_OID, checkRun, HEAD, isQ1, q1Pr, q1Reply } from '../unit/pr/snapshot-fixture.ts';
import { notFoundJson, okJson } from './ci-why-world.ts';
import { install, NOW, PR_RUN, REF, SLUG } from './pr-status-world.ts';

const CONFIG = ConfigSchema.parse({
  version: 1,
  components: { app: { paths: ['src/**'], minRisk: 'low' }, docs: { paths: ['docs/**'] } },
});
const INPUT = PrCreateInput.parse({
  ...createExample(CONFIG),
  title: 'feat(app): show a retry banner',
  description: 'Requests show a retry banner after a failure.',
  risk: 'low',
  components: ['app'],
  base: 'main',
  head: 'feature',
});
const BODY = renderPrBody(toPrBlock(INPUT, { id: 'p_3k9m2q' }), renderOptions(CONFIG));
const pr = (over: Record<string, unknown> = {}) => ({
  number: 3301,
  title: INPUT.title,
  body: BODY,
  state: 'open',
  updated_at: '2026-10-21T16:30:40Z',
  changed_files: 1,
  head: { sha: HEAD, ref: 'feature' },
  base: { sha: BASE_OID, ref: 'main' },
  ...over,
});
const pathOf = (argv: string[]) =>
  argv
    .find((arg) => arg.startsWith('repos/') || arg.startsWith('https://api.github.com/repos/'))
    ?.replace('https://api.github.com/', '')
    .split('?')[0];
const at = (suffix: string) => (argv: string[]) => pathOf(argv) === `repos/${SLUG}${suffix}`;
const contents = (config: unknown) =>
  okJson({ encoding: 'base64', content: Buffer.from(JSON.stringify(config)).toString('base64') });

function setup(over: Record<string, unknown> = {}) {
  return new FakeGh()
    .on(at('/contents/.github/ghx.json'), contents(CONFIG))
    .on(at('/pulls/3301'), okJson(pr(over)))
    .on(at('/pulls/3301/files'), okJson([{ filename: 'src/app.ts' }]));
}
const run = (args: string[], fake: FakeGh, env: Record<string, string> = {}) =>
  runInProcess(args, {
    gh: fake,
    clock: new FakeClock(NOW),
    env: { GHX_ARTIFACT_DIR: mkdtempSync(join(scratchDir(), 'impact-')), ...env },
  });

test('impact derives facts for a merged, unstructured PR and accepts renamed paths', async () => {
  const fake = setup({ body: 'No block', state: 'closed', merged: true });
  fake.on(at('/pulls/3301/files'), okJson([{ filename: 'docs/app.md', previous_filename: 'src/app.ts' }]));
  const r = await run(['pr', 'impact', REF], fake);
  assert.equal(r.exitCode, 0, r.stdout);
  assert.deepEqual(r.json.components, ['app', 'docs']);
  assert.equal(r.json.riskFloor, 'low');
  fake.expectNoMutations();
});

test('impact paginates beyond 300 files and never underestimates an incomplete list', async () => {
  const fake = setup({ changed_files: 301 });
  const first = Array.from({ length: 300 }, (_, n) => ({ filename: `docs/${n}.md` }));
  const next = `https://api.github.com/repos/${SLUG}/pulls/3301/files?page=2`;
  fake.on(at('/pulls/3301/files'), [
    {
      exitCode: 0,
      stderr: '',
      stdout: `HTTP/2.0 200 OK\r\nLink: <${next}>; rel="next"\r\n\r\n${JSON.stringify(first)}`,
    },
    okJson([{ filename: 'src/app.ts' }]),
  ]);
  const r = await run(['pr', 'impact', REF], fake);
  assert.equal(r.exitCode, 0, r.stdout);
  assert.deepEqual(r.json.components, ['docs', 'app']);
  assert.equal(r.json.riskFloor, 'low');
  const broken = await run(['pr', 'impact', REF], setup({ changed_files: 301 }));
  assert.notEqual(broken.exitCode, 0);
  assert.equal(broken.json.error.code, 'GH_OUTPUT_UNEXPECTED');
});

test('impact preserves argument order and isolates unavailable PRs', async () => {
  const fake = setup();
  fake.on(at('/pulls/3302'), okJson(pr({ number: 3302, changed_files: 2 })));
  fake.on(at('/pulls/3302/files'), okJson([{ filename: 'src/app.ts' }]));
  const r = await run(['pr', 'impact', REF, `${SLUG}#3302`], fake);
  assert.equal(r.exitCode, 7, r.stdout);
  assert.equal(r.json.results[0].ref, REF);
  assert.equal(r.json.results[1].error.code, 'GH_OUTPUT_UNEXPECTED');
});

test('impact retries once when the head changes, then fails closed if it keeps moving', async () => {
  const fake = setup();
  const moved = 'a'.repeat(40);
  fake.on(at('/pulls/3301'), [
    okJson(pr()),
    okJson(pr({ head: { sha: moved, ref: 'feature' } })),
    okJson(pr({ head: { sha: moved, ref: 'feature' } })),
  ]);
  const r = await run(['pr', 'impact', REF], fake);
  assert.equal(r.exitCode, 0, r.stdout);
  assert.equal(r.json.headSha, moved);
  fake.on(at('/pulls/3301'), [
    okJson(pr()),
    okJson(pr({ head: { sha: moved, ref: 'feature' } })),
    okJson(pr()),
    okJson(pr({ head: { sha: moved, ref: 'feature' } })),
  ]);
  const unstable = await run(['pr', 'impact', REF], fake);
  assert.equal(unstable.json.error.code, 'HEAD_MOVED');
});

test('check uses pinned base config despite a local working copy and GITHUB_TOKEN alone', async () => {
  const fake = setup();
  const root = mkdtempSync(join(scratchDir(), 'policy-checkout-'));
  mkdirSync(join(root, '.github'));
  writeFileSync(
    join(root, '.github/ghx.json'),
    JSON.stringify({ version: 1, components: { app: {} }, title: { types: ['never'] } }),
  );
  const r = await runInProcess(['pr', 'check', REF], {
    gh: fake,
    git: gitCheckout(SLUG, { toplevel: root }),
    cwd: root,
    env: { GITHUB_TOKEN: 'test-token' },
  });
  assert.equal(r.exitCode, 0, r.stdout);
  assert.equal(r.json.valid, true);
  assert.equal(r.json.config.ref, BASE_OID);
  const call = fake.calls.find((item) => at('/contents/.github/ghx.json')(item.argv));
  assert.ok(
    call?.argv.some((arg) => arg.includes(`ref=${BASE_OID}`)),
    JSON.stringify(call),
  );
  assert.equal(call?.env.GITHUB_TOKEN, 'test-token');
  assert.ok(!fake.calls.some((item) => item.argv[0] === 'auth'));
  fake.expectNoMutations();
});

test('check aggregates required-data, component, risk, and visible-title drift issues', async () => {
  const fake = setup({ title: 'UI edited title' });
  fake.on(
    at('/contents/.github/ghx.json'),
    contents({
      ...CONFIG,
      components: { app: CONFIG.components.app, security: { paths: ['src/**'], minRisk: 'high' } },
      data: { fields: { ticket: { type: 'string', required: true } } },
    }),
  );
  const r = await run(['pr', 'check', REF], fake);
  assert.equal(r.exitCode, 2, r.stdout);
  const codes = r.json.issues.map((issue: { code: string }) => issue.code);
  for (const code of [
    'data.required',
    'components.undeclared_touched',
    'risk.below_component_floor',
    'block.drift.title',
  ])
    assert.ok(codes.includes(code), JSON.stringify(codes));
  fake.expectNoMutations();
});

test('check rejects missing blocks and refuses incomplete file lists', async () => {
  const r = await run(['pr', 'check', REF], setup({ body: 'Opened in the GitHub UI' }));
  assert.equal(r.exitCode, 2, r.stdout);
  assert.equal(r.json.issues[0].code, 'block.missing');
  const incomplete = await run(['pr', 'check', REF], setup({ changed_files: 2 }));
  assert.equal(incomplete.json.error.code, 'GH_OUTPUT_UNEXPECTED');
});

test('check cannot bootstrap policy from a PR when the target config is missing', async () => {
  const fake = setup().on(at('/contents/.github/ghx.json'), notFoundJson());
  const r = await run(['pr', 'check', REF], fake);
  assert.equal(r.json.error.code, 'CONFIG_MISSING', r.stdout);
});

test('check preserves refs.fixes PR-only meaning and validates referenced records', async () => {
  const body = renderPrBody(
    toPrBlock({ ...INPUT, refs: { fixes: ['#4'], related: ['#5'] } }, { id: 'p_3k9m2q' }),
    renderOptions(CONFIG),
  );
  const fake = setup({ body });
  fake.on(at('/issues/4'), okJson({ number: 4 }));
  fake.on(at('/issues/5'), notFoundJson());
  const r = await run(['pr', 'check', REF], fake);
  assert.equal(r.exitCode, 2, r.stdout);
  assert.ok(
    r.json.issues.some(
      (issue: { path: string; code: string }) => issue.path === 'refs.fixes[0]' && issue.code === 'refs.not_pr',
    ),
    r.stdout,
  );
  assert.ok(
    r.json.issues.some(
      (issue: { path: string; code: string }) => issue.path === 'refs.related[0]' && issue.code === 'refs.not_found',
    ),
    r.stdout,
  );
});

function policyFake(contexts: unknown[], over: Record<string, unknown> = {}) {
  const fake = install(undefined, {
    config: CONFIG,
    pr: q1Pr(
      { title: INPUT.title, body: BODY, mergeStateStatus: 'BLOCKED', headRefName: 'feature', ...over },
      { contexts },
    ),
  });
  fake.on(at('/pulls/3301'), okJson(pr()));
  fake.on(at('/pulls/3301/files'), okJson([{ filename: 'src/app.ts' }]));
  // Read-only CI identity differs from the PR author.
  fake.on(
    isQ1,
    q1Reply(
      q1Pr(
        { title: INPUT.title, body: BODY, mergeStateStatus: 'BLOCKED', headRefName: 'feature', ...over },
        { contexts },
      ),
      { viewerPermission: 'READ' },
    ),
  );
  return fake;
}

test('merge-policy excludes an exact running self-check but keeps repository gate exclusions explicit', async () => {
  const fake = policyFake([
    { ...checkRun('ghx policy', null, { id: 101 }), isRequired: true },
    checkRun('tests', 'SUCCESS', { id: 102 }),
  ]);
  const r = await run(['pr', 'check', REF, '--merge-policy', '--self-check', '101'], fake, {
    GITHUB_RUN_ID: String(PR_RUN),
  });
  assert.equal(r.exitCode, 0, r.stdout);
  assert.equal(r.json.mergePolicy.allowed, true);
  assert.deepEqual(
    r.json.excludedChecks.map((x: { code: string }) => x.code),
    ['AUTHOR_NOT_VIEWER', 'NO_MERGE_PERMISSION', 'CI_SELF_CHECK', 'BLOCKED_BY_PROTECTION'],
  );
  fake.expectNoMutations();
});

test('merge-policy never excludes other pending/red checks or required approvals', async () => {
  for (const [context, over, expected] of [
    [checkRun('tests', null, { id: 102 }), {}, 'CI_PENDING'],
    [checkRun('tests', 'FAILURE', { id: 102 }), {}, 'CI_RED'],
    [checkRun('tests', 'SUCCESS', { id: 102 }), { reviewDecision: 'REVIEW_REQUIRED' }, 'REVIEW_REQUIRED'],
    [checkRun('tests', 'SUCCESS', { id: 102 }), { reviewDecision: 'CHANGES_REQUESTED' }, 'CHANGES_REQUESTED'],
    [checkRun('tests', 'SUCCESS', { id: 102 }), { mergeStateStatus: 'UNKNOWN' }, 'MERGEABLE_UNKNOWN'],
  ] as const) {
    const fake = policyFake([checkRun('ghx policy', null, { id: 101 }), context], over);
    const r = await run(['pr', 'check', REF, '--merge-policy', '--self-check', '101'], fake, {
      GITHUB_RUN_ID: String(PR_RUN),
    });
    assert.equal(r.exitCode, 6, r.stdout);
    assert.ok(
      r.json.mergePolicy.blockers.some((blocker: { code: string }) => blocker.code === expected),
      r.stdout,
    );
  }
});

test('unknown, wrong-run, completed and context-free self-check exclusions fail closed', async () => {
  const fake = policyFake([checkRun('ghx policy', null, { id: 101 }), checkRun('tests', 'SUCCESS', { id: 102 })]);
  for (const [id, env] of [
    [999, { GITHUB_RUN_ID: String(PR_RUN) }],
    [102, { GITHUB_RUN_ID: String(PR_RUN) }],
    [101, { GITHUB_RUN_ID: '1' }],
    [101, {}],
  ] as const) {
    const r = await run(['pr', 'check', REF, '--merge-policy', '--self-check', String(id)], fake, env);
    assert.equal(r.json.error.code, 'VALIDATION', r.stdout);
  }
  const withoutSelf = await run(['pr', 'check', REF, '--merge-policy'], policyFake([checkRun('tests', 'SUCCESS')]));
  assert.ok(
    withoutSelf.json.mergePolicy.blockers.some((blocker: { code: string }) => blocker.code === 'BLOCKED_BY_PROTECTION'),
  );
});

test('merge-policy fails closed when required-check sources cannot be read', async () => {
  const fake = policyFake([checkRun('tests', 'SUCCESS')], { mergeStateStatus: 'CLEAN' });
  fake.on(at('/rules/branches/main'), notFoundJson());
  const r = await run(['pr', 'check', REF, '--merge-policy'], fake);
  assert.equal(r.exitCode, 6, r.stdout);
  assert.ok(
    r.json.mergePolicy.blockers.some((blocker: { code: string }) => blocker.code === 'POLICY_FACTS_UNAVAILABLE'),
    r.stdout,
  );
});

test('self-check exclusion identifies only the supplied check and discloses caller responsibility', async () => {
  // A run id establishes run membership, not which sibling job invoked ghx.
  const fake = policyFake([checkRun('ghx policy', 'SUCCESS', { id: 101 }), checkRun('sibling', null, { id: 102 })]);
  const r = await run(['pr', 'check', REF, '--merge-policy', '--self-check', '102'], fake, {
    GITHUB_RUN_ID: String(PR_RUN),
  });
  assert.equal(r.exitCode, 0, r.stdout);
  const exclusion = r.json.excludedChecks.find((entry: { code: string }) => entry.code === 'CI_SELF_CHECK');
  assert.equal(exclusion.checkId, 102);
  assert.match(exclusion.reason, /Supplied running check sibling/);
  assert.match(exclusion.reason, /caller is responsible for identifying its own gate/);
  assert.match(exclusion.reason, new RegExp(HEAD));
  fake.expectNoMutations();
});

test('merge-policy fails closed on truncated required-check rule pages', async () => {
  const fake = policyFake([checkRun('tests', 'SUCCESS')], { mergeStateStatus: 'CLEAN' });
  const next = `https://api.github.com/repos/${SLUG}/rules/branches/main?page=2`;
  fake.on(at('/rules/branches/main'), {
    exitCode: 0,
    stderr: '',
    stdout: `HTTP/2.0 200 OK\r\nLink: <${next}>; rel="next"\r\n\r\n[]`,
  });
  const r = await run(['pr', 'check', REF, '--merge-policy'], fake);
  assert.equal(r.exitCode, 6, r.stdout);
  assert.ok(
    r.json.mergePolicy.blockers.some(
      (blocker: { code: string; message: string }) =>
        blocker.code === 'POLICY_FACTS_UNAVAILABLE' && /truncated/.test(blocker.message),
    ),
    r.stdout,
  );
  assert.ok(
    r.json.warnings.some((warning: { code: string }) => warning.code === 'CI_DETAIL_UNAVAILABLE'),
    r.stdout,
  );
  fake.expectNoMutations();
});
