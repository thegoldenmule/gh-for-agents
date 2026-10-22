// ghx pr status <pr> (02 §4; 03 M6.5), in-process over the worked-example world (pr-status-world.ts).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { byteLength } from '../../src/core/output.ts';
import { PrStatusOutput } from '../../src/pr/status/schema.ts';
import { EXIT } from '../contract/exit-table.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { FakeGh } from '../helpers/fake-gh.ts';
import { isMergeable, isQ1, mergeableReply, q1Reply } from '../unit/pr/snapshot-fixture.ts';
import { install, NOW, REF, run, workedPr } from './pr-status-world.ts';

const GOLDEN = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'golden', 'pr-status-3301.json'), 'utf8'),
) as Record<string, unknown>;

const page = (nodes: unknown[]) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });

/** Run while advancing the fake clock, for the mergeable retry's sleeps. */
async function runTimed(argv: string[], fake: FakeGh, clock: FakeClock) {
  let done = false;
  const p = run(argv, fake, { clock }).finally(() => {
    done = true;
  });
  await clock.runUntil(() => done, { stepMs: 500, maxMs: 60_000 });
  return { ...(await p), clock };
}

test('02 §14.5: the worked example matches the golden document field by field', async () => {
  const fake = install();
  const r = await run(['pr', 'status', REF], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  PrStatusOutput.parse(r.json);
  for (const key of Object.keys(GOLDEN)) {
    if (key === 'fetchedAt') assert.equal(Date.parse(r.json[key]), Date.parse(GOLDEN[key] as string));
    else assert.deepEqual(r.json[key], GOLDEN[key], key);
  }
  assert.deepEqual(Object.keys(r.json).sort(), Object.keys(GOLDEN).sort());
  fake.expectNoMutations();
  fake.expectNoCall({ prefix: ['run', 'view'] });
  const paths = fake.calls.flatMap((c) => c.argv.filter((a) => a.startsWith('repos/')));
  assert.ok(!paths.some((p) => /\/(rules|branches)\//.test(p)), `a quiet read makes no expected-set call: ${paths}`);
});

test('unstructured items are kept with structured:false and bots are separated (brief 7)', async () => {
  const r = await run(['pr', 'status', REF], install());
  const human = r.json.feedback.comments.find((c: { id: string }) => c.id === 'ic:2412345678');
  assert.equal(human.structured, false);
  assert.equal(human.author.login, 'maria-dev');
  assert.deepEqual(
    r.json.feedback.bots.map((b: { author: string; marker: string }) => [b.author, b.marker]),
    [['github-actions[bot]', 'ci-duration-watch']],
  );
  assert.ok(!r.json.feedback.comments.some((c: { author: { isBot: boolean } }) => c.author.isBot));
});

test('no .github/ghx.json: warning CONFIG_MISSING plus the CONFIG_MISSING blocker, ready false', async () => {
  const r = await run(['pr', 'status', REF], install(undefined, { config: null }));
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.ok(r.json.warnings.some((w: { code: string }) => w.code === 'CONFIG_MISSING'));
  assert.equal(r.json.merge.ready, false);
  assert.deepEqual(
    r.json.merge.blockers.map((b: { code: string }) => b.code),
    ['CONFIG_MISSING'],
  );
});

test('--no-compare-main leaves sameOnMain null, so the red check blocks as CI_RED', async () => {
  const fake = install();
  const r = await run(['pr', 'status', REF, '--no-compare-main'], fake);
  assert.equal(r.json.ci.failing[0].sameOnMain, null);
  assert.equal(r.json.merge.ready, false);
  assert.ok(r.json.merge.blockers.some((b: { code: string }) => b.code === 'CI_RED'));
  assert.ok(!fake.calls.some((c) => c.argv.some((a) => a.includes('/actions/'))), 'no Actions call');
});

test('R03: UNKNOWN mergeable is retried within its bound and settles', async () => {
  const clock = new FakeClock(NOW);
  const fake = install(new FakeGh({ clock }), { pr: workedPr({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }) });
  fake.on(isMergeable, [
    mergeableReply('UNKNOWN'),
    mergeableReply('UNKNOWN'),
    mergeableReply('MERGEABLE', { mergeState: 'UNSTABLE' }),
  ]);
  const r = await runTimed(['pr', 'status', REF, '--no-compare-main'], fake, clock);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual([r.json.merge.mergeable, r.json.merge.settled], ['MERGEABLE', true]);
  const asked = fake.calls.filter((c) => isQ1(c.argv) || isMergeable(c.argv)).map((c) => c.at);
  assert.deepEqual(asked, [0, 1000, 3000, 6000]);
});

test('R03: still UNKNOWN after 20 s gives settled:false, a warning and the MERGEABLE_UNKNOWN blocker', async () => {
  const clock = new FakeClock(NOW);
  const fake = install(new FakeGh({ clock }), { pr: workedPr({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }) });
  fake.on(isMergeable, mergeableReply('UNKNOWN'));
  const r = await runTimed(['pr', 'status', REF, '--no-compare-main'], fake, clock);
  assert.deepEqual([r.json.merge.mergeable, r.json.merge.settled, r.json.merge.ready], ['UNKNOWN', false, false]);
  assert.ok(fake.calls.filter((c) => isMergeable(c.argv)).every((c) => c.at <= 20_000));
  assert.ok(r.json.warnings.some((w: { code: string }) => w.code === 'MERGEABLE_UNKNOWN'));
  assert.ok(r.json.merge.blockers.some((b: { code: string }) => b.code === 'MERGEABLE_UNKNOWN'));
});

test('--no-wait-mergeable reads mergeable once', async () => {
  const fake = install(undefined, { pr: workedPr({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }) });
  const r = await run(['pr', 'status', REF, '--no-wait-mergeable', '--no-compare-main'], fake);
  assert.equal(r.json.merge.settled, false);
  assert.equal(fake.calls.filter((c) => isMergeable(c.argv)).length, 0);
});

test('R09: an automatic retarget shows in stack.baseChanges and as a BASE_CHANGED merge warning', async () => {
  const timelineItems = page([
    {
      __typename: 'AutomaticBaseChangeSucceededEvent',
      createdAt: '2026-10-22T08:00:00Z',
      oldBase: 'feat/mr-08c',
      newBase: 'main',
    },
  ]);
  const r = await run(['pr', 'status', REF], install(undefined, { pr: workedPr({ timelineItems }) }));
  assert.deepEqual(r.json.stack.baseChanges, [
    { from: 'feat/mr-08c', to: 'main', at: '2026-10-22T08:00:00Z', automatic: true },
  ]);
  const w = r.json.merge.warnings.find((x: { code: string }) => x.code === 'BASE_CHANGED');
  assert.match(w.message, /automatic retarget/);
});

test('truncation: caps each item, then drops the oldest comment bodies to stay under 16 KB, counting omitted', async () => {
  const comments = Array.from({ length: 15 }, (_, i) => ({
    databaseId: 9000 + i,
    author: { __typename: 'User', login: 'maria-dev' },
    authorAssociation: 'MEMBER',
    body: `${i} ${'word '.repeat(400)}`,
    createdAt: new Date(Date.UTC(2026, 9, 21, 10, i)).toISOString(),
    lastEditedAt: null,
    url: `https://github.com/powerhouse-inc/powerhouse/pull/3301#issuecomment-${9000 + i}`,
  }));
  const r = await run(['pr', 'status', REF], install(undefined, { pr: workedPr({ comments: page(comments) }) }));
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.spilled, undefined, 'not spilled');
  assert.ok(byteLength(r.stdout) <= 16_384, `${byteLength(r.stdout)} bytes`);
  const fb = r.json.feedback;
  assert.ok(fb.counts.omitted > 0);
  assert.equal(fb.comments.length, 16, 'items are never dropped, only bodies');
  const bodies = fb.comments.filter((c: { id: string }) => c.id.startsWith('ic:9'));
  assert.ok(bodies.every((c: { body: string; truncated: boolean }) => [...c.body].length <= 500 && c.truncated));
  const emptied = bodies.findIndex((c: { body: string }) => c.body !== '');
  assert.ok(emptied > 0 && bodies.slice(emptied).every((c: { body: string }) => c.body !== ''), 'oldest first');
  const f = fb.findings.find((x: { id: string }) => x.id === 'f_h4x8pz');
  assert.equal(f.body, '', 'the resolved finding body goes first');
  const hint = r.json.warnings.find((w: { code: string }) => w.code === 'FEEDBACK_OMITTED');
  assert.match(hint.message, /ghx pr feedback powerhouse-inc\/powerhouse#3301/);
  assert.match(hint.message, new RegExp(`^${fb.counts.omitted} `));
});

test('an invalid PR block gives meta null, metaError and structured:false', async () => {
  const body = 'Plain prose.\n\n<!-- ghx:v2 {"t":"pr","id":"p_aaaaaa"} -->';
  const r = await run(['pr', 'status', REF], install(undefined, { pr: workedPr({ body }) }));
  assert.equal(r.json.meta, null);
  assert.equal(r.json.metaError.code, 'SCHEMA_NEWER');
  assert.deepEqual(r.json.description, { text: 'Plain prose.', structured: false, drift: [] });
});

test('a body edited in the UI reports description drift', async () => {
  const pr = workedPr();
  const body = (pr.body as string).replace('The primary write path', 'The main write path');
  const r = await run(['pr', 'status', REF], install(undefined, { pr: { ...pr, body } }));
  assert.deepEqual(r.json.description.drift, ['description']);
});

test('a run URL is not a PR selector', async () => {
  const r = await run(['pr', 'status', 'https://github.com/o/r/actions/runs/1'], new FakeGh());
  assert.equal(r.exitCode, EXIT.USAGE);
  assert.equal(r.json.error.code, 'USAGE_BAD_SELECTOR');
});

test('a missing PR with an explicit repo is PR_NOT_FOUND without the cwd hint', async () => {
  const fake = install();
  fake.on(isQ1, q1Reply(null));
  const r = await run(['pr', 'status', REF], fake);
  assert.equal(r.exitCode, EXIT.NOT_FOUND);
  assert.equal(r.json.error.code, 'PR_NOT_FOUND');
});

test('the smoke scenario (test/fixtures/gh/smoke/pr-status) replays the worked example', async () => {
  const r = await run(
    ['pr', 'status', '3301', '-R', 'powerhouse-inc/powerhouse'],
    FakeGh.fromScenario('smoke/pr-status'),
  );
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.merge.ready, true);
  assert.equal(r.json.ci.failing[0].sameOnMain.verdict, 'same-tests');
});
