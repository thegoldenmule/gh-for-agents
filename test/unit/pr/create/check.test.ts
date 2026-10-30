// One-pass input checking (02 §2.1): gh names, mechanical fixes with warnings, aliases, per-field
// structure, the did-you-mean for components, and the --example / schema views built from the config.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigSchema } from '../../../../src/config/schema.ts';
import { normalizeComponents, normalizeInput, structureIssues } from '../../../../src/pr/create/check.ts';
import { resolveComponent, suggestComponent } from '../../../../src/pr/create/components.ts';
import { createExample, createExampleOutput, editExampleOutput } from '../../../../src/pr/create/example.ts';
import { PR_FIELDS } from '../../../../src/pr/create/plan.ts';
import { partialRules, splitChain } from '../../../../src/pr/create/rules.ts';
import { PrCreateInput } from '../../../../src/pr/create/schema.ts';
import { createSchemaView } from '../../../../src/pr/create/schema-view.ts';

const config = ConfigSchema.parse({
  version: 1,
  components: {
    'reactor-monitor-app': { paths: ['apps/reactor-monitor/**'], aliases: ['apps-reactor-monitor'] },
    'reactor-monitor': { paths: ['packages/reactor-monitor/**'] },
    switchboard: { paths: ['apps/switchboard/**'], minRisk: 'medium' },
    codegen: { paths: ['packages/codegen/**'] },
    docs: {},
  },
});

test('splitChain: only && outside quotes splits; anything else is null', () => {
  assert.deepEqual(splitChain('pnpm typecheck && pnpm lint && pnpm test'), [
    'pnpm typecheck',
    'pnpm lint',
    'pnpm test',
  ]);
  assert.deepEqual(splitChain('cd a && pnpm test'), ['cd a', 'pnpm test']);
  assert.equal(splitChain("node -e 'a && b'"), null);
  assert.equal(splitChain('pnpm test | tee log && x'), null);
  assert.equal(splitChain('pnpm test &&'), null);
  assert.equal(splitChain('pnpm test'), null);
  assert.equal(splitChain('a && "b'), null);
});

test('normalizeInput: body → description, gh-only keys explained, unknown keys get did-you-mean', () => {
  const n = normalizeInput({ body: 'x', closes: ['#1'], labels: ['bug'], titel: 't' }, config, PR_FIELDS);
  assert.equal(n.value.description, 'x');
  assert.deepEqual(
    n.warnings.map((w) => w.code),
    ['FIELD_RENAMED'],
  );
  const by = Object.fromEntries(n.issues.map((i) => [i.path, i]));
  assert.match(by.closes?.message ?? '', /refs\.closes/);
  assert.match(by.labels?.message ?? '', /ghx does not set labels/);
  assert.equal(by.titel?.suggestion, 'title');
  const both = normalizeInput({ body: 'x', description: 'y' }, config, PR_FIELDS);
  assert.equal(both.value.description, 'y');
  assert.equal(both.issues[0]?.suggestion, 'description');
});

test('normalizeInput: footer, one trailing period (not an ellipsis), chained and cd commands', () => {
  const n = normalizeInput(
    {
      title: 'fix(docs): typo. ',
      description: 'Fixed.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)',
      testing: [
        { kind: 'lint', command: 'pnpm lint && pnpm format:check', result: 'pass' },
        { kind: 'unit', command: 'cd packages/app && pnpm test', result: 'pass', cwd: 'repo' },
        'pnpm test',
      ],
    },
    config,
    PR_FIELDS,
  );
  assert.equal(n.value.title, 'fix(docs): typo');
  assert.equal(n.value.description, 'Fixed.');
  assert.deepEqual(n.value.testing, [
    { kind: 'lint', command: 'pnpm lint', result: 'pass' },
    { kind: 'lint', command: 'pnpm format:check', result: 'pass' },
    { kind: 'unit', command: 'pnpm test', result: 'pass', cwd: 'repo/packages/app' },
    'pnpm test',
  ]);
  assert.deepEqual(
    n.warnings.map((w) => w.code),
    ['FOOTER_STRIPPED', 'TITLE_PERIOD_REMOVED', 'TESTING_SPLIT', 'TESTING_SPLIT'],
  );
  assert.equal(normalizeInput({ title: 'fix: wait...' }, config, PR_FIELDS).value.title, 'fix: wait...');
  const outside = normalizeInput(
    { testing: [{ kind: 'unit', command: 'cd /tmp && x', result: 'pass' }] },
    config,
    PR_FIELDS,
  );
  assert.deepEqual(outside.warnings, [], 'an absolute cd stays for testing.not_rerunnable');
  const many = Array.from({ length: 6 }, () => ({ kind: 'unit', command: 'a && b', result: 'pass' }));
  assert.deepEqual(normalizeInput({ testing: many }, config, PR_FIELDS).warnings, [], 'past 10 items: unchanged');
});

test('normalizeComponents: aliases in the scope and the list, duplicates, the scope added', () => {
  const v: Record<string, unknown> = {
    title: 'feat(apps-reactor-monitor): x',
    components: ['codegen', 'apps-reactor-monitor', 'codegen', 7],
  };
  const w = normalizeComponents(v, config, { addScope: true });
  assert.equal(v.title, 'feat(reactor-monitor-app): x');
  assert.deepEqual(v.components, ['codegen', 'reactor-monitor-app', 7]);
  assert.deepEqual(
    w.map((x) => x.code),
    ['COMPONENTS_DEDUPED', 'COMPONENT_ALIAS'],
  );
  const added: Record<string, unknown> = { title: 'fix(codegen): x', components: ['docs'] };
  assert.deepEqual(
    normalizeComponents(added, config, { addScope: true }).map((x) => x.code),
    ['COMPONENT_FROM_SCOPE'],
  );
  assert.deepEqual(added.components, ['codegen', 'docs']);
  const absent: Record<string, unknown> = { title: 'fix(codegen): x' };
  normalizeComponents(absent, config, { addScope: true });
  assert.deepEqual(absent.components, ['codegen']);
  const edit: Record<string, unknown> = { title: 'fix(codegen): x', components: ['docs'] };
  assert.deepEqual(normalizeComponents(edit, config, { addScope: false }), []);
});

test('structureIssues: each field on its own, "required" with an example, good testing items kept', () => {
  const s = structureIssues(
    {
      title: 'fix: x',
      testing: ['pnpm test', { kind: 'manual', result: 'pass' }],
      risk: 'safe',
    },
    PrCreateInput,
    ['title', 'description', 'testing', 'risk', 'revertPolicy'],
  );
  const by = Object.fromEntries(s.issues.map((i) => [i.path, i]));
  assert.match(by.description?.message ?? '', /^missing required field 'description': .*; e\.g\. "Requests/);
  assert.match(by['testing[0]']?.message ?? '', /expected a testing item object.*"kind":"unit"/);
  assert.equal(by.risk?.code, 'invalid_value');
  assert.deepEqual(s.parsed.testing, [{ kind: 'manual', result: 'pass' }]);
  assert.deepEqual(s.testingAt, [1]);
  const rules = partialRules(s.parsed, { config }, s.testingAt);
  assert.deepEqual(
    rules.map((i) => `${i.path} ${i.code}`),
    ['testing[1].steps testing.steps_required'],
  );
});

test('suggestComponent: alias, then the component whose paths the name spells, then edit distance', () => {
  assert.equal(resolveComponent('apps-reactor-monitor', config.components), 'reactor-monitor-app');
  assert.equal(resolveComponent('nope', config.components), null);
  assert.deepEqual(suggestComponent('apps-reactor-monitor', config.components), ['reactor-monitor-app']);
  assert.deepEqual(suggestComponent('packages-codegen', config.components), ['codegen']);
  assert.deepEqual(suggestComponent('apps-switchboard', config.components), ['switchboard']);
  assert.deepEqual(suggestComponent('codegn', config.components), ['codegen']);
  const titled = partialRules({ title: 'feat(packages-codegen): x' }, { config });
  assert.equal(titled[0]?.suggestion, 'codegen');
});

test('the --example input passes every offline rule for its config; the views carry the rules', () => {
  const ex = createExample(config);
  assert.equal(ex.title, 'feat(reactor-monitor-app): show a banner when a request is retried');
  const required = ['title', 'description', 'testing', 'risk', 'revertPolicy', 'components', 'base', 'head'];
  const s = structureIssues({ ...ex, base: 'main', head: 'x' }, PrCreateInput, required);
  assert.deepEqual(s.issues, []);
  assert.deepEqual(partialRules(s.parsed, { config }), []);
  const out = createExampleOutput(config);
  assert.ok(out.rules.some((r) => r.includes('risk floors: switchboard ≥ medium')));
  assert.ok(out.rules.some((r) => r.includes('aliases: apps-reactor-monitor → reactor-monitor-app')));
  assert.match(editExampleOutput(config).rules[1] ?? '', /ghx pr ready/);
  const view = createSchemaView(config);
  assert.deepEqual((view.input as { required: string[] }).required, [
    'title',
    'description',
    'testing',
    'risk',
    'revertPolicy',
  ]);
  assert.deepEqual(view.components, Object.keys(config.components));
  const bare = createSchemaView(undefined);
  assert.equal(bare.components, undefined);
  assert.equal((bare.example as { title: string }).title, 'feat: show a banner when a request is retried');
  assert.ok(JSON.stringify(view).length < 4000);
});
