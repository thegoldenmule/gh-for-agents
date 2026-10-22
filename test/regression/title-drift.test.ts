// R11 (03 §5.2). Guards the title that changed on retry (gh-usage-findings §4.1): a shell-built title
// lost its text to interpolation. The POST body's title and body are byte-identical to the input and
// the render, travel as JSON on stdin (--input -) and never in argv, and a read-back that differs is
// READBACK_MISMATCH (exit 7), never a success.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INPUT, scene, sequence } from '../commands/pr-create-scene.ts';
import { EXIT } from '../contract/exit-table.ts';
import { runInProcess } from '../helpers/harness.ts';

const TRICKY = {
  ...INPUT,
  title: 'fix(reactor): order by createdAt, id',
  components: ['reactor'],
  description: 'Sort by `createdAt` then id; "$2" and \\ stay literal.\nNo shell ever sees this text.',
};
const ARGV = ['pr', 'create', '-R', 'octo/demo', '--input', '-'];
const REACTOR = ['packages/reactor/src/order.ts'];

test('R11: title and body reach GitHub byte-identical, on stdin only', async () => {
  const s = scene({ files: REACTOR });
  const r = await runInProcess(ARGV, { gh: s.gh, stdin: JSON.stringify(TRICKY) });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const post = s.gh.calls.find((c) => c.argv.includes('POST'));
  assert.ok(post?.stdin);
  const sent = JSON.parse(post.stdin);
  assert.equal(sent.title, TRICKY.title);
  assert.ok(String(sent.body).startsWith(`${TRICKY.description}\n\n`));
  assert.equal(r.json.body, sent.body, 'the rendered body is exactly what was sent');
  for (const c of s.gh.calls) {
    for (const a of c.argv) {
      assert.ok(!a.includes('createdAt'), `argv carries PR text: ${a}`);
      assert.ok(!a.includes('$2'), `argv carries PR text: ${a}`);
    }
  }
});

test('R11: a read-back with a different title is READBACK_MISMATCH, exit 7, with sent and stored', async () => {
  const stored = 'fix(reactor): order by createdAt, id (#101)';
  const s = scene({ files: REACTOR, readback: { title: stored } });
  const r = await runInProcess(ARGV, { gh: s.gh, stdin: JSON.stringify(TRICKY) });
  assert.equal(r.exitCode, EXIT.GH_FAILED, r.stdout);
  assert.equal(r.json.error.code, 'READBACK_MISMATCH');
  assert.equal(r.json.error.details.field, 'title');
  assert.equal(r.json.error.details.sent, TRICKY.title);
  assert.equal(r.json.error.details.stored, stored);
  assert.equal(r.json.error.details.ref, 'octo/demo#101');
  assert.match(r.json.error.hint, /ghx pr edit octo\/demo#101/);
  assert.deepEqual(sequence(s.gh), ['config', 'preflight', 'compare', 'post', 'readback']);
});

test('R11: a read-back with a different body is READBACK_MISMATCH too', async () => {
  const s = scene({ files: REACTOR, readback: { body: 'rewritten by an app' } });
  const r = await runInProcess(ARGV, { gh: s.gh, stdin: JSON.stringify(TRICKY) });
  assert.equal(r.exitCode, EXIT.GH_FAILED, r.stdout);
  assert.equal(r.json.error.code, 'READBACK_MISMATCH');
  assert.equal(r.json.error.details.field, 'body');
  assert.equal(r.json.error.details.stored, 'rewritten by an app');
});
