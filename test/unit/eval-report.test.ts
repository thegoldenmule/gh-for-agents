import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyCounts } from '../../scripts/eval/model/session.ts';
import { emptyParseStats } from '../../scripts/eval/pipeline.ts';
import { diffDefinitions, formatDiff } from '../../scripts/eval/report/compare.ts';
import {
  ADOPTION_STATEMENT,
  bucketHeaders,
  buildCell,
  buildReport,
  compareCells,
  MIN_N,
  parseReport,
  type ReportInput,
  serializeReport,
} from '../../scripts/eval/report/json.ts';
import { render } from '../../scripts/eval/report/markdown.ts';
import type { MetricDef, Unit } from '../../scripts/eval/units/types.ts';

const CATALOG: MetricDef[] = [
  {
    id: 'round_trips',
    unit: 'calls',
    description: 'API calls',
    formula: 'unique message.id',
    robustness: 'robust',
    applies_to: ['episode', 'wait', 'pr_cycle', 'pr_lifecycle', 'session'],
  },
  {
    id: 'tool_calls',
    unit: 'calls',
    description: 'tool calls',
    formula: 'count',
    robustness: 'robust',
    applies_to: ['episode', 'wait', 'pr_cycle', 'pr_lifecycle', 'session'],
  },
  {
    id: 'cost_norm',
    unit: 'usd',
    description: 'normalised cost',
    formula: 'sum',
    robustness: 'robust',
    applies_to: ['episode', 'wait', 'pr_cycle', 'pr_lifecycle', 'session'],
  },
  {
    id: 'errors',
    unit: 'calls',
    description: 'errors',
    formula: 'count',
    robustness: 'robust',
    applies_to: ['episode'],
  },
];

let seq = 0;
function unit(o: Partial<Unit> & { m?: Record<string, number | null> }): Unit {
  seq++;
  const { m, ...rest } = o;
  return {
    unit_id: `u${String(seq).padStart(4, '0')}`,
    kind: 'episode',
    session_id: 'sess-a',
    agent_id: null,
    context: 'main',
    project: '-tmp-repo',
    model: 'claude-opus-5-5',
    bucket: 'gh-pre',
    category: 'merge',
    pr: null,
    start_ts: '2026-10-20T00:00:00.000Z',
    end_ts: '2026-10-20T00:01:00.000Z',
    tool_use_ids: [`toolu_${seq}`],
    flags: [],
    metrics: { round_trips: 1, tool_calls: 1, cost_norm: 0.1, errors: 0, ...m },
    children: [],
    start_pos: seq,
    ...rest,
  };
}

/** n units spread over `sessions` sessions, metric values from `values` cycled. */
function many(n: number, o: Partial<Unit>, values: number[], sessions = n): Unit[] {
  return Array.from({ length: n }, (_, i) =>
    unit({
      ...o,
      session_id: `${o.session_id ?? 'sess'}-${i % sessions}`,
      m: { round_trips: values[i % values.length] as number, tool_calls: (values[i % values.length] as number) * 2 },
    }),
  );
}

function input(units: Unit[], over: Partial<ReportInput> = {}): ReportInput {
  return {
    manifest: {
      hash: 'f'.repeat(64),
      createdAt: '2100-01-01T00:00:00.000Z',
      cutoff: '2099-12-31T18:00:00.000Z',
      windowHours: 6,
      counts: { files: 3, bytes: 300 },
      excluded: { recent: { files: 0, bytes: 0 }, unmatched: { files: 1, bytes: 10 } },
    },
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
    counts: { ...emptyCounts(), synthetic_records: 2 },
    parse: { ...emptyParseStats(), error_lines: 1, error_files: 1 },
    units,
    definitions: { metricVersion: '9.9.9', constants: { REF_CTX: 50000, EPISODE_SLACK: 3 }, catalog: CATALOG },
    era: { adoptions: { '-tmp-repo': '2026-10-21T00:00:00.000Z' }, devProjectMarkers: ['gh-for-agents'] },
    ...over,
  };
}

const PRE = { bucket: 'gh-pre' as const };
const POST = { bucket: 'ghx-post' as const };

test('a cell never pools main and subagent units, nor repos, models or buckets', () => {
  assert.throws(() => buildCell([unit({}), unit({ context: 'subagent' })], CATALOG), /pools main and subagent/);
  assert.throws(() => buildCell([unit({}), unit({ project: '-tmp-other' })], CATALOG), /pools project/);
  assert.throws(() => buildCell([unit({}), unit({ model: 'claude-fable-5-1' })], CATALOG), /pools model/);
  assert.throws(() => buildCell([unit({}), unit({ bucket: 'ghx-post' })], CATALOG), /pools bucket/);
  assert.throws(() => buildCell([unit({}), unit({ category: 'create' })], CATALOG), /pools category/);
  assert.throws(() => buildCell([], CATALOG), /no units/);
});

test('buildReport splits main from subagent and each model into its own cell', () => {
  const units = [
    ...many(5, { ...PRE }, [1, 2, 3]),
    ...many(5, { ...PRE, context: 'subagent' }, [4, 5]),
    ...many(5, { ...PRE, model: 'claude-fable-5-1' }, [6]),
  ];
  const r = buildReport(input(units));
  assert.deepEqual(
    r.cells.map((c) => [c.context, c.model, c.n]),
    [
      ['main', 'claude-fable-5-1', 5],
      ['main', 'claude-opus-5-5', 5],
      ['subagent', 'claude-opus-5-5', 5],
    ],
  );
  // Different models never meet in a comparison either.
  assert.equal(r.comparisons.length, 0);
});

test('cells with n < MIN_N are greyed with no CI; n ≥ MIN_N carry median, p90, mean and CIs', () => {
  const small = buildCell(many(MIN_N - 1, PRE, [1, 2, 3]), CATALOG);
  assert.equal(small.greyed, true);
  assert.equal(small.n, 4);
  for (const m of Object.values(small.metrics)) assert.equal(m.ci, undefined);
  assert.equal(small.metrics.round_trips?.median, 1.5); // 1, 2, 3, 1

  const big = buildCell(many(9, PRE, [1, 2, 3, 4, 5, 6, 7, 8, 9]), CATALOG);
  assert.equal(big.greyed, false);
  const rt = big.metrics.round_trips;
  assert.ok(rt?.ci);
  assert.equal(rt.median, 5);
  assert.equal(rt.p90, 8.2);
  assert.equal(rt.mean, 5);
  assert.ok(rt.ci.median[0] <= 5 && 5 <= rt.ci.median[1]);
  assert.ok(rt.ci.p90[0] <= rt.ci.p90[1]);
  assert.equal(big.n_sessions, 9);
});

test('a metric measured on fewer than MIN_N units of a full cell gets no CI; nulls are not values', () => {
  const units = many(6, PRE, [1, 2, 3]).map((u, i) => (i < 4 ? { ...u, metrics: { ...u.metrics, errors: null } } : u));
  const c = buildCell(units, CATALOG);
  assert.equal(c.greyed, false);
  assert.equal(c.metrics.errors?.n, 2);
  assert.equal(c.metrics.errors?.ci, undefined);
  assert.ok(c.metrics.round_trips?.ci);
});

test('the bootstrap resamples sessions: a cell from one session has a zero-width CI', () => {
  const c = buildCell(many(6, PRE, [1, 5, 9, 2, 8, 3], 1), CATALOG);
  assert.equal(c.n_sessions, 1);
  const rt = c.metrics.round_trips;
  assert.ok(rt?.ci);
  assert.equal(rt.ci.median[0], rt.ci.median[1]);
});

test('compareCells holds kind, category, context, repo and model fixed', () => {
  const a = many(5, PRE, [1]);
  const b = many(5, POST, [2]);
  const ca = buildCell(a, CATALOG);
  const cb = buildCell(b, CATALOG);
  const ok = compareCells(ca, cb, a, b, CATALOG);
  assert.equal(ok.eligible, true);
  assert.equal(ok.metrics.round_trips?.delta, 1);
  assert.ok(ok.metrics.round_trips?.test);
  const sub = many(5, { ...POST, context: 'subagent' }, [2]);
  assert.throws(() => compareCells(ca, buildCell(sub, CATALOG), a, sub, CATALOG), /context differs/);
  const fable = many(5, { ...POST, model: 'claude-fable-5-1' }, [2]);
  assert.throws(() => compareCells(ca, buildCell(fable, CATALOG), a, fable, CATALOG), /model differs/);
  const other = many(5, { ...POST, project: '-tmp-other' }, [2]);
  assert.throws(() => compareCells(ca, buildCell(other, CATALOG), a, other, CATALOG), /project differs/);
  assert.throws(() => compareCells(ca, ca, a, a, CATALOG), /same bucket/);
});

test('a comparison with a greyed side is not eligible, has no test and is left out of the summary', () => {
  const units = [
    ...many(6, { ...PRE, category: 'merge' }, [6, 5, 7]),
    ...many(6, { ...POST, category: 'merge' }, [2, 2, 3]),
    ...many(6, { ...PRE, category: 'create' }, [1]),
    ...many(3, { ...POST, category: 'create' }, [6]),
  ];
  const r = buildReport(input(units));
  const create = r.comparisons.find((c) => c.category === 'create');
  const merge = r.comparisons.find((c) => c.category === 'merge');
  assert.ok(create && merge);
  assert.equal(create.eligible, false);
  assert.equal(create.metrics.round_trips?.test, undefined);
  assert.equal(merge.eligible, true);
  assert.ok((merge.metrics.round_trips?.test?.p ?? 1) < 0.05);
  const md = render(r);
  const summary = md.slice(md.indexOf('## Summary'), md.indexOf('## Turns'));
  assert.match(summary, /\*\*merge\*\*, main/);
  assert.doesNotMatch(summary, /create/);
  // The greyed side is marked in the tables.
  assert.match(md, /\| create \| main \| 6 \/ 3° \|/);
});

test('the header states the adoption bundle and names dominant sessions', () => {
  const r = buildReport(input(many(6, PRE, [1])));
  assert.equal(r.header.statement, ADOPTION_STATEMENT);
  assert.match(ADOPTION_STATEMENT, /adoption bundle/);
  assert.match(ADOPTION_STATEMENT, /hook/);
  assert.match(ADOPTION_STATEMENT, /CLAUDE\.md/);
  assert.match(ADOPTION_STATEMENT, /memory/);
  assert.match(render(r), /adoption bundle, not ghx alone/);

  // One session with 6 of 10: named alone.
  const one = bucketHeaders([...many(6, { ...POST, session_id: 'big' }, [1], 1), ...many(4, POST, [1])]);
  assert.deepEqual(
    one[0]?.dominant.map((d) => [d.session_id, d.share]),
    [['big-0', 0.6]],
  );
  // Two sessions with 3 + 3 of 10: both named.
  const two = bucketHeaders([
    ...many(3, { ...POST, session_id: 'x' }, [1], 1),
    ...many(3, { ...POST, session_id: 'y' }, [1], 1),
    ...many(4, POST, [1]),
  ]);
  assert.deepEqual(
    two[0]?.dominant.map((d) => d.session_id),
    ['x-0', 'y-0'],
  );
  // Ten sessions of one unit each: nobody dominates.
  assert.deepEqual(bucketHeaders(many(10, POST, [1]))[0]?.dominant, []);
  // Roll-up units do not count.
  assert.deepEqual(bucketHeaders([unit({ ...POST, kind: 'session' })]), []);
});

test('report.json is byte-identical across runs and carries what reproduces it', () => {
  const units = [...many(7, PRE, [1, 4, 2]), ...many(7, POST, [3, 1]), ...many(2, { bucket: 'dogfood-dev' }, [1])];
  const a = serializeReport(buildReport(input(units)));
  const b = serializeReport(buildReport(input([...units].reverse())));
  assert.equal(a, b);
  const r = parseReport(a);
  assert.equal(r.manifest.hash, 'f'.repeat(64));
  assert.equal(r.manifest.createdAt, '2100-01-01T00:00:00.000Z');
  assert.equal(r.versions.metric, '9.9.9');
  assert.deepEqual(r.constants, { REF_CTX: 50000, EPISODE_SLACK: 3 });
  assert.equal(r.stats.seed, 42);
  assert.equal(r.stats.B, 1000);
  assert.equal(r.stats.min_n, MIN_N);
  assert.ok(r.price_table.usdPerMTok['claude-opus-5-5']);
  assert.deepEqual(r.era_config.adoptions, { '-tmp-repo': '2026-10-21T00:00:00.000Z' });
  assert.equal(r.excluded.synthetic_records, 2);
  assert.equal(r.excluded.parse_errors.lines, 1);
  assert.equal(r.excluded.outside_manifest.unmatched.files, 1);
  assert.equal(r.excluded.dev_projects.units, 2);
  assert.deepEqual(
    r.metrics.map((m) => m.id),
    CATALOG.map((m) => m.id),
  );
  assert.equal(serializeReport(r), a);
  assert.doesNotMatch(a, /\/Users\/|\/private\/|\/tmp\//, 'no machine paths');
});

test('render is a pure function of report.json', () => {
  const r = buildReport(input([...many(6, PRE, [1, 4, 2]), ...many(6, POST, [3, 1])]));
  const md = render(r);
  assert.equal(render(parseReport(serializeReport(r))), md);
  assert.equal(render(JSON.parse(JSON.stringify(r))), md);
  for (const h of ['## Summary', '## Turns', '§4.1', '§4.2', '§4.3', '§4.4', '## Excluded', '## Definitions']) {
    assert.ok(md.includes(h), h);
  }
});

test('diffDefinitions reports changed constants and prices, and an unbumped METRIC_VERSION', () => {
  const units = many(5, PRE, [1]);
  const base = buildReport(input(units));
  const same = diffDefinitions(base, base);
  assert.deepEqual(same.changes, []);
  assert.equal(same.unversioned, false);

  const changedConst = buildReport(
    input(units, {
      definitions: { metricVersion: '9.9.9', constants: { REF_CTX: 60000, EPISODE_SLACK: 3 }, catalog: CATALOG },
    }),
  );
  const d = diffDefinitions(base, changedConst);
  assert.deepEqual(d.changes, [{ what: 'constants.REF_CTX', from: 50000, to: 60000 }]);
  assert.equal(d.unversioned, true);
  assert.match(formatDiff(d), /WARNING: definitions changed but METRIC_VERSION did not/);

  const bumped = buildReport(
    input(units, {
      definitions: {
        metricVersion: '10.0.0',
        constants: { REF_CTX: 50000, EPISODE_SLACK: 3 },
        catalog: CATALOG.map((m) => (m.id === 'errors' ? { ...m, formula: 'count of failed calls' } : m)),
      },
    }),
  );
  const e = diffDefinitions(base, bumped);
  assert.equal(e.unversioned, false);
  assert.deepEqual(
    e.changes.map((c) => c.what),
    ['versions.metric', 'metrics.errors.formula'],
  );
  const repriced = structuredClone(base);
  (repriced.price_table.usdPerMTok as Record<string, { input: number }>)['claude-opus-5-5'] = {
    ...repriced.price_table.usdPerMTok['claude-opus-5-5'],
    input: 5,
  } as never;
  assert.deepEqual(
    diffDefinitions(base, repriced).changes.map((c) => c.what),
    ['price_table.usdPerMTok.claude-opus-5-5.input'],
  );
  // The markdown shows the baseline block.
  const withBase = { ...bumped, baseline: e };
  assert.match(render(withBase), /## Definition changes since the baseline[\s\S]*metrics\.errors\.formula/);
});
