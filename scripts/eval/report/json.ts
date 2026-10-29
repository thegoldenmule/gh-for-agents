// report.json (plan 07 M3): cells of units with medians, p90 and seeded cluster-bootstrap CIs, comparisons
// between buckets, and everything needed to reproduce them (Determinism contract). Pure: no clock, paths or
// environment; floats rounded to six decimals; keys in construction order or sorted.
//
// The comparison rules are enforced here and tested: a cell never pools contexts, repos, models or buckets
// (buildCell throws); a comparison differs only in bucket (compareCells throws); a cell with n < MIN_N is
// greyed, has no CI or test and stays out of summary lines; the header names the adoption bundle and the
// dominant sessions of each bucket.

import type { Manifest } from '../corpus/manifest.ts';
import {
  BOOTSTRAP_B,
  BOOTSTRAP_METHOD,
  BOOTSTRAP_SEED,
  CI_LEVEL,
  clusterBootstrap,
  MANN_WHITNEY_METHOD,
  mannWhitneyU,
  mean,
  QUANTILE_METHOD,
  quantileSorted,
  round,
  sorted,
} from '../metrics/stats.ts';
import { priceTable } from '../model/pricing.ts';
import type { Counts, EraConfig, Tables } from '../model/session.ts';
import type { ParseStats } from '../pipeline.ts';
import type { Context, MetricDef, Unit, UnitBucket, UnitKind } from '../units/types.ts';

export const REPORT_SCHEMA = 'ghx-eval/report@1';
/** Cells below this many units are greyed: no CI, no test, never in a summary line. */
export const MIN_N = 5;
/** Two or fewer sessions holding more than this share of a bucket's units are named in the header. */
export const DOMINANT_SHARE = 0.5;

export const BUCKETS: readonly UnitBucket[] = ['gh-pre', 'ghx-post', 'gh-post', 'dogfood-dev', 'never-adopted'];
export const KINDS: readonly UnitKind[] = ['episode', 'wait', 'pr_cycle', 'pr_lifecycle', 'session'];
export const CONTEXTS: readonly Context[] = ['main', 'subagent'];
/** Which buckets are compared, as (before, after). Only adopted repos have both sides. */
export const COMPARISON_PAIRS: readonly (readonly [UnitBucket, UnitBucket])[] = [
  ['gh-pre', 'ghx-post'],
  ['gh-post', 'ghx-post'],
];
/**
 * How units are filed into cells. unit: by kind and category (intent for episodes, mechanism for waits).
 * intent: episodes plus non-derived waits by intent (findings §4.1). created_merged: PR lifecycles created and
 * merged in their session (findings §4.4).
 */
export type View = 'unit' | 'intent' | 'created_merged';
export const VIEWS: readonly View[] = ['unit', 'intent', 'created_merged'];

/** The category a unit is filed under in a view, or null when the view does not take it. */
export function viewCategory(view: View, u: Unit): string | null {
  if (view === 'unit') return u.category;
  if (view === 'intent') {
    const atom = u.kind === 'episode' || (u.kind === 'wait' && !u.flags.includes('derived'));
    return atom && typeof u.intent === 'string' ? u.intent : null;
  }
  return u.kind === 'pr_lifecycle' && u.flags.includes('created') && u.flags.includes('merged') ? u.category : null;
}

/** Units that are atoms (not roll-ups); bucket shares and dominant sessions count these. */
export const ATOMIC_KINDS: readonly UnitKind[] = ['episode', 'wait'];

export const ADOPTION_STATEMENT =
  'Pre/post compares the adoption bundle, not ghx alone: ghx, its PreToolUse hook, the CLAUDE.md block and the ' +
  'no-sleep memory arrived together. The data are observational: sessions differ in their work, model mix and ' +
  'share of subagents, so a difference here is an association, not an effect of ghx.';

// ---------------------------------------------------------------------------------------------- types

export interface Definitions {
  metricVersion: string;
  constants: Readonly<Record<string, unknown>>;
  catalog: readonly MetricDef[];
}

export interface CorpusSummary {
  sessions: number;
  agents: number;
  turns: number;
  human_turns: number;
  api_calls: number;
  tool_calls: number;
  github_tool_calls: Record<string, number>;
  cost_usd: number;
  sessions_by_era: Record<string, number>;
  dev: { projects: string[]; sessions: number };
}

export interface ReportInput {
  manifest: Pick<Manifest, 'hash' | 'createdAt' | 'cutoff' | 'windowHours' | 'counts' | 'excluded'>;
  corpus: CorpusSummary;
  counts: Counts;
  parse: ParseStats;
  units: readonly Unit[];
  definitions: Definitions;
  era: EraConfig;
  /** Definition changes against a baseline report (report/compare.ts), when one was given. */
  baseline?: BaselineDiff | null;
}

export type Pair = [number, number];

export interface MetricSummary {
  /** Units with a value (null: the metric did not apply or could not be measured). */
  n: number;
  median: number;
  p90: number;
  mean: number;
  /** Share of units with a non-zero value (e.g. "% with an error"). */
  nonzero: number;
  /** 95% cluster-bootstrap intervals; absent when the cell is greyed or n < MIN_N. */
  ci?: { median: Pair; p90: Pair; mean: Pair };
}

export interface CellKey {
  view: View;
  /** The units' kind; 'episode' for the intent view, which also takes waits. */
  kind: UnitKind;
  category: string;
  context: Context;
  project: string;
  model: string;
  bucket: UnitBucket;
}

export interface Cell extends CellKey {
  id: string;
  n: number;
  n_sessions: number;
  greyed: boolean;
  metrics: Record<string, MetricSummary>;
}

export interface ComparisonMetric {
  a: number;
  b: number;
  /** b − a, of medians. */
  delta: number;
  /** Mann-Whitney U of a against b; only when the comparison is eligible and both sides have n ≥ MIN_N. */
  test?: { u: number; z: number; p: number };
}

export interface Comparison {
  id: string;
  view: View;
  kind: UnitKind;
  category: string;
  context: Context;
  project: string;
  model: string;
  a: UnitBucket;
  b: UnitBucket;
  n_a: number;
  n_b: number;
  /** Both cells have n ≥ MIN_N; the markdown's headline lines use only these. */
  eligible: boolean;
  metrics: Record<string, ComparisonMetric>;
}

export interface DominantSession {
  session_id: string;
  project: string;
  units: number;
  share: number;
}

export interface BucketHeader {
  bucket: UnitBucket;
  units: number;
  sessions: number;
  /** One or two sessions holding more than DOMINANT_SHARE of the bucket's atomic units; else empty. */
  dominant: DominantSession[];
}

export interface DefinitionChange {
  what: string;
  from: unknown;
  to: unknown;
}

export interface BaselineDiff {
  manifest: string;
  metric_version: { from: string; to: string };
  changes: DefinitionChange[];
  /** Definitions changed but METRIC_VERSION did not: the report cannot be told apart from the baseline's. */
  unversioned: boolean;
}

type Count = { files: number; bytes: number };

export interface Excluded {
  synthetic_records: number;
  dev_projects: { note: string; projects: string[]; sessions: number; units: number };
  outside_manifest: { cutoff: string; recent: Count; unmatched: Count };
  parse_errors: { lines: number; files: number; json_files: number; partial_last_line: Count };
  invalid_records: Record<string, number>;
  unknown_record_types: Record<string, number>;
  files_outside_sessions: number;
  deduplicated: {
    assistant_records: number;
    fork_copied_calls: number;
    fork_copied_turns: number;
    notification_sightings: number;
  };
  unlinked_agents: number;
}

export interface Report {
  schema: string;
  manifest: {
    hash: string;
    createdAt: string;
    cutoff: string;
    windowHours: number;
    files: number;
    bytes: number;
  };
  versions: { metric: string; price_table: string; report: string };
  constants: Readonly<Record<string, unknown>>;
  price_table: ReturnType<typeof priceTable>;
  era_config: { adoptions: Record<string, string>; devProjectMarkers: string[] };
  stats: {
    seed: number;
    B: number;
    ci_level: number;
    min_n: number;
    cluster: string;
    quantile: string;
    bootstrap: string;
    test: string;
    comparison_pairs: [string, string][];
  };
  header: { statement: string; buckets: BucketHeader[] };
  excluded: Excluded;
  corpus: CorpusSummary & { units_by_kind: Record<string, number>; atomic_units_by_bucket: Record<string, number> };
  baseline: BaselineDiff | null;
  metrics: MetricDef[];
  cells: Cell[];
  comparisons: Comparison[];
}

// ---------------------------------------------------------------------------------------------- helpers

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const r6 = (x: number): number => round(x, 6);
const pair = (i: { lo: number; hi: number }): Pair => [r6(i.lo), r6(i.hi)];

function sortedRecord(m: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(m).sort(cmp)) out[k] = m[k] as number;
  return out;
}

function bump(m: Record<string, number>, k: string, by = 1): void {
  m[k] = (m[k] ?? 0) + by;
}

export function cellId(k: CellKey): string {
  return [k.view, k.kind, k.category, k.context, k.project, k.model, k.bucket].join('|');
}

function keyOf(u: Unit, view: View): CellKey | null {
  const category = viewCategory(view, u);
  if (category === null) return null;
  return {
    view,
    kind: view === 'intent' ? 'episode' : u.kind,
    category,
    context: u.context,
    project: u.project,
    model: u.model,
    bucket: u.bucket,
  };
}

function orderOf<T>(list: readonly T[], x: T): number {
  const i = list.indexOf(x);
  return i === -1 ? list.length : i;
}

export function compareKeys(a: CellKey, b: CellKey): number {
  return (
    orderOf(VIEWS, a.view) - orderOf(VIEWS, b.view) ||
    orderOf(KINDS, a.kind) - orderOf(KINDS, b.kind) ||
    cmp(a.category, b.category) ||
    orderOf(CONTEXTS, a.context) - orderOf(CONTEXTS, b.context) ||
    cmp(a.project, b.project) ||
    cmp(a.model, b.model) ||
    orderOf(BUCKETS, a.bucket) - orderOf(BUCKETS, b.bucket)
  );
}

/** The catalog metrics that apply to a kind, in catalog order. */
export function metricsFor(kind: UnitKind, catalog: readonly MetricDef[]): MetricDef[] {
  return catalog.filter((d) => d.applies_to.includes(kind));
}

function valuesOf(units: readonly Unit[], id: string): { cluster: string; value: number }[] {
  const out: { cluster: string; value: number }[] = [];
  for (const u of units) {
    const v = u.metrics[id];
    if (typeof v === 'number' && Number.isFinite(v)) out.push({ cluster: u.session_id, value: v });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- cells

/**
 * One cell: units that share a view's category, kind, context, repo, model and bucket. Throws when they do
 * not, so no caller can pool main with subagent, or two repos, models or buckets.
 */
export function buildCell(units: readonly Unit[], catalog: readonly MetricDef[], view: View = 'unit'): Cell {
  const first = units[0];
  if (!first) throw new Error('buildCell: no units');
  const key = keyOf(first, view);
  if (!key) throw new Error(`buildCell: the ${view} view does not take ${first.kind} units`);
  for (const u of units) {
    const k = keyOf(u, view);
    if (!k) throw new Error(`buildCell: the ${view} view does not take ${u.kind} units`);
    if (k.context !== key.context) throw new Error(`buildCell: pools ${key.context} and ${k.context} units`);
    for (const f of ['kind', 'category', 'project', 'model', 'bucket'] as const) {
      if (k[f] !== key[f])
        throw new Error(`buildCell: pools ${f} ${JSON.stringify(key[f])} and ${JSON.stringify(k[f])}`);
    }
  }
  const n = units.length;
  const greyed = n < MIN_N;
  const metrics: Record<string, MetricSummary> = {};
  for (const d of metricsFor(key.kind, catalog)) {
    const vals = valuesOf(units, d.id);
    if (vals.length === 0) continue;
    const s = sorted(vals.map((v) => v.value));
    const m: MetricSummary = {
      n: s.length,
      median: r6(quantileSorted(s, 0.5) as number),
      p90: r6(quantileSorted(s, 0.9) as number),
      mean: r6(mean(s) as number),
      nonzero: r6(s.filter((x) => x !== 0).length / s.length),
    };
    if (!greyed && s.length >= MIN_N) {
      const b = clusterBootstrap(vals) as NonNullable<ReturnType<typeof clusterBootstrap>>;
      m.ci = { median: pair(b.median), p90: pair(b.p90), mean: pair(b.mean) };
    }
    metrics[d.id] = m;
  }
  return {
    id: cellId(key),
    ...key,
    n,
    n_sessions: new Set(units.map((u) => u.session_id)).size,
    greyed,
    metrics,
  };
}

/** Units grouped by cell key in every view, in report order. */
export function groupUnits(units: readonly Unit[]): { key: CellKey; units: Unit[] }[] {
  const by = new Map<string, { key: CellKey; units: Unit[] }>();
  for (const view of VIEWS) {
    for (const u of units) {
      const key = keyOf(u, view);
      if (!key) continue;
      const id = cellId(key);
      const g = by.get(id);
      if (g) g.units.push(u);
      else by.set(id, { key, units: [u] });
    }
  }
  return [...by.values()].sort((a, b) => compareKeys(a.key, b.key));
}

// ---------------------------------------------------------------------------------------------- comparisons

const COMPARISON_FIELDS = ['view', 'kind', 'category', 'context', 'project', 'model'] as const;

/**
 * Compare two cells that differ only in bucket. Throws otherwise: a comparison never crosses contexts, repos,
 * models, kinds or categories.
 */
export function compareCells(
  a: Cell,
  b: Cell,
  unitsA: readonly Unit[],
  unitsB: readonly Unit[],
  catalog: readonly MetricDef[],
): Comparison {
  for (const f of COMPARISON_FIELDS) {
    if (a[f] !== b[f]) throw new Error(`compareCells: ${f} differs (${a[f]} vs ${b[f]})`);
  }
  if (a.bucket === b.bucket) throw new Error('compareCells: same bucket');
  const eligible = !a.greyed && !b.greyed;
  const metrics: Record<string, ComparisonMetric> = {};
  for (const d of metricsFor(a.kind, catalog)) {
    const ma = a.metrics[d.id];
    const mb = b.metrics[d.id];
    if (!ma || !mb) continue;
    const m: ComparisonMetric = { a: ma.median, b: mb.median, delta: r6(mb.median - ma.median) };
    if (eligible && ma.n >= MIN_N && mb.n >= MIN_N) {
      const t = mannWhitneyU(
        valuesOf(unitsA, d.id).map((v) => v.value),
        valuesOf(unitsB, d.id).map((v) => v.value),
      );
      if (t) m.test = { u: r6(t.u), z: r6(t.z), p: r6(t.p) };
    }
    metrics[d.id] = m;
  }
  return {
    id: `${[a.view, a.kind, a.category, a.context, a.project, a.model].join('|')}|${a.bucket}→${b.bucket}`,
    view: a.view,
    kind: a.kind,
    category: a.category,
    context: a.context,
    project: a.project,
    model: a.model,
    a: a.bucket,
    b: b.bucket,
    n_a: a.n,
    n_b: b.n,
    eligible,
    metrics,
  };
}

export function buildComparisons(
  groups: readonly { key: CellKey; units: Unit[] }[],
  cells: readonly Cell[],
  catalog: readonly MetricDef[],
): Comparison[] {
  const byId = new Map<string, { cell: Cell; units: Unit[] }>();
  groups.forEach((g, i) => {
    byId.set(cellId(g.key), { cell: cells[i] as Cell, units: g.units });
  });
  const out: Comparison[] = [];
  for (const [i, g] of groups.entries()) {
    for (const [ba, bb] of COMPARISON_PAIRS) {
      if (g.key.bucket !== ba) continue;
      const other = byId.get(cellId({ ...g.key, bucket: bb }));
      if (!other) continue;
      out.push(compareCells(cells[i] as Cell, other.cell, g.units, other.units, catalog));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- header

/** Per bucket: atomic units, sessions, and the one or two sessions holding more than half, if any. */
export function bucketHeaders(units: readonly Unit[]): BucketHeader[] {
  const out: BucketHeader[] = [];
  for (const bucket of BUCKETS) {
    const atoms = units.filter((u) => u.bucket === bucket && ATOMIC_KINDS.includes(u.kind));
    if (atoms.length === 0) continue;
    const by = new Map<string, { project: string; units: number }>();
    for (const u of atoms) {
      const s = by.get(u.session_id);
      if (s) s.units++;
      else by.set(u.session_id, { project: u.project, units: 1 });
    }
    const ranked = [...by.entries()]
      .map(([session_id, s]) => ({ session_id, project: s.project, units: s.units, share: s.units / atoms.length }))
      .sort((x, y) => y.units - x.units || cmp(x.session_id, y.session_id));
    let dominant: DominantSession[] = [];
    const top1 = ranked[0];
    const top2 = ranked[1];
    if (top1 && top1.share > DOMINANT_SHARE) dominant = [top1];
    else if (top1 && top2 && top1.share + top2.share > DOMINANT_SHARE) dominant = [top1, top2];
    out.push({
      bucket,
      units: atoms.length,
      sessions: by.size,
      dominant: dominant.map((d) => ({ ...d, share: r6(d.share) })),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- corpus

/** The table-level numbers report.json carries (no rows). */
export function summarizeTables(t: Tables): CorpusSummary {
  const github: Record<string, number> = {};
  for (const c of t.tool_calls) if (c.cli === 'gh' || c.cli === 'ghx' || c.cli === 'mixed') bump(github, c.cli);
  const eras: Record<string, number> = {};
  const devProjects = new Set<string>();
  let devSessions = 0;
  for (const s of t.sessions) {
    bump(eras, s.era);
    if (s.is_dev) {
      devProjects.add(s.project);
      devSessions++;
    }
  }
  let cost = 0;
  for (const c of t.api_calls) cost += c.cost_usd;
  return {
    sessions: t.sessions.length,
    agents: t.agents.length,
    turns: t.turns.length,
    human_turns: t.turns.filter((x) => x.is_human).length,
    api_calls: t.api_calls.length,
    tool_calls: t.tool_calls.length,
    github_tool_calls: sortedRecord(github),
    cost_usd: round(cost, 2),
    sessions_by_era: sortedRecord(eras),
    dev: { projects: [...devProjects].sort(cmp), sessions: devSessions },
  };
}

function excludedBlock(input: ReportInput, units: readonly Unit[]): Excluded {
  const { counts, parse, manifest, corpus } = input;
  return {
    synthetic_records: counts.synthetic_records,
    dev_projects: {
      note: 'ghx development (this repo, spike directories): reported as bucket dogfood-dev, never compared',
      projects: corpus.dev.projects,
      sessions: corpus.dev.sessions,
      units: units.filter((u) => u.bucket === 'dogfood-dev').length,
    },
    outside_manifest: {
      cutoff: manifest.cutoff,
      recent: { files: manifest.excluded.recent.files, bytes: manifest.excluded.recent.bytes },
      unmatched: { files: manifest.excluded.unmatched.files, bytes: manifest.excluded.unmatched.bytes },
    },
    parse_errors: {
      lines: parse.error_lines,
      files: parse.error_files,
      json_files: parse.json_errors,
      partial_last_line: { files: parse.trailing_files, bytes: parse.trailing_bytes },
    },
    invalid_records: sortedRecord(counts.invalid_records),
    unknown_record_types: sortedRecord(counts.unknown_types),
    files_outside_sessions: parse.outside_sessions,
    deduplicated: {
      assistant_records: counts.duplicate_assistant_records,
      fork_copied_calls: counts.fork_copied_calls,
      fork_copied_turns: counts.fork_copied_turns,
      notification_sightings: counts.notification_sightings - counts.notifications,
    },
    unlinked_agents: counts.unlinked_agents,
  };
}

// ---------------------------------------------------------------------------------------------- report

export function buildReport(input: ReportInput): Report {
  const { definitions: defs } = input;
  const units = [...input.units];
  const groups = groupUnits(units);
  const cells = groups.map((g) => buildCell(g.units, defs.catalog, g.key.view));
  const comparisons = buildComparisons(groups, cells, defs.catalog);
  const byKind: Record<string, number> = {};
  const byBucket: Record<string, number> = {};
  for (const k of KINDS) byKind[k] = 0;
  for (const b of BUCKETS) byBucket[b] = 0;
  for (const u of units) {
    bump(byKind, u.kind);
    if (ATOMIC_KINDS.includes(u.kind)) bump(byBucket, u.bucket);
  }
  const adoptions: Record<string, string> = {};
  for (const k of Object.keys(input.era.adoptions).sort(cmp)) adoptions[k] = input.era.adoptions[k] as string;
  return {
    schema: REPORT_SCHEMA,
    manifest: {
      hash: input.manifest.hash,
      createdAt: input.manifest.createdAt,
      cutoff: input.manifest.cutoff,
      windowHours: input.manifest.windowHours,
      files: input.manifest.counts.files,
      bytes: input.manifest.counts.bytes,
    },
    versions: { metric: defs.metricVersion, price_table: priceTable().version, report: REPORT_SCHEMA },
    constants: defs.constants,
    price_table: priceTable(),
    era_config: { adoptions, devProjectMarkers: [...input.era.devProjectMarkers] },
    stats: {
      seed: BOOTSTRAP_SEED,
      B: BOOTSTRAP_B,
      ci_level: CI_LEVEL,
      min_n: MIN_N,
      cluster: 'session_id',
      quantile: QUANTILE_METHOD,
      bootstrap: BOOTSTRAP_METHOD,
      test: MANN_WHITNEY_METHOD,
      comparison_pairs: COMPARISON_PAIRS.map(([a, b]) => [a, b]),
    },
    header: { statement: ADOPTION_STATEMENT, buckets: bucketHeaders(units) },
    excluded: excludedBlock(input, units),
    corpus: { ...input.corpus, units_by_kind: byKind, atomic_units_by_bucket: byBucket },
    baseline: input.baseline ?? null,
    metrics: defs.catalog.map((d) => ({
      id: d.id,
      unit: d.unit,
      description: d.description,
      formula: d.formula,
      robustness: d.robustness,
      applies_to: [...d.applies_to],
    })),
    cells,
    comparisons,
  };
}

/** One-line JSON when it fits in this many columns (with its indent), else one key or item per line. */
const INLINE_WIDTH = 120;

function stringify(v: unknown, indent: string): string {
  const flat = JSON.stringify(v);
  if (v === null || typeof v !== 'object' || indent.length + flat.length <= INLINE_WIDTH) return flat;
  const inner = `${indent}  `;
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return `[\n${v.map((x) => inner + stringify(x, inner)).join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
  if (entries.length === 0) return '{}';
  return `{\n${entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${stringify(x, inner)}`).join(',\n')}\n${indent}}`;
}

/** Stable text: short values on one line, the rest indented by two spaces; a trailing newline. */
export function serializeReport(r: Report): string {
  return `${stringify(r, '')}\n`;
}

export function parseReport(text: string): Report {
  const r = JSON.parse(text) as Report;
  if (r.schema !== REPORT_SCHEMA) throw new Error(`not a ${REPORT_SCHEMA} document (schema ${String(r.schema)})`);
  return r;
}
