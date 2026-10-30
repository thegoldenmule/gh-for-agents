// createRules (02 §2.1): one pass and one fail case at each rule's boundary (03 §5.1).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ConfigSchema, type GhxConfigInput } from '../../../../src/config/schema.ts';
import { ComponentMinRisk } from '../../../../src/config/sections/components.ts';
import { isGhxError } from '../../../../src/core/errors.ts';
import {
  assertNoIssues,
  type CreateRuleContext,
  compoundOperators,
  createRules,
  machinePaths,
  stripFooter,
  validationError,
} from '../../../../src/pr/create/rules.ts';
import { PrCreateInput, PrEditInput } from '../../../../src/pr/create/schema.ts';
import { RISK_ORDER } from '../../../../src/schemas/pr.ts';
import { assertExportable } from '../../schemas/_exportable.ts';

function ctxWith(over: Partial<GhxConfigInput> = {}, defaultBranch?: string): CreateRuleContext {
  const config = ConfigSchema.parse({
    version: 1,
    components: {
      reactor: { paths: ['packages/reactor/**'] },
      shared: { paths: ['packages/shared/**'] },
      x: {},
      auth: { minRisk: 'medium' },
      release: { minRisk: 'high' },
    },
    ...over,
  });
  return { config, defaultBranch };
}

const CTX = ctxWith();

function base(): PrCreateInput {
  return {
    title: 'fix(reactor): bind documentId when signing',
    description: 'Signatures now bind the document id.\nVerify rejects unbound candidates.',
    testing: [{ kind: 'unit', command: 'pnpm test', result: 'pass' }],
    risk: 'low',
    components: ['reactor'],
    revertPolicy: 'revert-safe',
    base: 'main',
    head: 'fix/bind',
  };
}

type Patch = Partial<Record<keyof PrCreateInput, unknown>>;
const make = (p: Patch): PrCreateInput => ({ ...base(), ...p }) as PrCreateInput;
const codes = (p: Patch, ctx = CTX) => createRules(make(p), ctx).map((i) => i.code);

function pass(p: Patch, ctx = CTX) {
  const issues = createRules(make(p), ctx);
  assert.deepEqual(issues, [], `expected no issues for ${JSON.stringify(p)}`);
}
/** Fails with exactly this one code (one defect, one issue). */
function failOnly(p: Patch, code: string, ctx = CTX) {
  assert.deepEqual(codes(p, ctx), [code], `for ${JSON.stringify(p)}`);
}

test('the base input is valid', () => {
  pass({});
});

describe('title', () => {
  test('title.format', () => {
    pass({ title: 'feat(reactor)!: x' });
    pass({ title: 'chore: x' });
    for (const t of ['Feat(reactor): x', 'feat(reactor) x', 'feat(): x', 'feat(Reactor): x', 'feat(reactor):x', '']) {
      failOnly({ title: t }, 'title.format');
    }
  });

  test('title.format uses the configured types', () => {
    const ctx = ctxWith({ title: { types: ['feat', 'wip'] } });
    pass({ title: 'wip(reactor): x' }, ctx);
    failOnly({ title: 'fix(reactor): x' }, 'title.format', ctx);
  });

  test('title.too_long counts code points (an emoji is 1)', () => {
    const prefix = 'fix(reactor): 🤖';
    const at = (n: number) => prefix + 'a'.repeat(n - [...prefix].length);
    assert.equal([...at(72)].length, 72);
    assert.ok(at(72).length > 72, 'the emoji is 2 UTF-16 units');
    pass({ title: at(72) });
    failOnly({ title: at(73) }, 'title.too_long');
  });

  test('title.scope_missing', () => {
    const required = ctxWith({ title: { scopeRequired: true } });
    pass({ title: 'fix(reactor): x' }, required);
    pass({ title: 'fix: x' });
    failOnly({ title: 'fix: x' }, 'title.scope_missing', required);
  });

  test('title.multi_scope (not title.format)', () => {
    failOnly({ title: 'feat(codegen,vetra): x' }, 'title.multi_scope');
    failOnly({ title: 'feat(reactor, shared): x' }, 'title.multi_scope');
    failOnly({ title: 'feat(reactor,Shared): x' }, 'title.format');
  });

  test('title.scope_not_component / scope_not_declared', () => {
    pass({ title: 'fix(shared): x', components: ['reactor', 'shared'] });
    const notComponent = createRules(make({ title: 'fix(reactr): x' }), CTX);
    assert.deepEqual(
      notComponent.map((i) => i.code),
      ['title.scope_not_component'],
    );
    assert.equal(notComponent[0]?.suggestion, 'reactor');
    failOnly({ title: 'fix(shared): x' }, 'title.scope_not_declared');
  });

  test('title.pr_suffix', () => {
    pass({ title: 'fix(reactor): handle #12 edge' });
    failOnly({ title: 'fix(reactor): y (#2894)' }, 'title.pr_suffix');
  });

  test('title.whitespace and title.trailing_period', () => {
    pass({ title: 'fix(reactor): a b' });
    failOnly({ title: ' fix(reactor): a' }, 'title.whitespace');
    failOnly({ title: 'fix(reactor): a  b' }, 'title.whitespace');
    failOnly({ title: 'fix(reactor): a ' }, 'title.whitespace');
    failOnly({ title: 'fix(reactor):\ta' }, 'title.whitespace');
    failOnly({ title: 'fix(reactor): a.' }, 'title.trailing_period');
  });

  test('title.revert_needs_ref', () => {
    pass({ title: 'revert(reactor): y', refs: { reverts: '#3184' } });
    failOnly({ title: 'revert(reactor): y' }, 'title.revert_needs_ref');
  });
});

describe('description', () => {
  test('description.lines: 1–3 lines, no blank lines', () => {
    pass({ description: 'One.' });
    pass({ description: 'One.\nTwo.\nThree.' });
    failOnly({ description: 'One.\nTwo.\nThree.\nFour.' }, 'description.lines');
    failOnly({ description: 'One.\n\nTwo.' }, 'description.lines');
    failOnly({ description: 'One.\r\n\r\nTwo.' }, 'description.lines');
    failOnly({ description: 'One.\n' }, 'description.lines');
    failOnly({ description: '' }, 'description.lines');
  });

  test('description.too_long: 500 vs 501 chars, and the configured cap', () => {
    pass({ description: 'a'.repeat(500) });
    failOnly({ description: 'a'.repeat(501) }, 'description.too_long');
    const ctx = ctxWith({ render: { descriptionMaxChars: 100 } });
    pass({ description: 'a'.repeat(100) }, ctx);
    failOnly({ description: 'a'.repeat(101) }, 'description.too_long', ctx);
  });

  test('description.markdown_structure', () => {
    for (const d of [
      '#3184 merged first, so the order changed.',
      '-1 is the sentinel.',
      'Uses a|b matching and x > y.',
      'Fix the `- a` parser.',
      '1.5x faster.',
    ]) {
      pass({ description: d });
    }
    for (const d of [
      '# H',
      '## H',
      '- a',
      '* a',
      '+ a',
      '1. a',
      '2) a',
      '> a',
      '| a | b |',
      '```ts',
      '~~~',
      '<details><summary>x</summary>',
      'See <!-- note -->',
      'Title\n===',
      '  - indented',
      'a | b\n--- | ---',
    ]) {
      failOnly({ description: d }, 'description.markdown_structure');
    }
  });

  test('description.markdown_structure is one issue naming every offending line', () => {
    const got = createRules(make({ description: '- a\n- b' }), CTX);
    assert.equal(got.length, 1);
    assert.match(got[0]?.message ?? '', /^lines 1, 2 have Markdown structure \(a list marker\)/);
  });

  test('description.footer', () => {
    pass({ description: 'Mentions ghx as a tool.' });
    failOnly({ description: 'Done. 🤖 Generated with Claude Code' }, 'description.footer');
    pass({ description: 'See ghx: v1 for details.' });
    pass({ description: 'The ghx: prefix names the tool.' });
    const custom = ctxWith({ render: { footer: 'Made by the bot squad' } });
    failOnly({ description: 'Fixed. Made by the bot squad' }, 'description.footer', custom);
    pass({ description: 'Fixed. Made by the bot squad' }, ctxWith({ render: { footer: null } }));
    assert.deepEqual(codes({ description: 'x <!-- ghx:v1 {} -->' }), [
      'description.markdown_structure',
      'description.footer',
    ]);
  });
});

describe('stripFooter', () => {
  const strip = (d: string, c = CTX.config) => stripFooter(d, c);
  const PROSE = 'Retries now show a banner.';

  test('the harness footer, its blank lines and a --- above it are removed, with FOOTER_STRIPPED', () => {
    for (const tail of [
      '\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)',
      '\n\n🤖 Generated with [Claude Code](https://claude.ai/code)\n',
      '\nGenerated with [Claude Code](https://claude.com/claude-code)',
      '\n\nGenerated with Claude Code',
      '\n\n---\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n',
      '\r\n\r\n***\r\n🤖\uFE0F Generated with [Claude Code](https://claude.com/claude-code)',
    ]) {
      const r = strip(`${PROSE}${tail}`);
      assert.equal(r.description, PROSE, JSON.stringify(tail));
      assert.equal(r.warning?.code, 'FOOTER_STRIPPED');
      assert.match(r.warning?.message ?? '', /Generated with/);
      pass({ description: r.description });
    }
  });

  test("the repo's own render.footer is stripped too; a description without a footer is untouched", () => {
    const own = ctxWith({ render: { footer: 'Made by the bot squad' } }).config;
    assert.equal(strip(`${PROSE}\n\nMade by the bot squad`, own).description, PROSE);
    const plain = strip(`${PROSE}\n`);
    assert.deepEqual(plain, { description: `${PROSE}\n`, warning: null }, 'other defects are left to the rules');
  });

  test('only the tail is touched: a footer inside the prose or before a Co-Authored-By line still fails', () => {
    const inline = 'Done. 🤖 Generated with Claude Code';
    assert.deepEqual(strip(inline), { description: inline, warning: null });
    const trailer = `${PROSE}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nCo-Authored-By: Claude <noreply@anthropic.com>`;
    assert.equal(strip(trailer).warning, null);
    assert.ok(codes({ description: trailer }).includes('description.footer'));
    assert.equal(strip('Generated with care by hand.').warning, null);
  });
});

describe('testing', () => {
  const unit = (o: Record<string, unknown> = {}) => ({ kind: 'unit', command: 'pnpm test', result: 'pass', ...o });

  test('testing.min_pass, and create.requirePassingTest: false', () => {
    pass({ testing: [unit(), unit({ result: 'not-run', notes: 'no db' })] });
    const allNotRun = { testing: [unit({ result: 'not-run', notes: 'no db' })] };
    failOnly(allNotRun, 'testing.min_pass');
    pass(allNotRun, ctxWith({ create: { requirePassingTest: false } }));
  });

  test('testing.command_required / steps_required', () => {
    pass({ testing: [unit()] });
    pass({ testing: [unit(), { kind: 'manual', steps: ['Open the app'], result: 'pass' }] });
    failOnly({ testing: [{ kind: 'unit', result: 'pass' }] }, 'testing.command_required');
    failOnly({ testing: [unit(), { kind: 'manual', result: 'pass' }] }, 'testing.steps_required');
    failOnly({ testing: [unit(), { kind: 'manual', steps: [], result: 'pass' }] }, 'testing.steps_required');
  });

  test('steps and testing counts are structural (zod) at 0/6 and 0/11', () => {
    const step = (n: number) => Array.from({ length: n }, (_, i) => `Step ${i + 1}`);
    const manual = (n: number) => ({ ...base(), testing: [{ kind: 'manual', steps: step(n), result: 'pass' }] });
    assert.ok(PrCreateInput.safeParse(manual(1)).success);
    assert.ok(PrCreateInput.safeParse(manual(5)).success);
    assert.ok(!PrCreateInput.safeParse(manual(0)).success);
    assert.ok(!PrCreateInput.safeParse(manual(6)).success);
    const items = (n: number) => ({ ...base(), testing: Array.from({ length: n }, () => unit()) });
    assert.ok(PrCreateInput.safeParse(items(1)).success);
    assert.ok(PrCreateInput.safeParse(items(10)).success);
    assert.ok(!PrCreateInput.safeParse(items(0)).success);
    assert.ok(!PrCreateInput.safeParse(items(11)).success);
  });

  test('testing.not_rerunnable', () => {
    for (const c of [
      './scripts/t.sh',
      '/usr/bin/env node t.js',
      'curl http://localhost:3000/health',
      'find / -name x',
      'pnpm test -t /parse/',
      'grep -E /^a$/ f',
    ]) {
      pass({ testing: [unit({ command: c })] });
    }
    for (const c of [
      '/Users/x/repo/t.sh',
      'node /home/x/t.js',
      'cat /tmp/a',
      'cat /private/tmp/a',
      'node ~/x/t.js',
      '$HOME/bin/t',
      'node --config=/Users/x/c.json t.js',
      'C:\\x\\t.exe',
    ]) {
      failOnly({ testing: [unit({ command: c })] }, 'testing.not_rerunnable');
    }
    assert.deepEqual(machinePaths('node /home/x/a.js "~/b"'), ['/home/x/a.js', '~/b']);
  });

  test('testing.compound_command', () => {
    for (const c of [
      'pnpm test -- -t "a|b"',
      "pnpm test -- -t 'a;b && c'",
      'pnpm test -- -t a\\|b',
      'pnpm test -- -t "$NAME"',
      "grep '$(x)' f",
    ]) {
      pass({ testing: [unit({ command: c })] });
    }
    for (const c of [
      'pnpm test | tail',
      'a && b',
      'a || b',
      'a; b',
      'a > f',
      'a < f',
      'a &',
      'echo `x`',
      'echo $(x)',
      'echo "$(x)"',
      'a 2>&1',
    ]) {
      failOnly({ testing: [unit({ command: c })] }, 'testing.compound_command');
    }
    assert.deepEqual(compoundOperators('a 2>&1 | tail && b'), ['>', '&', '|', '&&']);
  });

  test('testing.compound_command: a quote left open hides later operators, so it is flagged', () => {
    for (const c of ["pnpm test --grep don't | tail", 'pnpm test -t "a | b', "echo 'x"]) {
      failOnly({ testing: [unit({ command: c })] }, 'testing.compound_command');
    }
    const [issue] = createRules(make({ testing: [unit({ command: "pnpm test --grep don't | tail" })] }), CTX);
    assert.match(issue?.message ?? '', /unbalanced quote/);
    pass({ testing: [unit({ command: 'pnpm test --grep "don\'t"' })] });
    pass({ testing: [unit({ command: "pnpm test --grep don\\'t" })] });
  });

  test('testing.notes_required for every non-pass result', () => {
    pass({ testing: [unit(), unit({ result: 'fail', notes: 'flaky upstream' })] });
    for (const result of ['fail', 'skipped', 'not-run']) {
      failOnly({ testing: [unit(), unit({ result })] }, 'testing.notes_required');
    }
  });

  test('testing[i].cwd is structural', () => {
    const withCwd = (cwd: string) => ({ ...base(), testing: [unit({ cwd })] });
    assert.ok(PrCreateInput.safeParse(withCwd('packages/reactor')).success);
    assert.ok(!PrCreateInput.safeParse(withCwd('../x')).success);
    assert.ok(!PrCreateInput.safeParse(withCwd('/abs')).success);
  });

  test('issue paths point at the item', () => {
    const got = createRules(make({ testing: [unit(), { kind: 'lint', result: 'skipped' }] }), CTX);
    assert.deepEqual(
      got.map((i) => [i.path, i.code]),
      [
        ['testing[1].command', 'testing.command_required'],
        ['testing[1].notes', 'testing.notes_required'],
      ],
    );
  });
});

describe('risk and revert', () => {
  test('risk.note_required', () => {
    pass({ risk: 'low' });
    pass({ risk: 'medium', riskNote: 'Unsigned clients now fail.' });
    failOnly({ risk: 'high' }, 'risk.note_required');
    failOnly({ risk: 'medium' }, 'risk.note_required');
  });

  test('risk.below_component_floor', () => {
    pass({ components: ['reactor', 'auth'], risk: 'medium', riskNote: 'n' });
    pass({ components: ['reactor', 'auth'], risk: 'high', riskNote: 'n' });
    failOnly({ components: ['reactor', 'auth'], risk: 'low' }, 'risk.below_component_floor');
    const got = createRules(make({ components: ['reactor', 'auth', 'release'], risk: 'medium', riskNote: 'n' }), CTX);
    assert.deepEqual(
      got.map((i) => i.code),
      ['risk.below_component_floor'],
    );
    assert.match(got[0]?.message ?? '', /release \(high\)/);
  });

  test('config minRisk uses the same values and order as Risk', () => {
    assert.deepEqual(ComponentMinRisk.options, [...RISK_ORDER]);
  });

  test('revert.note_required / with_required', () => {
    pass({ revertPolicy: 'revert-safe' });
    pass({ revertPolicy: 'revert-with-followup', revertNote: 'Re-publish the schema.' });
    pass({ revertPolicy: 'forward-fix-only', revertNote: 'Migration is one-way.' });
    pass({ revertPolicy: 'coordinated', revertWith: ['#3184'] });
    failOnly({ revertPolicy: 'forward-fix-only' }, 'revert.note_required');
    failOnly({ revertPolicy: 'revert-with-followup' }, 'revert.note_required');
    failOnly({ revertPolicy: 'coordinated', revertWith: [] }, 'revert.with_required');
    failOnly({ revertPolicy: 'coordinated' }, 'revert.with_required');
  });
});

describe('components, base, refs', () => {
  test('components: 1 and 5 unique pass; 0 and 6 are structural; a duplicate fails', () => {
    pass({ components: ['reactor'] });
    pass({ components: ['reactor', 'shared', 'x', 'auth', 'release'], risk: 'high', riskNote: 'n' });
    assert.ok(!PrCreateInput.safeParse({ ...base(), components: [] }).success);
    assert.ok(!PrCreateInput.safeParse({ ...base(), components: ['a', 'b', 'c', 'd', 'e', 'f'] }).success);
    const dup = createRules(make({ components: ['reactor', 'reactor'] }), CTX);
    assert.deepEqual(
      dup.map((i) => [i.path, i.code]),
      [['components[1]', 'components.duplicate']],
    );
  });

  test('a component not in the config is invalid_value with a suggestion', () => {
    const got = createRules(make({ components: ['reactor', 'sharde'] }), CTX);
    assert.deepEqual(got, [
      {
        path: 'components[1]',
        code: 'invalid_value',
        message: "unknown component 'sharde'; .github/ghx.json declares reactor, shared, x, auth, release",
        received: 'sharde',
        suggestion: 'shared',
      },
    ]);
  });

  test('base.equals_head', () => {
    pass({ base: 'main', head: 'fix/x' });
    failOnly({ base: 'fix/x', head: 'fix/x' }, 'base.equals_head');
  });

  test('refs.stacked_on_default_base (only when the default branch is known)', () => {
    const known = ctxWith({}, 'main');
    pass({ base: 'feat/parent', refs: { stackedOn: '#3184' } }, known);
    failOnly({ base: 'main', refs: { stackedOn: '#3184' } }, 'refs.stacked_on_default_base', known);
    pass({ base: 'main', refs: { stackedOn: '#3184' } });
  });
});

test('every issue is reported together', () => {
  const got = codes({
    title: 'Fix stuff.',
    description: '# Summary\n\n- a\n- b',
    testing: [{ kind: 'unit', result: 'skipped' }],
    risk: 'high',
    revertPolicy: 'coordinated',
    components: ['reactor', 'reactor'],
    base: 'x',
    head: 'x',
  });
  for (const c of [
    'title.format',
    'title.trailing_period',
    'description.lines',
    'description.markdown_structure',
    'testing.min_pass',
    'testing.command_required',
    'testing.notes_required',
    'risk.note_required',
    'revert.with_required',
    'components.duplicate',
    'base.equals_head',
  ]) {
    assert.ok(got.includes(c), `missing ${c} in ${JSON.stringify(got)}`);
  }
});

test('validationError / assertNoIssues give VALIDATION with all issues', () => {
  assert.doesNotThrow(() => assertNoIssues([]));
  const issues = createRules(make({ title: 'fix(reactr): x', risk: 'high' }), CTX);
  assert.throws(
    () => assertNoIssues(issues),
    (e: unknown) => {
      assert.ok(isGhxError(e, 'VALIDATION'));
      assert.equal(e.exitCode, 2);
      assert.equal(e.message, '2 input issues.');
      assert.deepEqual(e.details?.issues, issues);
      assert.equal(
        e.hint,
        "title: scope 'reactr' is not a component in .github/ghx.json; the scope must be a component name (reactor, shared, x, auth, release), or drop the scope (did you mean 'reactor'?) (+1 more in details.issues)",
      );
      return true;
    },
  );
  assert.equal(validationError(issues.slice(1)).message, '1 input issue.');
});

describe('schemas', () => {
  test('PrCreateInput and PrEditInput export to JSON Schema without a config', () => {
    assert.equal(assertExportable({ PrCreateInput, PrEditInput }), 2);
  });

  test('PrCreateInput is strict', () => {
    assert.ok(!PrCreateInput.safeParse({ ...base(), labels: ['x'] }).success);
    assert.ok(!PrCreateInput.safeParse({ ...base(), components: ['Bad Name'] }).success);
  });

  test('PrEditInput: partial, no head, adopt allowed, empty patch refused', () => {
    assert.ok(PrEditInput.safeParse({ description: 'New.' }).success);
    assert.ok(PrEditInput.safeParse({ draft: false }).success);
    const { head: _head, ...full } = base();
    assert.ok(PrEditInput.safeParse({ ...full, adopt: true }).success);
    assert.ok(!PrEditInput.safeParse({ head: 'x' }).success);
    assert.ok(!PrEditInput.safeParse({ labels: [] }).success);
    assert.ok(!PrEditInput.safeParse({}).success);
  });

  test('a merged edit runs through the same rules', () => {
    const merged = { ...base(), ...PrEditInput.parse({ risk: 'high' }) } as PrCreateInput;
    assert.deepEqual(
      createRules(merged, CTX).map((i) => i.code),
      ['risk.note_required'],
    );
  });
});
