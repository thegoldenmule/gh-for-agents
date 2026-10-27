// --fields / --brief (src/core/fields.ts): path syntax, the projection rule, schema checks, and every
// shipped brief preset resolving against its command's output schema.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { fsRegistry } from '../../../src/cli/registry.ts';
import { type AnyCommandSpec, commandName, defineCommand } from '../../../src/core/command.ts';
import { GhxError } from '../../../src/core/errors.ts';
import { checkFields, fieldProjection, fieldTree, parseFields, projectDocument } from '../../../src/core/fields.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');

const project = (doc: unknown, ...fields: string[]): unknown => projectDocument(doc, fieldTree(parseFields(fields)));

const thrown = (f: () => unknown): GhxError => {
  try {
    f();
  } catch (e) {
    assert.ok(e instanceof GhxError, String(e));
    return e;
  }
  assert.fail('expected a throw');
};

const Status = z.object({
  ref: z.string(),
  state: z.enum(['OPEN', 'MERGED']),
  head: z.object({ ref: z.string(), sha: z.string() }),
  meta: z.object({ rev: z.number() }).nullable(),
  merge: z.object({
    ready: z.boolean(),
    blockers: z.array(z.object({ code: z.string(), message: z.string() })),
    mergeCommit: z.string().nullable(),
  }),
  ci: z.object({
    state: z.string(),
    counts: z.object({ pass: z.number(), fail: z.number() }),
    failing: z.array(z.object({ name: z.string(), url: z.string() })),
  }),
  extra: z.record(z.string(), z.unknown()).optional(),
});

const statusSpec = defineCommand({
  name: ['t', 'status'],
  summary: 's',
  kind: 'read',
  input: z.object({}),
  output: Status,
  brief: ['state', 'merge.ready'],
  async run() {
    throw new Error('unused');
  },
});

const waitSpec = defineCommand({
  name: ['t', 'wait'],
  summary: 'w',
  kind: 'read',
  input: z.object({}),
  output: z.object({
    outcome: z.string(),
    results: z.array(z.object({ target: z.string(), outcome: z.string(), ci: z.object({ state: z.string() }) })),
    eventsPath: z.string(),
  }),
  async run() {
    throw new Error('unused');
  },
});

const doc = {
  ref: 'o/r#1',
  state: 'OPEN',
  head: { ref: 'b', sha: 'abc' },
  meta: null,
  merge: {
    ready: false,
    blockers: [
      { code: 'CI_RED', message: 'x' },
      { code: 'REVIEW', message: 'y' },
    ],
    mergeCommit: null,
  },
  ci: { state: 'red', counts: { pass: 1, fail: 1 }, failing: [{ name: 'lint', url: 'u' }] },
  warnings: [{ code: 'W', message: 'kept' }],
};

test('parseFields splits commas and repeats, trims, dedupes and reads [] as map', () => {
  const p = parseFields(['state, head.sha', 'merge.blockers[].code', 'state']);
  assert.deepEqual(
    p.map((x) => x.raw),
    ['state', 'head.sha', 'merge.blockers[].code'],
  );
  assert.deepEqual(p[2]?.segments, [
    { key: 'merge', each: false },
    { key: 'blockers', each: true },
    { key: 'code', each: false },
  ]);
});

test('parseFields refuses bad syntax and an empty list as VALIDATION', () => {
  for (const bad of ['a..b', 'a[0]', '.a', 'a b', 'a[].']) {
    const e = thrown(() => parseFields([bad]));
    assert.equal(e.code, 'VALIDATION', bad);
    assert.equal((e.details as { issues: { path: string }[] }).issues[0]?.path, '--fields');
  }
  assert.equal(thrown(() => parseFields([' , '])).code, 'VALIDATION');
});

test('projection keeps the nesting, maps [] and keeps warnings', () => {
  assert.deepEqual(project(doc, 'state', 'head.sha', 'merge.blockers[].code', 'ci.counts'), {
    state: 'OPEN',
    head: { sha: 'abc' },
    merge: { blockers: [{ code: 'CI_RED' }, { code: 'REVIEW' }] },
    ci: { counts: { pass: 1, fail: 1 } },
    warnings: [{ code: 'W', message: 'kept' }],
  });
});

test('projection follows document key order, keeps null mid-path and omits absent keys', () => {
  const out = project(doc, 'ci.state', 'meta.rev', 'merge.mergeCommit', 'extra.x') as Record<string, unknown>;
  assert.deepEqual(Object.keys(out), ['meta', 'merge', 'ci', 'warnings']);
  assert.equal(out.meta, null);
  assert.deepEqual(out.merge, { mergeCommit: null });
});

test('a whole subtree wins over a path below it', () => {
  assert.deepEqual(project({ ci: { failing: [{ name: 'a', url: 'u' }] } }, 'ci.failing[].name', 'ci.failing'), {
    ci: { failing: [{ name: 'a', url: 'u' }] },
  });
});

test('a top-level results array: paths resolve per element and other top-level keys are kept', () => {
  const w = {
    outcome: 'red',
    results: [
      { target: '#1', outcome: 'red', ci: { state: 'red', phase: 'x' } },
      { target: '#2', outcome: 'green', ci: { state: 'green', phase: 'y' } },
    ],
    eventsPath: '/e',
  };
  assert.deepEqual(project(w, 'outcome', 'ci.state'), {
    outcome: 'red',
    results: [
      { target: '#1', outcome: 'red', ci: { state: 'red' } },
      { target: '#2', outcome: 'green', ci: { state: 'green' } },
    ],
    eventsPath: '/e',
  });
});

test('a results[] element keeps its identity, its error and its warnings whatever the paths', () => {
  const failed = {
    selector: '9',
    ref: 'o/r#9',
    error: { code: 'PR_NOT_FOUND', message: 'm', hint: null, details: null },
  };
  const ok = { ref: 'o/r#1', state: 'OPEN', merge: { ready: true }, warnings: [{ code: 'W', message: 'w' }] };
  assert.deepEqual(project({ results: [ok, failed] }, 'state'), {
    results: [{ ref: 'o/r#1', state: 'OPEN', warnings: ok.warnings }, failed],
  });
  assert.deepEqual(project({ results: [{ target: '#1', outcome: 'red', ci: {} }] }, 'outcome'), {
    results: [{ target: '#1', outcome: 'red' }],
  });
});

test('checkFields accepts real paths, records and nullable objects', () => {
  checkFields(statusSpec, parseFields(['state,head.sha,merge.blockers[].code,ci.failing[].name,meta.rev']));
  checkFields(statusSpec, parseFields(['extra.anything.below', 'warnings[].code']));
});

test('checkFields names the valid top-level keys and suggests a near miss', () => {
  const e = thrown(() => checkFields(statusSpec, parseFields(['stat'])));
  assert.equal(e.code, 'VALIDATION');
  assert.match(e.hint ?? '', /did you mean 'state'/);
  assert.match(e.hint ?? '', /Top-level fields: ref, state, head/);
  assert.ok((e.details as { fields: string[] }).fields.includes('merge'));
  const nested = thrown(() => checkFields(statusSpec, parseFields(['ci.stat'])));
  assert.match(nested.hint ?? '', /'stat' is not a field of 'ci'.*did you mean 'state'/);
});

test('checkFields says how to fix a path through an array, [] on a non-array, and a scalar parent', () => {
  const through = thrown(() => checkFields(statusSpec, parseFields(['merge.blockers.code'])));
  assert.match(through.hint ?? '', /write 'merge\.blockers\[\]\.code'/);
  const notArray = thrown(() => checkFields(statusSpec, parseFields(['head[].sha'])));
  assert.match(notArray.hint ?? '', /not an array: drop the \[\]/);
  const scalar = thrown(() => checkFields(statusSpec, parseFields(['state.x'])));
  assert.match(scalar.hint ?? '', /'state' has no fields/);
  assert.equal((scalar.details as { issues: unknown[] }).issues.length, 1);
});

test('a results document checks paths against the element, and a results[] prefix is corrected', () => {
  checkFields(waitSpec, parseFields(['outcome,ci.state,target']));
  const e = thrown(() => checkFields(waitSpec, parseFields(['results[].outcome'])));
  assert.match(e.hint ?? '', /resolve against each results\[\] element: write 'outcome'/);
  assert.match(e.hint ?? '', /Fields of each results\[\] element .*: target, outcome, ci/);
  assert.equal(thrown(() => checkFields(waitSpec, parseFields(['eventsPath']))).code, 'VALIDATION');
});

test('fieldProjection: none, --brief, the --brief ∪ --fields union, and --brief without a preset', () => {
  assert.equal(fieldProjection(statusSpec, {}), undefined);
  const brief = fieldProjection(statusSpec, { brief: true });
  assert.deepEqual(brief?.(doc), { state: 'OPEN', merge: { ready: false }, warnings: doc.warnings });
  const union = fieldProjection(statusSpec, { brief: true, fields: ['head.sha'] });
  assert.deepEqual(union?.(doc), {
    state: 'OPEN',
    head: { sha: 'abc' },
    merge: { ready: false },
    warnings: doc.warnings,
  });
  const e = thrown(() => fieldProjection(waitSpec, { brief: true }));
  assert.equal(e.code, 'USAGE_UNKNOWN_FLAG');
  assert.deepEqual(e.details, { flag: '--brief', suggestions: ['--fields'] });
});

test('every shipped brief preset resolves against its command output schema', async () => {
  const specs: AnyCommandSpec[] = await fsRegistry([join(ROOT, 'src', 'commands')]).list();
  const withBrief = specs.filter((s) => s.brief !== undefined);
  for (const s of withBrief) {
    assert.ok((s.brief?.length ?? 0) > 0, `${commandName(s)}: an empty brief`);
    checkFields(s, parseFields(s.brief ?? []));
  }
});
