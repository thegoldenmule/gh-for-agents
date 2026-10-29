import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyCounts } from '../../scripts/eval/model/session.ts';
import { emptyParseStats } from '../../scripts/eval/pipeline.ts';
import { buildReport, type ComparisonMetric, MIN_N, type ReportInput } from '../../scripts/eval/report/json.ts';
import {
  modelName,
  renderSummary,
  repoName,
  serializeSummary,
  summarize,
  usd,
  verdict,
  WIDTH,
  wrap,
} from '../../scripts/eval/report/summary.ts';
import type { MetricDef, Unit } from '../../scripts/eval/units/types.ts';

const tested = (a: number, b: number, p: number): ComparisonMetric => ({ a, b, delta: b - a, test: { u: 0, z: 0, p } });

test('verdict: a clear rise in cost is worse, a clear fall is better', () => {
  assert.equal(verdict(20, 20, tested(0.05, 0.09, 0.001), MIN_N), 'worse');
  assert.equal(verdict(20, 20, tested(0.11, 0.06, 0.049), MIN_N), 'better');
});

test('verdict: a difference the test does not make clear is the same', () => {
  assert.equal(verdict(20, 20, tested(0.05, 0.09, 0.05), MIN_N), 'same');
  assert.equal(verdict(20, 20, tested(0.05, 0.09, 0.6), MIN_N), 'same');
  assert.equal(verdict(20, 20, tested(0.05, 0.05, 0.001), MIN_N), 'same', 'equal medians have no direction');
});

test('verdict: fewer than min_n tasks on either side, or no test, is too few', () => {
  assert.equal(verdict(MIN_N - 1, 20, tested(0.05, 0.09, 0.001), MIN_N), 'too few');
  assert.equal(verdict(20, MIN_N - 1, tested(0.05, 0.09, 0.001), MIN_N), 'too few');
  assert.equal(verdict(0, 20, undefined, MIN_N), 'too few');
  assert.equal(verdict(20, 20, { a: 0.05, b: 0.09, delta: 0.04 }, MIN_N), 'too few');
  assert.equal(verdict(MIN_N, MIN_N, tested(0.05, 0.09, 0.001), MIN_N), 'worse');
});

test('names: repo slugs lose their shared prefix, models read as words', () => {
  const projects = ['-Users-me-projects-acme-api', '-Users-me-projects-widgets'];
  assert.equal(repoName('-Users-me-projects-acme-api', projects), 'acme-api');
  assert.equal(repoName('-Users-me-projects-widgets', projects), 'widgets');
  assert.equal(repoName('-tmp-golden-acme', ['-tmp-golden-acme']), 'acme');
  assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelName('gpt-x'), 'gpt-x');
  assert.equal(usd(0.0532), '$0.053');
  assert.equal(usd(6.213), '$6.21');
});

test('wrap keeps lines within WIDTH columns and indents the rest', () => {
  const lines = wrap('  - ', 'word '.repeat(60).trim(), 4);
  assert.ok(lines.length > 1);
  for (const l of lines) assert.ok(l.length <= WIDTH, l);
  for (const l of lines.slice(1)) assert.match(l, /^ {4}word/);
});

// ---------------------------------------------------------------------------------------------- a report

const CATALOG: MetricDef[] = ['round_trips', 'cost_norm', 'errors'].map((id) => ({
  id,
  unit: id === 'cost_norm' ? 'usd' : 'calls',
  description: id,
  formula: id,
  robustness: 'robust',
  applies_to: ['episode', 'wait', 'pr_cycle', 'pr_lifecycle', 'session'],
}));

let seq = 0;
/** n episodes of one intent, one per session, metric values cycled from the lists. */
function episodes(
  n: number,
  o: Partial<Unit>,
  m: { cost: number[]; errors?: number[]; round_trips?: number[] },
): Unit[] {
  return Array.from({ length: n }, (_, i) => {
    seq++;
    const pick = (xs: number[] | undefined, d: number): number => (xs ? (xs[i % xs.length] as number) : d);
    return {
      unit_id: `u${seq}`,
      kind: 'episode',
      session_id: `${o.bucket}-${o.project}-${o.category}-${o.context ?? 'main'}-${i}`,
      agent_id: null,
      context: 'main',
      project: '-tmp-proj-acme',
      model: 'claude-opus-5-5',
      bucket: 'gh-pre',
      category: 'merge',
      intent: o.category ?? 'merge',
      pr: null,
      start_ts: '2026-10-20T00:00:00.000Z',
      end_ts: '2026-10-20T00:01:00.000Z',
      tool_use_ids: [`toolu_${seq}`],
      flags: [],
      metrics: { cost_norm: pick(m.cost, 0.1), errors: pick(m.errors, 0), round_trips: pick(m.round_trips, 1) },
      children: [],
      parent_unit_id: null,
      start_pos: seq,
      ...o,
    } as Unit;
  });
}

function report(units: Unit[]) {
  const input: ReportInput = {
    corpus: {
      sessions: 2,
      agents: 0,
      turns: 2,
      human_turns: 2,
      api_calls: 10,
      tool_calls: 10,
      github_tool_calls: { gh: 5, ghx: 5 },
      cost_usd: 1,
      sessions_by_era: { 'gh-pre': 1, 'ghx-post': 1 },
      dev: { projects: [], sessions: 0 },
    },
    counts: emptyCounts(),
    parse: emptyParseStats(),
    units,
    definitions: { metricVersion: '9.9.9', constants: { REF_CTX: 50000 }, catalog: CATALOG },
    era: { adoptions: { '-tmp-proj-acme': '2026-10-21T00:00:00.000Z' }, devProjectMarkers: [] },
  };
  return buildReport(input);
}

const PRE = { bucket: 'gh-pre' as const };
const POST = { bucket: 'ghx-post' as const };
const SUB = { context: 'subagent' as const };
const UNITS = [
  // create, subagent: clearly dearer, more failures and more round trips with ghx
  ...episodes(8, { ...PRE, ...SUB, category: 'create' }, { cost: [0.05, 0.051, 0.052] }),
  ...episodes(8, { ...POST, ...SUB, category: 'create' }, { cost: [0.09, 0.1], errors: [1], round_trips: [3] }),
  // diagnose, main: clearly cheaper with ghx
  ...episodes(8, { ...PRE, category: 'diagnose' }, { cost: [0.2, 0.21, 0.22] }),
  ...episodes(8, { ...POST, category: 'diagnose' }, { cost: [0.1, 0.11] }),
  // merge, main: no clear change
  ...episodes(8, { ...PRE, category: 'merge' }, { cost: [0.04, 0.06, 0.05] }),
  ...episodes(8, { ...POST, category: 'merge' }, { cost: [0.05, 0.04, 0.06] }),
  // edit, main: too few after
  ...episodes(8, { ...PRE, category: 'edit' }, { cost: [0.04] }),
  ...episodes(3, { ...POST, category: 'edit' }, { cost: [0.08] }),
  // feedback: too few everywhere
  ...episodes(2, { ...PRE, category: 'feedback' }, { cost: [0.04] }),
  ...episodes(2, { ...POST, category: 'feedback' }, { cost: [0.04] }),
  // another repo with fewer before/after tasks, but enough for one comparison
  ...episodes(5, { ...PRE, project: '-tmp-proj-widgets', category: 'status' }, { cost: [0.03] }),
  ...episodes(5, { ...POST, project: '-tmp-proj-widgets', category: 'status' }, { cost: [0.03] }),
];

test('summarize: picks the repo with the most before/after tasks and gives each task a verdict', () => {
  const s = summarize(report(UNITS));
  assert.equal(s.compared?.project, '-tmp-proj-acme');
  assert.equal(s.compared?.repo, 'acme');
  assert.equal(s.compared?.model_name, 'Opus 5.5');
  const v = Object.fromEntries(s.rows.map((r) => [r.task, [r.main.verdict, r.subagent.verdict]]));
  assert.deepEqual(v, {
    diagnose: ['better', 'too few'],
    create: ['too few', 'worse'],
    merge: ['same', 'too few'],
  });
  assert.deepEqual(s.too_few, ['Edit a PR', 'Read review feedback']);
  assert.deepEqual(
    s.others.map((o) => o.repo),
    ['widgets'],
  );
});

test('summarize: a task with too few tasks on every side is left out of the table', () => {
  const s = summarize(report(UNITS));
  assert.ok(!s.rows.some((r) => r.task === 'feedback'));
  // edit has a comparison, but too few after ghx in the one context it has: left out too
  assert.ok(!s.rows.some((r) => r.task === 'edit'));
});

test('summarize: problems are the clear ghx regressions, in plain words with both sides', () => {
  const s = summarize(report(UNITS));
  assert.equal(s.problems.total, 1);
  const p = s.problems.shown[0];
  assert.equal(p?.task, 'create');
  assert.equal(p?.context, 'subagent');
  assert.deepEqual(p?.failed, { before: 0, after: 1 });
  assert.deepEqual(p?.round_trips, { before: 1, after: 3 });
  assert.equal(
    p?.text,
    'Create a PR (subagents): 100% hit a failed command (raw gh: 0%); 3 API round trips (raw gh: 1)',
  );
});

test('renderSummary: plain words, fits on a screen, the same bytes every time', () => {
  const r = report(UNITS);
  const text = renderSummary(r);
  assert.equal(renderSummary(r), text);
  assert.equal(serializeSummary(r), serializeSummary(report(UNITS)));
  const lines = text.trimEnd().split('\n');
  assert.ok(lines.length <= 25, `${lines.length} lines`);
  for (const l of lines) assert.ok(l.length <= WIDTH, l);
  assert.doesNotMatch(text, /p90|cost_norm|bucket|\bcell|\bunits?\b|p-value|\bp [<=]|gh-pre|ghx-post|intent|episode/);
  assert.match(text, /^Diagnose a CI failure +\$0\.210 → \$0\.105 {2}better +too few$/m);
  assert.match(text, /^Create a PR +too few +\$0\.051 → \$0\.095 {2}worse$/m);
  assert.match(text, /^Merge a PR +\$0\.050 → \$0\.050 {2}same +too few$/m);
  assert.match(text, /^Too few tasks to compare: Edit a PR; Read review feedback\.$/m);
  assert.match(text, /^Biggest problems with ghx:\n {2}- Create a PR \(subagents\)/m);
  assert.match(text, /^Other repos with before\/after data: widgets \(Opus 5\.5\); pnpm eval has them\.$/m);
  assert.match(text, /50k-token context/);
});

test('renderSummary: says so when no repo has data before and after ghx', () => {
  const text = renderSummary(report(episodes(6, { ...PRE, category: 'merge' }, { cost: [0.05] })));
  assert.match(text, /nothing to compare/);
  assert.equal(summarize(report([])).compared, null);
});
