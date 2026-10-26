// PR body rendering (02 §2.2, §14.2; 03 §5.1 golden files). Each case is a PrCreateInput in
// test/fixtures/render/<case>.input.json and its exact body in <case>.body.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { z } from 'zod';
import { ConfigSchema } from '../../../src/config/schema.ts';
import { DEFAULT_FOOTER } from '../../../src/config/sections/render.ts';
import { isGhxError } from '../../../src/core/errors.ts';
import { decode, MAX_BODY_CHARS, strip } from '../../../src/meta/codec.ts';
import { readPrBlock } from '../../../src/meta/schemas.ts';
import { createRules } from '../../../src/pr/create/rules.ts';
import { PrCreateInput } from '../../../src/pr/create/schema.ts';
import {
  type PrBlockData,
  parsePrBody,
  prBodyDrift,
  type RenderOptions,
  renderHowToTest,
  renderPrBody,
  renderTrailer,
  testSummary,
  toPrBlock,
} from '../../../src/render/pr-body.ts';
import { Gen, PrBlockId } from '../../../src/schemas/common.ts';
import { VERSION } from '../../../src/version.ts';

const FIX = join(import.meta.dirname, '../../fixtures/render');
const META = { id: 'p_k3m9qa', gen: 'ghx/0.1.0' };
const TRAILER: RenderOptions = { mode: 'trailer', footer: DEFAULT_FOOTER };

/** The 02 §14 repo's components, plus the extra ones the goldens use. */
const config = ConfigSchema.parse({
  version: 1,
  components: Object.fromEntries(
    ['reactor', 'reactor-api', 'shared', 'connect', 'switchboard', 'codegen', 'vetra', 'docs', 'ci'].map((c) => [
      c,
      {},
    ]),
  ),
});

const CASES: { input: string; body: string; render: RenderOptions }[] = [
  { input: 'worked-example-3301.input.json', body: 'worked-example-3301.body.md', render: TRAILER },
  { input: 'stacked-draft.input.json', body: 'stacked-draft.body.md', render: TRAILER },
  { input: 'closes-multiple.input.json', body: 'closes-multiple.body.md', render: TRAILER },
  { input: 'tests-mixed.input.json', body: 'tests-mixed.body.md', render: TRAILER },
  {
    input: 'details-mode.input.json',
    body: 'details-mode.body.md',
    render: { mode: 'details', footer: DEFAULT_FOOTER },
  },
  { input: 'footer-null.input.json', body: 'footer-null.body.md', render: { mode: 'trailer', footer: null } },
  { input: 'unicode-title.input.json', body: 'unicode-title.body.md', render: TRAILER },
];

const readInput = (f: string) => PrCreateInput.parse(JSON.parse(readFileSync(join(FIX, f), 'utf8')));
const readBody = (f: string) => readFileSync(join(FIX, f), 'utf8');

/** A strict v1 `pr` block schema for the round trip; M6.1's PrBlock (src/meta/schemas.ts) must agree. */
const PrBlockForTest = PrCreateInput.omit({ base: true, head: true, draft: true }).extend({
  t: z.literal('pr'),
  id: PrBlockId,
  gen: Gen,
  rev: z.number().int().min(1),
});

describe('golden bodies', () => {
  for (const c of CASES) {
    test(c.body, () => {
      const input = readInput(c.input);
      assert.deepEqual(createRules(input, { config }), [], 'the golden input is valid');
      const block = toPrBlock(input, META);
      const body = renderPrBody(block, c.render);
      assert.equal(body, readBody(c.body));

      // The block round-trips through the codec, and the visible text is everything before it.
      const d = decode<PrBlockData>(body, { 1: PrBlockForTest });
      assert.equal(d.status, 'ok');
      if (d.status === 'ok') assert.deepEqual(d.data, block);
      assert.equal(strip(body), body.slice(0, body.lastIndexOf('\n\n<!-- ghx:v1 ')));
      assert.ok(body.length <= MAX_BODY_CHARS);
    });
  }
});

test('the worked example matches 02 §14.2: the visible text exactly, the block as sorted-key data', () => {
  const body = readBody('worked-example-3301.body.md');
  const doc = readFileSync(join(import.meta.dirname, '../../../docs/plans/02-api.md'), 'utf8');
  const section = doc.split('### 14.2 Rendered body (#3301)')[1]?.split('```markdown\n')[1]?.split('\n```')[0];
  assert.ok(section, '02 §14.2 found');
  const cut = (s: string) => s.lastIndexOf('\n\n<!-- ghx:v1 ');
  assert.equal(body.slice(0, cut(body)), section.slice(0, cut(section)));
  const json = (s: string) => JSON.parse(/<!-- ghx:v1 (\{.*\}) -->$/.exec(s)?.[1] ?? 'null');
  assert.deepEqual(json(body), json(section));
});

describe('toPrBlock', () => {
  test('keeps content fields, drops base/head/draft, omits absent optionals', () => {
    const input = readInput('stacked-draft.input.json');
    const block = toPrBlock(input, META);
    assert.deepEqual(Object.keys(block).sort(), [
      'components',
      'description',
      'gen',
      'id',
      'refs',
      'rev',
      'revertPolicy',
      'revertWith',
      'risk',
      't',
      'testing',
      'title',
    ]);
    assert.equal(block.rev, 1);
  });

  test('defaults gen to this build and takes rev', () => {
    const block = toPrBlock(readInput('footer-null.input.json'), { id: 'p_k3m9qa', rev: 3 });
    assert.equal(block.gen, `ghx/${VERSION}`);
    assert.equal(block.rev, 3);
    assert.ok(PrBlockForTest.safeParse(block).success);
  });

  test('carries riskNote and revertNote', () => {
    const block = toPrBlock(readInput('details-mode.input.json'), META);
    assert.equal(block.revertNote, 'Re-run codegen in every model package after reverting.');
    assert.equal(toPrBlock(readInput('tests-mixed.input.json'), META).riskNote?.startsWith('A batch'), true);
  });
});

describe('strict block', () => {
  test('an empty revertWith is dropped, so the strict PrBlock accepts the block', () => {
    const input = { ...readInput('footer-null.input.json'), revertWith: [] };
    const block = toPrBlock(input, META);
    assert.ok(!('revertWith' in block));
    assert.ok(renderPrBody(block, TRAILER).includes('<!-- ghx:v1 '));
  });

  test('a block the strict PrBlock rejects is a ghx bug (INTERNAL), not a body', () => {
    const block = toPrBlock(readInput('footer-null.input.json'), META);
    assert.throws(
      () => renderPrBody({ ...block, testing: [] }, TRAILER),
      (e: unknown) => isGhxError(e, 'INTERNAL'),
    );
  });
});

describe('trailer', () => {
  const block = (p: Partial<PrBlockData>) => ({ ...toPrBlock(readInput('footer-null.input.json'), META), ...p });

  test('test summary: pass count, then other results in fixed order, then distinct kinds', () => {
    assert.equal(
      testSummary([
        { kind: 'unit', command: 'a', result: 'not-run', notes: 'n' },
        { kind: 'unit', command: 'b', result: 'pass' },
        { kind: 'lint', command: 'c', result: 'fail', notes: 'n' },
        { kind: 'e2e', command: 'd', result: 'skipped', notes: 'n' },
        { kind: 'e2e', command: 'e', result: 'fail', notes: 'n' },
      ]),
      '1/5 pass, 2 fail, 1 skipped, 1 not-run (unit, lint, e2e)',
    );
  });

  test('refs: stacked, split, closes each get a keyword; related/supersedes/reverts stay in the block', () => {
    assert.equal(
      renderTrailer(
        block({
          refs: { stackedOn: 'o/r#1', splitFrom: '#2', closes: ['#3', '#4'], related: ['#5'], supersedes: ['#6'] },
        }),
      ),
      'Risk: trivial · Components: docs · Revert: revert-safe · Tests: 1/1 pass (build) · Stacked on o/r#1 · Split from #2 · Closes #3, closes #4',
    );
    assert.equal(
      renderTrailer(block({ refs: { closes: [] } })),
      'Risk: trivial · Components: docs · Revert: revert-safe · Tests: 1/1 pass (build)',
    );
  });

  test('the trailer is one line and there are no sections or test logs', () => {
    for (const c of CASES.filter((x) => x.render.mode === 'trailer')) {
      const visible = strip(readBody(c.body));
      assert.doesNotMatch(visible, /^#/m);
      assert.doesNotMatch(visible, /<details/);
      assert.equal(visible.split('\n').filter((l) => l.startsWith('Risk: ')).length, 1);
    }
  });
});

describe('details mode', () => {
  test('How to test lists command, cwd, result, notes and manual steps', () => {
    assert.equal(
      renderHowToTest([
        { kind: 'unit', command: 'pnpm test', cwd: 'packages/x', result: 'pass' },
        { kind: 'manual', steps: ['Open it', 'Click'], result: 'fail', notes: 'button stays grey' },
        { kind: 'lint', command: 'echo `x`', result: 'pass' },
      ]),
      [
        '<details><summary>How to test</summary>',
        '',
        '- unit: `pnpm test` in `packages/x` (pass)',
        '- manual (fail) — button stays grey',
        '  1. Open it',
        '  2. Click',
        '- lint: `` echo `x` `` (pass)',
        '',
        '</details>',
      ].join('\n'),
    );
  });
});

describe('size', () => {
  /** A block whose body is exactly `chars` long: the description appears twice, the footer once. */
  function bodyOf(chars: number): string {
    const base = toPrBlock(readInput('footer-null.input.json'), META);
    // The description appears twice (visible and in the block), so one char of it costs two.
    const probe = renderPrBody({ ...base, description: 'a' }, { mode: 'trailer', footer: 'f' });
    const fixed = probe.length - 2;
    const desc = Math.floor((chars - fixed) / 2);
    const footer = 'f'.repeat(1 + (chars - fixed - 2 * desc));
    return renderPrBody({ ...base, description: 'a'.repeat(desc) }, { mode: 'trailer', footer });
  }

  test('65,536 chars renders; 65,537 is META_TOO_LARGE', () => {
    assert.equal(bodyOf(MAX_BODY_CHARS).length, MAX_BODY_CHARS);
    assert.throws(
      () => bodyOf(MAX_BODY_CHARS + 1),
      (e: unknown) => {
        assert.ok(isGhxError(e, 'META_TOO_LARGE'));
        assert.deepEqual(e.details, { chars: MAX_BODY_CHARS + 1, max: MAX_BODY_CHARS });
        return true;
      },
    );
  });
});

test('the render config defaults to trailer mode with the Claude Code footer', () => {
  assert.deepEqual(
    { mode: config.render.mode, footer: config.render.footer },
    { mode: 'trailer', footer: '🤖 Generated with [Claude Code](https://claude.com/claude-code)' },
  );
  assert.ok(!ConfigSchema.safeParse({ version: 1, components: { x: {} }, render: { mode: 'sections' } }).success);
  assert.ok(!ConfigSchema.safeParse({ version: 1, components: { x: {} }, render: { footer: 'a <!-- b -->' } }).success);
  assert.equal(ConfigSchema.parse({ version: 1, components: { x: {} }, render: { footer: null } }).render.footer, null);
});

describe('parsePrBody', () => {
  for (const c of CASES) {
    test(`round-trips ${c.body}`, () => {
      const block = toPrBlock(readInput(c.input), META);
      const body = renderPrBody(block, c.render);
      const p = parsePrBody(body, { footer: c.render.footer });
      assert.equal(p.description, block.description);
      assert.equal(p.trailer, renderTrailer(block));
      assert.equal(p.howToTest, c.render.mode === 'details' ? renderHowToTest(block.testing) : null);
      assert.equal(p.footer, c.render.footer);
      assert.equal(p.blocks.length, 1);
      assert.deepEqual(p.blocks[0]?.status === 'ok' ? p.blocks[0].block : null, block);
      // Without the footer hint the trailer still anchors the split.
      assert.deepEqual(parsePrBody(body), p);
      assert.deepEqual(prBodyDrift(body, block, c.render), []);
      assert.deepEqual(prBodyDrift(body, block, c.render, block.title), []);
      // The lenient block a reader gets (readPrBlock) works too.
      const read = readPrBlock(body);
      assert.equal(read.status, 'ok');
      if (read.status === 'ok') assert.deepEqual(prBodyDrift(body, read.block, c.render), []);
    });
  }

  test('CRLF from a UI edit is normalised, so an unchanged body has no drift', () => {
    const block = toPrBlock(readInput('tests-mixed.input.json'), META);
    const body = renderPrBody(block, TRAILER).replace(/\n/g, '\r\n');
    assert.equal(parsePrBody(body).description, block.description);
    assert.deepEqual(prBodyDrift(body, block, TRAILER), []);
  });

  test('drift: an edited description, an edited trailer and a changed title', () => {
    const block = toPrBlock(readInput('worked-example-3301.input.json'), META);
    const body = renderPrBody(block, TRAILER);
    const edited = body.replace(block.description, 'Rewritten in the GitHub UI.');
    assert.equal(parsePrBody(edited).description, 'Rewritten in the GitHub UI.');
    assert.deepEqual(prBodyDrift(edited, block, TRAILER), ['description']);
    const trailer = body.replace('Risk: ', 'Risk:  ');
    assert.deepEqual(prBodyDrift(trailer, block, TRAILER), ['trailer']);
    assert.deepEqual(prBodyDrift(body, block, TRAILER, 'fix: other'), ['title']);
  });

  test('a body with no trailer: the visible text minus a known footer is the description', () => {
    const p = parsePrBody(`Hand-written.\n\nSecond paragraph.\n\n${DEFAULT_FOOTER}`, { footer: DEFAULT_FOOTER });
    assert.deepEqual(
      { d: p.description, t: p.trailer, h: p.howToTest, f: p.footer, b: p.blocks },
      { d: 'Hand-written.\n\nSecond paragraph.', t: null, h: null, f: DEFAULT_FOOTER, b: [] },
    );
    assert.equal(parsePrBody('').description, '');
    assert.equal(parsePrBody('').footer, null);
  });
});

describe('alsoTouched (06)', () => {
  const input = readInput('footer-null.input.json');

  test('toPrBlock keeps a non-empty alsoTouched and omits an empty one', () => {
    assert.deepEqual(toPrBlock(input, { ...META, alsoTouched: ['ci', 'vetra'] }).alsoTouched, ['ci', 'vetra']);
    assert.ok(!('alsoTouched' in toPrBlock(input, { ...META, alsoTouched: [] })));
    assert.ok(!('alsoTouched' in toPrBlock(input, META)));
  });

  test('the strict PrBlock rejects an empty alsoTouched', () => {
    const block = toPrBlock(input, META);
    assert.throws(
      () => renderPrBody({ ...block, alsoTouched: [] }, TRAILER),
      (e: unknown) => isGhxError(e, 'INTERNAL'),
    );
  });

  test('the trailer shows the count after the declared components; the names stay in the block', () => {
    const block = toPrBlock(input, { ...META, alsoTouched: ['ci', 'vetra'] });
    assert.equal(
      renderTrailer(block),
      'Risk: trivial · Components: docs (+2 more) · Revert: revert-safe · Tests: 1/1 pass (build)',
    );
    const body = renderPrBody(block, TRAILER);
    const parsed = parsePrBody(body, { footer: DEFAULT_FOOTER });
    assert.equal(parsed.trailer, renderTrailer(block));
    const read = readPrBlock(body);
    assert.equal(read.status, 'ok');
    if (read.status === 'ok') {
      assert.deepEqual(read.block.alsoTouched, ['ci', 'vetra']);
      assert.deepEqual(prBodyDrift(body, read.block, TRAILER, block.title), []);
    }
  });
});
