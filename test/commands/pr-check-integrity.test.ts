import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigSchema } from '../../src/config/schema.ts';
import { encode } from '../../src/meta/codec.ts';
import { createExample } from '../../src/pr/create/example.ts';
import { PrCreateInput } from '../../src/pr/create/schema.ts';
import { renderOptions, renderPrBody, toPrBlock } from '../../src/render/pr-body.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { FakeGh } from '../helpers/fake-gh.ts';
import { runInProcess } from '../helpers/harness.ts';
import { BASE_OID, HEAD } from '../unit/pr/snapshot-fixture.ts';
import { notFoundJson, okJson } from './ci-why-world.ts';
import { NOW, REF, SLUG } from './pr-status-world.ts';

const CONFIG = ConfigSchema.parse({ version: 1, components: { app: { paths: ['src/**'] } } });
const INPUT = PrCreateInput.parse({
  ...createExample(CONFIG),
  title: 'feat(app): add retries',
  components: ['app'],
  base: 'main',
  head: 'feature',
});
const block = toPrBlock(INPUT, { id: 'p_aaaaaa' });
const rendered = (metadata = block) => renderPrBody(metadata, renderOptions(CONFIG));
const at = (suffix: string) => (argv: string[]) => argv.some((arg) => arg.split('?')[0] === `repos/${SLUG}${suffix}`);

function setup(o: { body?: string; base?: string; defaultBranch?: string; parent?: Record<string, unknown> } = {}) {
  return new FakeGh()
    .on(
      at('/pulls/3301'),
      okJson({
        number: 3301,
        title: INPUT.title,
        body: o.body ?? rendered(),
        state: 'open',
        updated_at: '2026-11-17T10:00:00Z',
        changed_files: 1,
        head: { sha: HEAD, ref: 'feature' },
        base: { sha: BASE_OID, ref: o.base ?? 'main' },
      }),
    )
    .on(at('/pulls/3301/files'), okJson([{ filename: 'src/app.ts' }]))
    .on(
      at('/contents/.github/ghx.json'),
      okJson({ encoding: 'base64', content: Buffer.from(JSON.stringify(CONFIG)).toString('base64') }),
    )
    .on(at(''), okJson({ default_branch: o.defaultBranch ?? 'main' }))
    .on(
      at('/issues/12'),
      okJson({ number: 12, pull_request: { url: `https://api.github.com/repos/${SLUG}/pulls/12` } }),
    )
    .on(
      at('/pulls/12'),
      okJson(o.parent ?? { state: 'open', head: { ref: 'parent-feature', sha: BASE_OID, repo: { full_name: SLUG } } }),
    );
}

const run = (fake: FakeGh) => runInProcess(['pr', 'check', REF], { gh: fake, clock: new FakeClock(NOW) });

test('CI rejects duplicate, invalid additional, and unexpected ghx metadata blocks', async () => {
  const additions = [
    { extra: encode({ ...block, id: 'p_bbbbbb' }), code: 'block.duplicate' },
    { extra: '<!-- ghx:v1 {broken json} -->', code: 'block.invalid' },
    { extra: encode({ ...block, id: 'p_bbbbbb' }, 2), code: 'block.invalid' },
    { extra: encode({ t: 'comment', id: 'c_bbbbbb', gen: 'ghx/0.2.0', kind: 'note' }), code: 'block.unexpected' },
  ];
  for (const { extra, code } of additions) {
    const fake = setup({ body: `${rendered()}\n${extra}` });
    const r = await run(fake);
    assert.equal(r.exitCode, 2, r.stdout);
    assert.equal(r.json.valid, false);
    assert.ok(
      r.json.issues.some((issue: { code: string }) => issue.code === code),
      r.stdout,
    );
    fake.expectNoMutations();
  }
});

test('CI checks default-base and stack topology independently of local branches', async () => {
  const body = rendered({ ...block, refs: { stackedOn: '#12' } });
  const invalidDefault = setup({
    body,
    parent: { state: 'open', head: { ref: 'main', sha: BASE_OID, repo: { full_name: SLUG } } },
  });
  const rejected = await run(invalidDefault);
  assert.equal(rejected.exitCode, 2, rejected.stdout);
  assert.ok(rejected.json.issues.some((issue: { code: string }) => issue.code === 'refs.stacked_on_default_base'));
  const valid = setup({ body, base: 'parent-feature' });
  const accepted = await run(valid);
  assert.equal(accepted.exitCode, 0, accepted.stdout);
  assert.equal(accepted.json.valid, true);
  valid.expectNoMutations();
  assert.ok(
    valid.calls.some((call) => call.argv.some((arg) => arg.includes(`ref=${BASE_OID}`))),
    'config remains bound to the target SHA',
  );
});

test('CI rejects an unrelated, closed, forked, moved, missing, or foreign declared parent', async () => {
  const body = rendered({ ...block, refs: { stackedOn: '#12' } });
  const correctHead = { ref: 'parent-feature', sha: BASE_OID, repo: { full_name: SLUG } };
  for (const parent of [
    { state: 'open', head: { ...correctHead, ref: 'other' } },
    { state: 'closed', head: correctHead },
    { state: 'open', head: { ...correctHead, repo: { full_name: 'someone/fork' } } },
    { state: 'open', head: { ...correctHead, repo: null } },
    { state: 'open', head: { ...correctHead, sha: 'c'.repeat(40) } },
  ]) {
    const fake = setup({ body, base: 'parent-feature', parent });
    const r = await run(fake);
    assert.equal(r.exitCode, 2, r.stdout);
    assert.ok(
      r.json.issues.some((issue: { code: string }) => issue.code === 'refs.stack_mismatch'),
      r.stdout,
    );
    fake.expectNoMutations();
  }
  const missing = setup({ body, base: 'parent-feature' }).on(at('/pulls/12'), notFoundJson());
  const absent = await run(missing);
  assert.equal(absent.exitCode, 2, absent.stdout);
  assert.ok(absent.json.issues.some((issue: { code: string }) => issue.code === 'refs.stack_mismatch'));
  const foreign = setup({
    body: rendered({ ...block, refs: { stackedOn: 'other/repo#12' } }),
    base: 'parent-feature',
  }).on(
    (argv) => argv.some((arg) => arg === 'repos/other/repo/issues/12'),
    okJson({ number: 12, pull_request: { url: 'https://api.github.com/repos/other/repo/pulls/12' } }),
  );
  const crossRepo = await run(foreign);
  assert.equal(crossRepo.exitCode, 2, crossRepo.stdout);
  assert.ok(crossRepo.json.issues.some((issue: { code: string }) => issue.code === 'refs.stack_mismatch'));
});

test('CI aggregates stack issues with metadata validation and missing external references', async () => {
  const body = rendered({ ...block, title: 'invalid title', refs: { stackedOn: '#12', related: ['#99'] } });
  const fake = setup({ body }).on(at('/issues/99'), notFoundJson());
  const r = await run(fake);
  assert.equal(r.exitCode, 2, r.stdout);
  const codes = r.json.issues.map((issue: { code: string }) => issue.code);
  assert.ok(codes.includes('title.format'), r.stdout);
  assert.ok(codes.includes('refs.not_found'), r.stdout);
  assert.ok(codes.includes('refs.stacked_on_default_base'), r.stdout);
  assert.ok(codes.includes('refs.stack_mismatch'), r.stdout);
});
