// ghx pr status <pr> <pr>… (02 §4.4): several selectors give {results}, one entry per selector in argument
// order; a selector that fails is an error entry, and the exit code follows pr create --batch.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { byteLength } from '../../src/core/output.ts';
import { PrStatusErrorEntry, PrStatusOutput } from '../../src/pr/status/schema.ts';
import { EXIT } from '../contract/exit-table.ts';
import type { FakeGh } from '../helpers/fake-gh.ts';
import { isQ1, q1Reply } from '../unit/pr/snapshot-fixture.ts';
import { install, REF, run, SLUG, workedPr } from './pr-status-world.ts';

const REF2 = `${SLUG}#3302`;
const page = (nodes: unknown[]) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });

/** Q1 for PR `n` only (later rules win over install()'s catch-all Q1). */
const isQ1For = (n: number) => (argv: string[]) => isQ1(argv) && argv.includes(`number=${n}`);

function second(fake: FakeGh, pr: unknown = workedPr({ number: 3302, url: `https://github.com/${SLUG}/pull/3302` })) {
  fake.on(isQ1For(3302), q1Reply(pr));
  return fake;
}

test('two selectors: {results} in argument order, each entry a whole PrStatusOutput', async () => {
  const r = await run(['pr', 'status', REF2, REF], second(install()));
  assert.equal(r.exitCode, EXIT.OK, r.stdout.slice(0, 500));
  assert.deepEqual(Object.keys(r.json), ['results']);
  assert.deepEqual(
    r.json.results.map((e: { ref: string }) => e.ref),
    [REF2, REF],
  );
  for (const e of r.json.results) PrStatusOutput.parse(e);
  assert.equal(r.json.results[0].number, 3302);
  assert.ok(byteLength(r.stdout) <= 16_384, `${byteLength(r.stdout)} bytes`);
});

test('one selector failing is an error entry; the others are read and the exit is 7', async () => {
  const fake = install();
  fake.on(isQ1For(3302), q1Reply(null));
  const r = await run(['pr', 'status', REF, REF2], fake);
  assert.equal(r.exitCode, EXIT.GH_FAILED, r.stdout.slice(0, 500));
  const [ok, failed] = r.json.results;
  assert.equal(ok.ref, REF);
  assert.equal(typeof ok.merge.ready, 'boolean');
  PrStatusErrorEntry.parse(failed);
  assert.equal(failed.selector, REF2);
  assert.equal(failed.ref, REF2);
  assert.equal(failed.error.code, 'PR_NOT_FOUND');
  assert.deepEqual(Object.keys(failed.error).sort(), ['code', 'details', 'hint', 'message']);
});

test('every selector failing keeps {results}; the exit is the first error’s own (5 for PR_NOT_FOUND)', async () => {
  const fake = install();
  fake.on(isQ1, q1Reply(null));
  const r = await run(['pr', 'status', REF, REF2], fake);
  assert.equal(r.exitCode, EXIT.NOT_FOUND, r.stdout.slice(0, 500));
  assert.deepEqual(
    r.json.results.map((e: { error: { code: string } }) => e.error.code),
    ['PR_NOT_FOUND', 'PR_NOT_FOUND'],
  );
});

test('a bad selector among good ones is USAGE_BAD_SELECTOR before anything is fetched', async () => {
  const fake = install();
  const r = await run(['pr', 'status', REF, 'https://github.com/o/r/actions/runs/1'], fake);
  assert.equal(r.exitCode, EXIT.USAGE);
  assert.equal(r.json.error.code, 'USAGE_BAD_SELECTOR');
  assert.equal(fake.calls.length, 0);
});

test('more than 10 selectors is a usage error', async () => {
  const fake = install();
  const r = await run(['pr', 'status', ...Array.from({ length: 11 }, (_, i) => `${SLUG}#${3301 + i}`)], fake);
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  assert.equal(fake.calls.length, 0);
});

test('several large PRs share the 16 KB budget instead of spilling', async () => {
  const comments = (n: number) =>
    Array.from({ length: 40 }, (_, i) => ({
      databaseId: n * 100 + i,
      author: { __typename: 'User', login: 'maria-dev' },
      authorAssociation: 'MEMBER',
      body: `${i} ${'word '.repeat(150)}`,
      createdAt: new Date(Date.UTC(2026, 9, 21, 10, i)).toISOString(),
      lastEditedAt: null,
      url: `https://github.com/${SLUG}/pull/${n}#issuecomment-${n * 100 + i}`,
    }));
  const fake = install(undefined, { pr: workedPr({ comments: page(comments(3301)) }) });
  second(fake, workedPr({ number: 3302, url: `https://github.com/${SLUG}/pull/3302`, comments: page(comments(3302)) }));
  const r = await run(['pr', 'status', REF, REF2], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout.slice(0, 500));
  assert.equal(r.json.spilled, undefined, 'not spilled');
  assert.ok(byteLength(r.stdout) <= 16_384, `${byteLength(r.stdout)} bytes`);
  for (const e of r.json.results) {
    assert.ok(e.feedback.counts.omitted > 0);
    assert.ok(e.warnings.some((w: { code: string }) => w.code === 'FEEDBACK_OMITTED'));
    assert.deepEqual(e.openFindings, ['f_n2c6rv'], 'open findings are never dropped');
  }
});

/** PR `n` of the worked example with `count` issue comments of `chars` characters each. */
function talkative(fake: FakeGh, n: number, count: number, chars: number) {
  const comments = Array.from({ length: count }, (_, i) => ({
    databaseId: n * 100 + i,
    author: { __typename: 'User', login: 'maria-dev' },
    authorAssociation: 'MEMBER',
    body: `${n}-${i} ${'x'.repeat(chars)}`,
    createdAt: new Date(Date.UTC(2026, 9, 21, 10, i)).toISOString(),
    lastEditedAt: null,
    url: `https://github.com/${SLUG}/pull/${n}#issuecomment-${n * 100 + i}`,
  }));
  fake.on(
    isQ1For(n),
    q1Reply(workedPr({ number: n, url: `https://github.com/${SLUG}/pull/${n}`, comments: page(comments) })),
  );
  return comments.map((c) => c.body);
}

const FIVE = [3301, 3302, 3303, 3304, 3305];

test('--fields: the budget is measured on the projection, so selected bodies that fit are kept whole', async () => {
  const fake = install();
  const bodies = FIVE.map((n) => talkative(fake, n, 6, 300));
  const argv = ['pr', 'status', ...FIVE.map((n) => `${SLUG}#${n}`)];
  // Without --fields the five PRs do not fit 16 KB: comment bodies are emptied, and the rest spills.
  const whole = await run(argv, fake);
  assert.equal(whole.exitCode, EXIT.OK, whole.stdout.slice(0, 500));
  assert.equal(whole.json.spilled, true);
  const spilled = JSON.parse(readFileSync(whole.json.path, 'utf8'));
  assert.ok(spilled.results.every((e: { feedback: { counts: { omitted: number } } }) => e.feedback.counts.omitted > 0));

  const r = await run([...argv, '--fields', 'feedback.comments[].body,feedback.counts.omitted'], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout.slice(0, 500));
  assert.equal(r.json.spilled, undefined, 'not spilled');
  assert.ok(byteLength(r.stdout) <= 16_384, `${byteLength(r.stdout)} bytes`);
  r.json.results.forEach(
    (
      e: { feedback: { comments: { body: string }[]; counts: { omitted: number } }; warnings: { code: string }[] },
      i: number,
    ) => {
      for (const b of bodies[i] ?? [])
        assert.ok(
          e.feedback.comments.some((c) => c.body === b),
          `${FIVE[i]}: a body was cut`,
        );
      assert.equal(e.feedback.counts.omitted, 0);
      assert.ok(!e.warnings.some((w) => w.code === 'FEEDBACK_OMITTED'));
    },
  );
});

test('--brief: content it does not select is never cut, and no FEEDBACK_OMITTED is raised for it', async () => {
  const fake = install();
  for (const n of FIVE) talkative(fake, n, 6, 300);
  const r = await run(['pr', 'status', ...FIVE.map((n) => `${SLUG}#${n}`), '--brief'], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout.slice(0, 500));
  for (const e of r.json.results) {
    assert.equal(e.feedback.counts.omitted, 0, 'feedback.counts is the fold’s');
    assert.ok(!e.warnings.some((w: { code: string }) => w.code === 'FEEDBACK_OMITTED'));
  }
});
