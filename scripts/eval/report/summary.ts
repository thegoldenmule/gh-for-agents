// The one-screen summary (`pnpm eval --summary`) from report.json only: is ghx helping or hurting, and where.
// Like render(), summarize() and renderSummary() read nothing but their argument, so the numbers always match
// the full report. Plain words only: the verdicts come from the report's own Mann-Whitney tests, and a side
// with fewer than min_n tasks says "too few" instead of a number.
import type { Context } from '../units/types.ts';
import type { Cell, Comparison, ComparisonMetric, Report, View } from './json.ts';

/** A difference counts as clear below this p (the report's Mann-Whitney U test). */
export const ALPHA = 0.05;
/** At most this many problems are listed; the heading says how many there were. */
export const MAX_PROBLEMS = 4;
const BEFORE = 'gh-pre';
const AFTER = 'ghx-post';

export type Verdict = 'better' | 'worse' | 'same' | 'too few';

/**
 * Better or worse only when the test is clear (p < ALPHA) and the medians differ; lower is better. Same when
 * the test is not clear or the medians are equal. Too few when either side has fewer than minN tasks, or when
 * the report ran no test.
 */
export function verdict(nBefore: number, nAfter: number, m: ComparisonMetric | undefined, minN: number): Verdict {
  if (nBefore < minN || nAfter < minN || !m?.test) return 'too few';
  if (m.test.p >= ALPHA || m.delta === 0) return 'same';
  return m.delta > 0 ? 'worse' : 'better';
}

/** Tasks in table order: intents by name, then the whole PR. Intents not listed follow, by name; meta never shows. */
const TASKS: readonly { id: string; label: string }[] = [
  { id: 'diagnose', label: 'Diagnose a CI failure' },
  { id: 'create', label: 'Create a PR' },
  { id: 'edit', label: 'Edit a PR' },
  { id: 'merge', label: 'Merge a PR' },
  { id: 'rerun', label: 'Rerun CI' },
  { id: 'wait', label: 'Wait for CI' },
  { id: 'status', label: 'Check PR/CI status' },
  { id: 'feedback', label: 'Read review feedback' },
  { id: 'reply', label: 'Reply to a review' },
  { id: 'other_write', label: 'Other GitHub writes' },
  { id: 'other_read', label: 'Other GitHub reads' },
];
const LIFECYCLE = { id: 'pr_lifecycle', label: 'Whole PR, create to merge' };
const HIDDEN = new Set(['meta']);
const CONTEXT_LABEL: Record<Context, string> = { main: 'main thread', subagent: 'subagents' };

// ---------------------------------------------------------------------------------------------- types

export interface Side {
  /** Tasks before and after ghx (0 when a side has none). */
  n_before: number;
  n_after: number;
  /** Median cost per task; null when the side has no tasks. */
  before: number | null;
  after: number | null;
  p: number | null;
  verdict: Verdict;
}

export interface Row {
  task: string;
  label: string;
  main: Side;
  subagent: Side;
}

export interface Problem {
  task: string;
  context: Context;
  /** Share of tasks with at least one failed GitHub command, when the ghx side is clearly higher. */
  failed?: { before: number; after: number };
  /** Median API round trips, when the ghx side is clearly higher. */
  round_trips?: { before: number; after: number };
  /** Median cost, when the ghx side is clearly higher. */
  cost?: { before: number; after: number };
  text: string;
}

export interface Summary {
  /** The repo and model with the most before/after tasks; null when no repo has both. */
  compared: {
    project: string;
    repo: string;
    model: string;
    model_name: string;
    sessions_before: number;
    sessions_after: number;
  } | null;
  /** The reference context cost is normalized to, in tokens. */
  ref_ctx: number;
  min_n: number;
  rows: Row[];
  /** Rows left out because every side had too few tasks. */
  too_few: string[];
  problems: { total: number; shown: Problem[] };
  caveats: string[];
  /** Other repo/model pairs with at least one before/after comparison with enough tasks. */
  others: { project: string; repo: string; model: string }[];
}

// ---------------------------------------------------------------------------------------------- names

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A short repo name: the project slug without the dash-bounded prefix all non-dev projects share, never
 * shorter than its last segment (-Users-me-projects-acme-api → acme-api when -Users-me-projects- is shared).
 */
export function repoName(project: string, projects: readonly string[]): string {
  let prefix = projects.length ? (projects[0] as string) : project;
  for (const p of [...projects, project]) {
    let i = 0;
    while (i < prefix.length && i < p.length && prefix[i] === p[i]) i++;
    prefix = prefix.slice(0, i);
  }
  const cut = Math.min(prefix.lastIndexOf('-'), project.lastIndexOf('-'));
  const name = cut > 0 ? project.slice(cut + 1) : project.replace(/^-+/, '');
  return name || project;
}

/** claude-opus-5-5 → Opus 5.5; anything else as is. */
export function modelName(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(model);
  if (!m) return model;
  const family = m[1] as string;
  return `${family[0]?.toUpperCase()}${family.slice(1)} ${m[2]}.${m[3]}`;
}

// ---------------------------------------------------------------------------------------------- data

interface Pick {
  project: string;
  model: string;
}

/** The (repo, model) with the most tasks before and after ghx, by intent; ties by repo, then model. */
function pick(report: Report): { best: Pick | null; others: Pick[] } {
  const score = new Map<string, { pick: Pick; n: number; eligible: boolean }>();
  for (const c of report.comparisons) {
    if (c.view !== 'intent' || c.a !== BEFORE || c.b !== AFTER) continue;
    const k = `${c.project}\0${c.model}`;
    const s = score.get(k) ?? { pick: { project: c.project, model: c.model }, n: 0, eligible: false };
    s.n += c.n_a + c.n_b;
    s.eligible ||= c.eligible;
    score.set(k, s);
  }
  const ranked = [...score.values()].sort(
    (x, y) => y.n - x.n || cmp(x.pick.project, y.pick.project) || cmp(x.pick.model, y.pick.model),
  );
  const best = ranked[0]?.pick ?? null;
  return {
    best,
    others: ranked
      .slice(1)
      .filter((s) => s.eligible)
      .map((s) => s.pick),
  };
}

interface Ctx {
  report: Report;
  cells: Map<string, Cell>;
  comparisons: Map<string, Comparison>;
  pick: Pick;
}

function key(view: View, kind: string, category: string, context: Context, p: Pick, bucket: string): string {
  return [view, kind, category, context, p.project, p.model, bucket].join('|');
}

function sideOf(
  v: Ctx,
  view: View,
  kind: string,
  category: string,
  context: Context,
): { side: Side; a?: Cell; b?: Cell; c?: Comparison } {
  const a = v.cells.get(key(view, kind, category, context, v.pick, BEFORE));
  const b = v.cells.get(key(view, kind, category, context, v.pick, AFTER));
  const c = v.comparisons.get(`${key(view, kind, category, context, v.pick, BEFORE)}→${AFTER}`);
  const m = c?.metrics.cost_norm;
  const side: Side = {
    n_before: a?.n ?? 0,
    n_after: b?.n ?? 0,
    before: a?.metrics.cost_norm?.median ?? null,
    after: b?.metrics.cost_norm?.median ?? null,
    p: m?.test?.p ?? null,
    verdict: verdict(a?.n ?? 0, b?.n ?? 0, c ? m : undefined, v.report.stats.min_n),
  };
  return { side, ...(a ? { a } : {}), ...(b ? { b } : {}), ...(c ? { c } : {}) };
}

const clear = (m: ComparisonMetric | undefined): boolean => !!m?.test && m.test.p < ALPHA;

/** The ghx side's clear regressions for one task and context: failed commands, round trips, cost. */
function problemOf(v: Ctx, task: { id: string; label: string }, view: View, kind: string, context: Context) {
  const { a, b, c } = sideOf(v, view, kind, task.id, context);
  if (!a || !b || !c?.eligible) return null;
  const p: Omit<Problem, 'text'> = { task: task.id, context };
  const fa = a.metrics.errors?.nonzero;
  const fb = b.metrics.errors?.nonzero;
  if (clear(c.metrics.errors) && fa !== undefined && fb !== undefined && fb > fa) p.failed = { before: fa, after: fb };
  const rt = c.metrics.round_trips;
  if (clear(rt) && rt && rt.delta > 0) p.round_trips = { before: rt.a, after: rt.b };
  const cost = c.metrics.cost_norm;
  if (verdict(c.n_a, c.n_b, cost, v.report.stats.min_n) === 'worse' && cost) {
    p.cost = { before: cost.a, after: cost.b };
  }
  if (!p.failed && !p.round_trips && !p.cost) return null;
  return { ...p, text: problemText(task.label, p) };
}

const count = (p: Omit<Problem, 'text'>): number => (p.failed ? 1 : 0) + (p.round_trips ? 1 : 0) + (p.cost ? 1 : 0);
const rise = (x: { before: number; after: number } | undefined, ratio = false): number =>
  !x ? 0 : ratio ? (x.before > 0 ? x.after / x.before : Number.POSITIVE_INFINITY) : x.after - x.before;

/** Most clear regressions first, then the biggest rise in failed tasks, cost, round trips; then table order. */
function rankProblems(list: Problem[]): Problem[] {
  return list
    .map((p, i) => ({ p, i }))
    .sort(
      (x, y) =>
        count(y.p) - count(x.p) ||
        rise(y.p.failed) - rise(x.p.failed) ||
        rise(y.p.cost, true) - rise(x.p.cost, true) ||
        rise(y.p.round_trips, true) - rise(x.p.round_trips, true) ||
        x.i - y.i,
    )
    .map((x) => x.p);
}

function caveats(report: Report, compared: NonNullable<Summary['compared']>): string[] {
  const out: string[] = [];
  const held = (bucket: string, what: string): string | null => {
    const b = report.header.buckets.find((h) => h.bucket === bucket);
    if (!b || b.dominant.length === 0) return null;
    const share = pct(b.dominant.reduce((s, d) => s + d.share, 0));
    return `${b.dominant.length === 1 ? 'one session holds' : 'two sessions hold'} ${share} of all ${what}`;
  };
  const dominated = [held(AFTER, 'ghx tasks'), held(BEFORE, 'raw gh tasks')].filter((x) => x !== null);
  const thin = `ghx data here is ${plural(compared.sessions_after, 'session')}`;
  out.push(dominated.length ? `${thin}; across every repo, ${dominated.join(', and ')}.` : `${thin}.`);
  out.push('It compares the whole ghx setup (ghx, its hook, the CLAUDE.md block), not ghx alone.');
  return out;
}

/** The summary's data: the comparison it picked, a row per task, the biggest problems and the caveats. */
export function summarize(report: Report): Summary {
  const minN = report.stats.min_n;
  const refCtx = typeof report.constants.REF_CTX === 'number' ? report.constants.REF_CTX : 0;
  const { best, others } = pick(report);
  const dev = new Set(report.excluded.dev_projects.projects);
  const projects = [...new Set(report.cells.map((c) => c.project))].filter((p) => !dev.has(p)).sort(cmp);
  const repo = (p: string): string => repoName(p, projects);
  const empty: Summary = {
    compared: null,
    ref_ctx: refCtx,
    min_n: minN,
    rows: [],
    too_few: [],
    problems: { total: 0, shown: [] },
    caveats: [],
    others: [],
  };
  if (!best) return empty;
  const v: Ctx = {
    report,
    cells: new Map(report.cells.map((c) => [c.id, c])),
    comparisons: new Map(report.comparisons.map((c) => [c.id, c])),
    pick: best,
  };
  const sessions = (bucket: string): number => {
    const s = v.cells.get(key('unit', 'session', 'session', 'main', best, bucket));
    if (s) return s.n;
    let n = 0;
    for (const c of report.cells) {
      if (c.project === best.project && c.model === best.model && c.bucket === bucket) n = Math.max(n, c.n_sessions);
    }
    return n;
  };
  const intents = new Set<string>();
  for (const c of report.cells) {
    if (c.view === 'intent' && c.project === best.project && c.model === best.model && !HIDDEN.has(c.category)) {
      intents.add(c.category);
    }
  }
  const known = new Set(TASKS.map((t) => t.id));
  const tasks = [
    ...TASKS.filter((t) => intents.has(t.id)).map((t) => ({ ...t, view: 'intent' as View, kind: 'episode' })),
    ...[...intents]
      .filter((i) => !known.has(i))
      .sort(cmp)
      .map((i) => ({ id: i, label: i.replace(/_/g, ' '), view: 'intent' as View, kind: 'episode' })),
    { ...LIFECYCLE, view: 'created_merged' as View, kind: 'pr_lifecycle', category: 'pr' },
  ];
  const rows: Row[] = [];
  const tooFew: string[] = [];
  const problems: Problem[] = [];
  for (const t of tasks) {
    const category = 'category' in t ? t.category : t.id;
    const main = sideOf(v, t.view, t.kind, category, 'main');
    const sub = sideOf(v, t.view, t.kind, category, 'subagent');
    if (!main.c && !sub.c) continue;
    if (main.side.verdict === 'too few' && sub.side.verdict === 'too few') {
      tooFew.push(t.label);
      continue;
    }
    rows.push({ task: t.id, label: t.label, main: main.side, subagent: sub.side });
    for (const ctx of ['main', 'subagent'] as const) {
      const p = problemOf(v, { id: category, label: t.label }, t.view, t.kind, ctx);
      if (p) problems.push({ ...p, task: t.id });
    }
  }
  const ranked = rankProblems(problems);
  const compared = {
    project: best.project,
    repo: repo(best.project),
    model: best.model,
    model_name: modelName(best.model),
    sessions_before: sessions(BEFORE),
    sessions_after: sessions(AFTER),
  };
  return {
    compared,
    ref_ctx: refCtx,
    min_n: minN,
    rows,
    too_few: tooFew,
    problems: { total: ranked.length, shown: ranked.slice(0, MAX_PROBLEMS) },
    caveats: caveats(report, compared),
    others: others.map((o) => ({ project: o.project, repo: repo(o.project), model: o.model })),
  };
}

// ---------------------------------------------------------------------------------------------- text

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const num = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(1));

/** Dollars: cents from $1 up, a tenth of a cent below, so two medians that differ never print the same. */
export function usd(x: number): string {
  return Math.abs(x) >= 1 ? `$${x.toFixed(2)}` : `$${x.toFixed(3)}`;
}

function problemText(label: string, p: Omit<Problem, 'text'>): string {
  const parts: string[] = [];
  if (p.failed) parts.push(`${pct(p.failed.after)} hit a failed command (raw gh: ${pct(p.failed.before)})`);
  if (p.round_trips) {
    parts.push(`${num(p.round_trips.after)} API round trips (raw gh: ${num(p.round_trips.before)})`);
  }
  if (parts.length === 0 && p.cost) parts.push(`costs ${usd(p.cost.after)} (raw gh: ${usd(p.cost.before)})`);
  return `${label} (${CONTEXT_LABEL[p.context]}): ${parts.join('; ')}`;
}

function cellText(s: Side): string {
  if (s.verdict === 'too few') return 'too few';
  return `${usd(s.before as number)} → ${usd(s.after as number)}  ${s.verdict}`;
}

/** Lines of at most WIDTH columns: words after `first` wrap onto lines indented by `indent` spaces. */
export const WIDTH = 100;
export function wrap(first: string, text: string, indent: number): string[] {
  const out: string[] = [];
  let line = first;
  for (const word of text.split(' ')) {
    const blank = line.trim() === '' || line === first;
    if (!blank && line.length + 1 + word.length > WIDTH) {
      out.push(line);
      line = ' '.repeat(indent) + word;
    } else line += line === first || line.endsWith(' ') ? word : ` ${word}`;
  }
  out.push(line);
  return out;
}

const FULL_REPORT = 'Full report: pnpm eval   (pnpm eval --out DIR writes report.md and report.json)';

/** The one-screen summary for a report.json. A pure function of its argument. */
export function renderSummary(report: Report): string {
  const s = summarize(report);
  const lines = ['ghx vs raw gh on this machine'];
  const c = s.compared;
  if (!c) {
    lines.push('No repo has GitHub work both before and after it adopted ghx, so there is nothing to compare.');
    lines.push(FULL_REPORT);
    return `${lines.join('\n')}\n`;
  }
  lines.push(
    `Before ghx: ${plural(c.sessions_before, 'session')} · After ghx: ${plural(c.sessions_after, 'session')} ` +
      `(${c.repo}, ${c.model_name})`,
    '',
  );
  const head = ['Median cost per task', 'Main thread, before → after', 'Subagents, before → after'];
  const body = s.rows.map((r) => [r.label, cellText(r.main), cellText(r.subagent)]);
  const w0 = Math.max(...[head, ...body].map((r) => (r[0] as string).length)) + 3;
  const w1 = Math.max(...[head, ...body].map((r) => (r[1] as string).length)) + 4;
  for (const r of [head, ...body]) lines.push(`${(r[0] as string).padEnd(w0)}${(r[1] as string).padEnd(w1)}${r[2]}`);
  if (s.too_few.length) lines.push(...wrap('Too few tasks to compare: ', `${s.too_few.join('; ')}.`, 2));
  lines.push(
    `cost = API spend for one task, as if it started from a ${Math.round(s.ref_ctx / 1000)}k-token context.`,
    `better/worse = a clear difference; same = no clear change; too few = under ${s.min_n} tasks on a side.`,
    '',
  );
  const { total, shown } = s.problems;
  if (total === 0) lines.push('Biggest problems with ghx: none stand out clearly in this data.');
  else {
    lines.push(`Biggest problems with ghx${total > shown.length ? ` (${shown.length} of ${total})` : ''}:`);
    for (const p of shown) lines.push(...wrap('  - ', p.text, 4));
  }
  s.caveats.forEach((x, i) => {
    lines.push(...wrap(i === 0 ? 'Caveats: ' : '         ', x, 9));
  });
  if (s.others.length) {
    const names = s.others.map((o) => `${o.repo} (${modelName(o.model)})`).join(', ');
    lines.push(...wrap('Other repos with before/after data: ', `${names}; pnpm eval has them.`, 2));
  }
  lines.push(FULL_REPORT);
  return `${lines.join('\n')}\n`;
}

/** --summary --json: the summary's data, two-space indented, with a trailing newline. */
export function serializeSummary(report: Report): string {
  return `${JSON.stringify(summarize(report), null, 2)}\n`;
}
