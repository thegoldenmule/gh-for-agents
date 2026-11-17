import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigSchema } from '../../src/config/schema.ts';
import { readPrBlock } from '../../src/meta/schemas.ts';
import { prMetaOf } from '../../src/pr/status/output.ts';
import { readBody, renderOptions, renderTrailer } from '../../src/render/pr-body.ts';
import { runInProcess } from '../helpers/harness.ts';
import { BASE_OID, CONFIG, HEAD_OID, INPUT, ok, scene } from './pr-create-scene.ts';
import { editScene } from './pr-edit-scene.ts';

const ticketConfig = { ...CONFIG, title: { format: 'ticket', ticket: { pattern: '^ENG-\\d+$', example: 'ENG-123' } } };
const ticketInput = { ...INPUT, title: 'ENG-123: repair retry ordering' };
const blockOf = (body: unknown) => {
  const block = readPrBlock(String(body));
  assert.equal(block.status, 'ok');
  if (block.status !== 'ok') throw new Error('missing block');
  return block.block;
};

test('ticket titles round-trip through create and edit, with UI title drift detectable', async () => {
  const created = scene({ config: ticketConfig });
  const result = await runInProcess(['pr', 'create', '-R', 'octo/demo', '--input', '-'], {
    gh: created.gh,
    stdin: JSON.stringify(ticketInput),
  });
  assert.equal(result.exitCode, 0, result.stdout);
  assert.equal(created.posted[0]?.title, ticketInput.title);
  const block = blockOf(created.posted[0]?.body);
  assert.equal(block.title, ticketInput.title);
  const opts = renderOptions(ConfigSchema.parse(ticketConfig));
  assert.deepEqual(readBody(String(created.posted[0]?.body), block, opts, 'ENG-999: changed in UI').drift, ['title']);

  const edited = editScene({
    config: ticketConfig,
    pr: { title: ticketInput.title, body: String(created.posted[0]?.body) },
  });
  const edit = await runInProcess(['pr', 'edit', 'octo/demo#12', '--input', '-'], {
    gh: edited.gh,
    stdin: JSON.stringify({ title: 'ENG-124: improve retry ordering' }),
  });
  assert.equal(edit.exitCode, 0, edit.stdout);
  assert.equal(blockOf(edited.patched[0]?.body).title, 'ENG-124: improve retry ordering');
});

test('ticket convention applies to batch inputs and adoption without a block', async () => {
  const s = scene({ config: ticketConfig });
  const batch = await runInProcess(['pr', 'create', '--batch', '-R', 'octo/demo', '--input', '-'], {
    gh: s.gh,
    stdin: JSON.stringify({
      items: [ticketInput, { ...ticketInput, title: 'ENG-124: repair another retry', head: 'feat/other' }],
    }),
  });
  assert.equal(batch.exitCode, 0, batch.stdout);
  assert.deepEqual(
    s.posted.map((p) => p.title),
    [ticketInput.title, 'ENG-124: repair another retry'],
  );

  const adoption = editScene({
    config: ticketConfig,
    pr: { title: ticketInput.title, body: 'A PR opened in the UI.' },
  });
  const { head: _head, ...patch } = ticketInput;
  const adopted = await runInProcess(['pr', 'edit', 'octo/demo#12', '--input', '-'], {
    gh: adoption.gh,
    stdin: JSON.stringify({ ...patch, adopt: true }),
  });
  assert.equal(adopted.exitCode, 0, adopted.stdout);
  assert.equal(blockOf(adoption.patched[0]?.body).title, ticketInput.title);
});

test('fixes is PR-only, persisted in metadata, and rendered without closing keywords', async () => {
  const s = scene({ refTypes: { r1: 'PullRequest' } });
  const input = { ...INPUT, refs: { fixes: ['#7', 'other/repo#8'], closes: ['#9'] } };
  const r = await runInProcess(['pr', 'create', '-R', 'octo/demo', '--input', '-'], {
    gh: s.gh,
    stdin: JSON.stringify(input),
  });
  assert.equal(r.exitCode, 0, r.stdout);
  const block = blockOf(s.posted[0]?.body);
  assert.deepEqual(prMetaOf(block).refs.fixes, input.refs.fixes);
  const trailer = renderTrailer(block);
  assert.match(trailer, /Repairs defects from #7, other\/repo#8/);
  assert.match(trailer, /Closes #9/);
  assert.doesNotMatch(trailer, /(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?) (?:#7|other\/repo#8)/i);
});

test('fixes pointing at an issue or missing ref reports its indexed path before any write', async () => {
  for (const options of [{ refTypes: { r0: 'Issue' as const } }, { missingAliases: ['r0'] }]) {
    const s = scene(options);
    const r = await runInProcess(['pr', 'create', '-R', 'octo/demo', '--input', '-'], {
      gh: s.gh,
      stdin: JSON.stringify({ ...INPUT, refs: { fixes: ['#7'] } }),
    });
    assert.equal(r.exitCode, 2, r.stdout);
    assert.equal(r.json.error.details.issues[0].path, 'refs.fixes[0]');
    assert.equal(s.posted.length, 0);
  }
});

test('edit replaces fixes arrays and leaves omitted legacy trailers unchanged', async () => {
  const s = editScene({ refTypes: { r0: 'PullRequest' } });
  const r = await runInProcess(['pr', 'edit', 'octo/demo#12', '--input', '-'], {
    gh: s.gh,
    stdin: JSON.stringify({ refs: { fixes: ['#7'] } }),
  });
  assert.equal(r.exitCode, 0, r.stdout);
  assert.deepEqual(blockOf(s.patched[0]?.body).refs?.fixes, ['#7']);
  const old = { risk: 'low', components: ['app'], revertPolicy: 'revert-safe', testing: [] };
  assert.equal(renderTrailer(old), renderTrailer({ ...old, refs: { fixes: [] } }));
});

test('fixes cannot pass when a partial ref alias omits or malforms its object type', async () => {
  for (const refNode of [{}, { __typename: null }, { __typename: 7 }]) {
    const s = scene();
    s.gh.on(
      (argv) => argv.some((arg) => arg.includes('issueOrPullRequest')),
      ok({
        data: {
          viewer: { login: 'octocat' },
          repository: {
            nameWithOwner: 'octo/demo',
            viewerPermission: 'WRITE',
            defaultBranchRef: { name: 'main' },
            baseRef: { target: { oid: BASE_OID } },
            headRef: { target: { oid: HEAD_OID } },
            headPrs: { nodes: [] },
            parentPrs: { nodes: [] },
            r0: refNode,
          },
        },
      }),
    );
    const r = await runInProcess(['pr', 'create', '-R', 'octo/demo', '--input', '-'], {
      gh: s.gh,
      stdin: JSON.stringify({ ...INPUT, refs: { fixes: ['#7'] } }),
    });
    assert.equal(r.exitCode, 2, r.stdout);
    assert.ok(
      r.json.error.details.issues.some(
        (issue: { path: string; code: string }) => issue.path === 'refs.fixes[0]' && issue.code === 'refs.type_unknown',
      ),
      r.stdout,
    );
    assert.equal(s.posted.length, 0);
    s.gh.expectNoMutations();
  }
});
