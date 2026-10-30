// report.md from report.json only (plan 07): render() reads nothing but its argument, so a report.json
// renders to the same bytes anywhere. Greyed cells (n < MIN_N) are marked ° and italic, carry no CI and never
// reach the summary.
import type { BucketHeader, Cell, Comparison, MetricSummary, Report, View } from './json.ts';

const GREY = '°';

/** Thousands separators without locale data. */
function group(n: number): string {
  const s = Math.abs(n).toFixed(0);
  const out = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n < 0 ? `-${out}` : out;
}

function trim(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/** A number in the metric's unit: dollars to three decimals, large counts grouped, small ones to two decimals. */
export function fmt(x: number | null | undefined, unit = ''): string {
  if (x === null || x === undefined) return '–';
  if (unit === 'usd') return `$${x.toFixed(3)}`;
  if (unit === 'ratio') return x.toFixed(2);
  if (unit === 'hours') return trim(x.toFixed(2));
  if (Math.abs(x) >= 100) return group(Math.round(x));
  return trim(x.toFixed(2));
}

/** Dollars with thousands separators and cents. */
function usd(x: number): string {
  const [whole, cents] = x.toFixed(2).split('.');
  return `$${group(Number(whole))}.${cents}`;
}

const pct = (x: number | undefined): string => (x === undefined ? '–' : `${Math.round(x * 100)}%`);
const short = (s: string, n = 12): string => (s.length > n ? s.slice(0, n) : s);
const esc = (s: string): string => s.replace(/\|/g, '\\|');

function table(head: string[], rows: string[][]): string[] {
  if (rows.length === 0) return ['_No cells._', ''];
  return [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
    '',
  ];
}

interface Ctx {
  report: Report;
  unitOf: Map<string, string>;
  cells: Map<string, Cell>;
}

function view(report: Report): Ctx {
  return {
    report,
    unitOf: new Map(report.metrics.map((m) => [m.id, m.unit])),
    cells: new Map(report.cells.map((c) => [c.id, c])),
  };
}

function scale(x: number | undefined, by: number): number | undefined {
  return x === undefined ? undefined : x / by;
}

/** median [lo–hi] for a metric of a cell; italic with ° when the cell is greyed. */
function stat(
  v: Ctx,
  cell: Cell | undefined,
  id: string,
  opts: { p90?: boolean; per?: number; unit?: string } = {},
): string {
  const m: MetricSummary | undefined = cell?.metrics[id];
  if (!cell || !m) return '–';
  const unit = opts.unit ?? v.unitOf.get(id) ?? '';
  const per = opts.per ?? 1;
  let s = fmt(scale(m.median, per), unit);
  if (m.ci) s += ` [${fmt(scale(m.ci.median[0], per), unit)}–${fmt(scale(m.ci.median[1], per), unit)}]`;
  if (opts.p90) s += ` p90 ${fmt(scale(m.p90, per), unit)}`;
  return cell.greyed ? `_${s}_${GREY}` : s;
}

function meanOf(cell: Cell | undefined, id: string): string {
  const m = cell?.metrics[id];
  if (!cell || !m) return '–';
  const s = fmt(m.mean, 'ratio');
  return cell.greyed ? `_${s}_${GREY}` : s;
}

function nonzeroOf(cell: Cell | undefined, id: string): string {
  const m = cell?.metrics[id];
  if (!cell || !m) return '–';
  return cell.greyed ? `_${pct(m.nonzero)}_${GREY}` : pct(m.nonzero);
}

/** A share from a 0/1 or ratio metric's mean, as a percentage (first try, subagent share). */
function rateOf(cell: Cell | undefined, id: string): string {
  const m = cell?.metrics[id];
  if (!cell || !m) return '–';
  return cell.greyed ? `_${pct(m.mean)}_${GREY}` : pct(m.mean);
}

const nOf = (cell: Cell | undefined): string => (cell ? `${cell.n}${cell.greyed ? GREY : ''}` : '0');
const arrow = (a: string, b: string): string => `${a} → ${b}`;

export function fmtP(p: number): string {
  return p < 0.001 ? '<0.001' : p.toFixed(3);
}

function pOf(c: Comparison | undefined, id: string): string {
  const t = c?.metrics[id]?.test;
  return t ? fmtP(t.p) : '–';
}

/** Comparisons of a kind grouped by (project, model) for a pair, in report order. */
function comparisonGroups(
  report: Report,
  view: View,
  kinds: readonly string[],
  a: string,
  b: string,
): { project: string; model: string; comps: Comparison[] }[] {
  const out: { project: string; model: string; comps: Comparison[] }[] = [];
  for (const c of report.comparisons) {
    if (c.view !== view || !kinds.includes(c.kind) || c.a !== a || c.b !== b) continue;
    let g = out.find((x) => x.project === c.project && x.model === c.model);
    if (!g) {
      g = { project: c.project, model: c.model, comps: [] };
      out.push(g);
    }
    g.comps.push(c);
  }
  return out.sort((x, y) => (x.project + x.model < y.project + y.model ? -1 : 1));
}

function cellFor(v: Ctx, c: Comparison, bucket: string): Cell | undefined {
  return v.cells.get([c.view, c.kind, c.category, c.context, c.project, c.model, bucket].join('|'));
}

const label = (c: { view: View; kind: string; category: string }): string =>
  c.view === 'intent'
    ? `intent: ${c.category}`
    : c.view === 'created_merged'
      ? 'pr lifecycle (created + merged)'
      : c.kind === 'episode'
        ? c.category
        : c.kind === 'wait'
          ? `wait: ${c.category}`
          : c.kind.replace('_', ' ');

// ---------------------------------------------------------------------------------------------- sections

function header(r: Report): string[] {
  const c = r.corpus;
  return [
    '# ghx-eval: GitHub work with ghx and with raw gh',
    '',
    `> ${r.header.statement}`,
    '',
    `Read ${group(r.input.files)} session files (${group(r.input.bytes)} bytes): ${group(c.sessions)} sessions, ` +
      `${group(c.agents)} subagents, ${group(c.api_calls)} API calls, ${group(c.tool_calls)} tool calls ` +
      `(${Object.entries(c.github_tool_calls)
        .map(([k, n]) => `${group(n)} ${k}`)
        .join(', ')}), ${usd(c.cost_usd)} estimated cost.`,
    '',
    `METRIC_VERSION ${r.versions.metric}, prices ${r.versions.price_table}, ${r.versions.report}. ` +
      `Medians with ${Math.round(r.stats.ci_level * 100)}% CIs from a ${r.stats.bootstrap} ` +
      `(seed ${r.stats.seed}, B = ${r.stats.B}); quantiles by ${r.stats.quantile}; tests: Mann-Whitney U, ${r.stats.test}. ` +
      `Cells with n < ${r.stats.min_n} are marked ${GREY}, have no CI and stay out of the summary.`,
    '',
  ];
}

function buckets(r: Report): string[] {
  const rows = r.header.buckets.map((b: BucketHeader) => [
    b.bucket,
    group(b.units),
    group(b.sessions),
    b.dominant.length
      ? `**${b.dominant.length > 1 ? `${b.dominant.length} sessions hold` : '1 session holds'} ${pct(b.dominant.reduce((s, d) => s + d.share, 0))}**: ` +
        b.dominant.map((d) => `\`${short(d.session_id, 8)}\` (${esc(d.project)}, ${pct(d.share)})`).join(', ')
      : '–',
  ]);
  return [
    '## Buckets',
    '',
    'Atomic units (episodes and waits) per bucket. gh-pre and ghx-post are an adopted repo before and after ' +
      'adoption; gh-post is raw gh there after adoption; dogfood-dev is ghx’s own development; never-adopted is ' +
      'every other repo.',
    '',
    ...table(['bucket', 'units', 'sessions', 'dominant sessions'], rows),
  ];
}

function excluded(r: Report): string[] {
  const e = r.excluded;
  const dev = e.dev_projects;
  const pe = e.parse_errors;
  const dd = e.deduplicated;
  const kv = (o: Record<string, number>): string =>
    Object.keys(o).length
      ? Object.entries(o)
          .map(([k, n]) => `${k} ${n}`)
          .join(', ')
      : 'none';
  return [
    'Excluded and deduplicated:',
    '',
    `- \`<synthetic>\` records (API errors): ${group(e.synthetic_records)}`,
    `- Dev projects (bucket dogfood-dev, never compared): ${group(dev.sessions)} sessions, ${group(dev.units)} units` +
      (dev.projects.length ? ` in ${dev.projects.map((p) => `\`${esc(p)}\``).join(', ')}` : ''),
    `- Files not read (not a transcript, subagent meta or skill-fork file): ${group(e.unmatched_files)}`,
    `- Parse errors: ${pe.lines} lines in ${pe.files} files, ${pe.json_files} unreadable .json files, ` +
      `${pe.partial_last_line.files} partial last lines (${group(pe.partial_last_line.bytes)} bytes)`,
    `- Invalid records: ${kv(e.invalid_records)}; unknown record types: ${kv(e.unknown_record_types)}`,
    `- Files outside any session: ${e.files_outside_sessions}; unlinked agents: ${e.unlinked_agents}`,
    `- Deduplicated: ${group(dd.assistant_records)} assistant records, ${group(dd.fork_copied_calls)} fork-copied API calls, ` +
      `${group(dd.notification_sightings)} repeated notification sightings`,
    '',
  ];
}

const HEADLINE = ['round_trips', 'tool_calls', 'cost_norm'];

function summary(v: Ctx): string[] {
  const r = v.report;
  const lines = [
    '## Summary',
    '',
    `Comparisons with n ≥ ${r.stats.min_n} on both sides only. Medians; p from Mann-Whitney U.`,
    '',
  ];
  const eligible = r.comparisons.filter((c) => c.eligible);
  if (eligible.length === 0) lines.push(`No comparison has n ≥ ${r.stats.min_n} on both sides.`);
  for (const c of eligible) {
    const parts = HEADLINE.filter((id) => c.metrics[id]).map((id) => {
      const m = c.metrics[id] as Comparison['metrics'][string];
      const u = v.unitOf.get(id) ?? '';
      return `${id.replace('_', ' ')} ${arrow(fmt(m.a, u), fmt(m.b, u))}${m.test ? ` (p ${fmtP(m.test.p)})` : ''}`;
    });
    lines.push(
      `- **${label(c)}**, ${c.context}, \`${esc(c.project)}\`, ${c.model}, ${c.a} → ${c.b} (n ${c.n_a} → ${c.n_b}): ${parts.join('; ')}`,
    );
  }
  lines.push('');
  return lines;
}

function turns(v: Ctx): string[] {
  const r = v.report;
  const rows: string[][] = [];
  for (const c of r.cells) {
    if (c.view !== 'unit' || (c.kind !== 'session' && c.kind !== 'pr_lifecycle' && c.kind !== 'wait')) continue;
    rows.push([
      label(c),
      c.context,
      esc(c.project),
      c.model,
      c.bucket,
      nOf(c),
      stat(v, c, 'human_turns'),
      stat(v, c, 'round_trips'),
      stat(v, c, 'tool_calls'),
      stat(v, c, 'wakeups'),
    ]);
  }
  return [
    '## Turns',
    '',
    'Three numbers, because they measure different costs: human turns (prompts a person typed), round trips ' +
      '(API calls that emitted one of the unit’s tool calls) and tool calls (GitHub plus glue). Wakeups ' +
      '(notifications that started or fed a call) sit beside them for waits. Medians [95% CI].',
    '',
    ...table(
      ['unit', 'context', 'repo', 'model', 'bucket', 'n', 'human turns', 'round trips', 'tool calls', 'wakeups'],
      rows,
    ),
  ];
}

function byIntent(v: Ctx): string[] {
  const out = [
    '## By intent',
    '',
    'Episodes and background waits by intent (derived waits excluded), gh-pre → ghx-post, one table per repo ' +
      'and model. Tool calls and result characters: median [95% CI] p90. First try: the share of tasks with no ' +
      'mistake or denial up to their first call of the intent; with a mistake: the share with any agent mistake.',
    '',
  ];
  const groups = comparisonGroups(v.report, 'intent', ['episode'], 'gh-pre', 'ghx-post');
  if (groups.length === 0) out.push('_No repo has episodes on both sides._', '');
  for (const g of groups) {
    out.push(`### \`${esc(g.project)}\`, ${g.model}`, '');
    const rows = g.comps.map((c) => {
      const a = cellFor(v, c, c.a);
      const b = cellFor(v, c, c.b);
      return [
        c.category,
        c.context,
        `${nOf(a)} / ${nOf(b)}`,
        arrow(stat(v, a, 'tool_calls', { p90: true }), stat(v, b, 'tool_calls', { p90: true })),
        pOf(c, 'tool_calls'),
        arrow(stat(v, a, 'res_chars', { p90: true }), stat(v, b, 'res_chars', { p90: true })),
        arrow(rateOf(a, 'first_try'), rateOf(b, 'first_try')),
        pOf(c, 'first_try'),
        arrow(nonzeroOf(a, 'mistakes'), nonzeroOf(b, 'mistakes')),
        arrow(stat(v, a, 'wall_s', { p90: true }), stat(v, b, 'wall_s', { p90: true })),
      ];
    });
    out.push(
      ...table(
        [
          'intent',
          'context',
          'n gh / ghx',
          'tool calls',
          'p',
          'result chars',
          'first try',
          'p',
          'with a mistake',
          'wall-clock s',
        ],
        rows,
      ),
    );
  }
  return out;
}

function byUnit(v: Ctx): string[] {
  const out = [
    '## By unit, split by context',
    '',
    'gh-pre → ghx-post. Round trips here are GitHub round trips (API calls emitting a gh/ghx call); cost_norm is ' +
      'the headline dollar figure. Medians [95% CI]; the rest are means per unit. Failed GitHub calls split three ' +
      'ways: mistakes (the agent’s), outcomes (CI or PR state, GitHub) and denials (hook, permission, policy).',
    '',
  ];
  const groups = comparisonGroups(v.report, 'unit', ['episode', 'pr_cycle', 'pr_lifecycle'], 'gh-pre', 'ghx-post');
  if (groups.length === 0) out.push('_No repo has units on both sides._', '');
  for (const g of groups) {
    out.push(`### \`${esc(g.project)}\`, ${g.model}`, '');
    const rows = g.comps.map((c) => {
      const a = cellFor(v, c, c.a);
      const b = cellFor(v, c, c.b);
      return [
        label(c),
        c.context,
        `${nOf(a)} / ${nOf(b)}`,
        arrow(stat(v, a, 'gh_round_trips'), stat(v, b, 'gh_round_trips')),
        arrow(stat(v, a, 'cost_norm'), stat(v, b, 'cost_norm')),
        pOf(c, 'cost_norm'),
        arrow(meanOf(a, 'pipes'), meanOf(b, 'pipes')),
        arrow(meanOf(a, 'mistakes'), meanOf(b, 'mistakes')),
        arrow(meanOf(a, 'outcomes'), meanOf(b, 'outcomes')),
        arrow(meanOf(a, 'denials'), meanOf(b, 'denials')),
        arrow(meanOf(a, 'cache_rewrites'), meanOf(b, 'cache_rewrites')),
        arrow(stat(v, a, 'res_tok_est'), stat(v, b, 'res_tok_est')),
      ];
    });
    out.push(
      ...table(
        [
          'unit',
          'context',
          'n gh / ghx',
          'GitHub round trips',
          'cost_norm',
          'p',
          'pipes',
          'mistakes',
          'outcomes',
          'denials',
          'cache rewrites',
          'result tokens',
        ],
        rows,
      ),
    );
  }
  return out;
}

function waits(v: Ctx): string[] {
  const rows: string[][] = [];
  for (const c of v.report.cells) {
    if (c.view !== 'unit' || c.kind !== 'wait') continue;
    rows.push([
      c.category,
      c.context,
      esc(c.project),
      c.model,
      c.bucket,
      nOf(c),
      stat(v, c, 'cost_norm'),
      meanOf(c, 'cache_rewrites'),
      stat(v, c, 'round_trips'),
      stat(v, c, 'wakeups'),
      stat(v, c, 'span_calls'),
    ]);
  }
  return [
    '## Waiting for CI, by mechanism',
    '',
    'Wait units per repo, model and bucket. cost_norm per wait: median [95% CI]; cache rewrites: mean per wait.',
    '',
    ...table(
      [
        'mechanism',
        'context',
        'repo',
        'model',
        'bucket',
        'n',
        'cost_norm',
        'cache rewrites',
        'round trips',
        'wakeups',
        'span calls',
      ],
      rows,
    ),
  ];
}

const LIFECYCLE: { id: string; name: string; per?: number; unit?: string; share?: 'mean' | 'nonzero' }[] = [
  { id: 'first_try', name: 'No mistake or denial (share)', share: 'mean' },
  { id: 'mistakes', name: 'With an agent mistake (share)', share: 'nonzero' },
  { id: 'subagent_share', name: 'Round trips in subagents (mean)', share: 'mean' },
  { id: 'gh_tool_calls', name: 'GitHub calls' },
  { id: 'res_chars', name: 'Result chars' },
  { id: 'wakeups', name: 'Wakeups' },
  { id: 'rounds', name: 'CI rounds' },
  { id: 'wall_s', name: 'Elapsed (h)', per: 3600, unit: 'hours' },
  { id: 'round_trips', name: 'Round trips' },
  { id: 'cost_norm', name: 'cost_norm' },
];

function lifecycle(v: Ctx): string[] {
  const out = [
    '## Whole PR lifecycle',
    '',
    'One session (with its subagents) and one PR, created and merged in that session; gh-pre vs ghx-post. ' +
      'A lifecycle is filed under main when any of its work ran in the main thread; the subagent row says how ' +
      'much of it ran in subagents. Medians [95% CI] unless a row says share or mean.',
    '',
  ];
  const groups = comparisonGroups(v.report, 'created_merged', ['pr_lifecycle'], 'gh-pre', 'ghx-post');
  if (groups.length === 0) out.push('_No repo has PR lifecycles on both sides._', '');
  for (const g of groups) {
    out.push(`### \`${esc(g.project)}\`, ${g.model}`, '');
    for (const c of g.comps) {
      const a = cellFor(v, c, c.a);
      const b = cellFor(v, c, c.b);
      const rows = LIFECYCLE.map((m) => {
        if (m.share) {
          const f = m.share === 'mean' ? rateOf : nonzeroOf;
          return [m.name, f(a, m.id), f(b, m.id), pOf(c, m.id)];
        }
        const o = { ...(m.per ? { per: m.per } : {}), ...(m.unit ? { unit: m.unit } : {}) };
        return [m.name, stat(v, a, m.id, o), stat(v, b, m.id, o), pOf(c, m.id)];
      });
      out.push(`${c.context}:`, '', ...table(['', `raw gh (${nOf(a)})`, `ghx (${nOf(b)})`, 'p'], rows));
    }
  }
  return out;
}

function definitions(r: Report): string[] {
  const rows = r.metrics.map((m) => [
    `\`${m.id}\``,
    m.unit,
    m.robustness,
    m.applies_to.join(', '),
    esc(m.description),
    esc(m.formula),
  ]);
  const constants = Object.entries(r.constants).map(([k, x]) => `\`${k}\` = ${JSON.stringify(x)}`);
  const prices = Object.entries(r.price_table.usdPerMTok).map(
    ([k, p]) => `${k} $${p.input} / $${p.output} / $${p.cacheRead}`,
  );
  return [
    '## Definitions',
    '',
    `Constants: ${constants.join(', ')}.`,
    '',
    `Prices ${r.price_table.version} (USD per MTok, input / output / cache read; cache writes ` +
      `${r.price_table.cacheWriteMultiplier['5m']}× input for 5m, ${r.price_table.cacheWriteMultiplier['1h']}× for 1h): ${prices.join('; ')}.`,
    '',
    ...table(['metric', 'unit', 'robustness', 'applies to', 'description', 'formula'], rows),
  ];
}

/** report.md for a report.json. A pure function of its argument. */
export function render(report: Report): string {
  const v = view(report);
  const lines = [
    ...header(report),
    ...excluded(report),
    ...buckets(report),
    ...summary(v),
    ...turns(v),
    ...byIntent(v),
    ...byUnit(v),
    ...waits(v),
    ...lifecycle(v),
    ...definitions(report),
  ];
  while (lines.at(-1) === '') lines.pop();
  return `${lines.join('\n')}\n`;
}
