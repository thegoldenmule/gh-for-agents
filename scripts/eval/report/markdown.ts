// report.md from report.json only (plan 07 M3): render() reads nothing but its argument, so a report.json
// re-renders to the same bytes anywhere. Tables mirror ghx-impact-findings §4.1–4.4 plus the plan's three
// "turns" numbers. Greyed cells (n < MIN_N) are marked ° and italic, carry no CI and never reach the summary.
import type { BucketHeader, Cell, Comparison, MetricSummary, Report } from './json.ts';

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

interface View {
  report: Report;
  unitOf: Map<string, string>;
  cells: Map<string, Cell>;
}

function view(report: Report): View {
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
  v: View,
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

const nOf = (cell: Cell | undefined): string => (cell ? `${cell.n}${cell.greyed ? GREY : ''}` : '0');
const arrow = (a: string, b: string): string => `${a} → ${b}`;

function pOf(c: Comparison | undefined, id: string): string {
  const t = c?.metrics[id]?.test;
  return t ? fmt(t.p, 'ratio') : '–';
}

/** Comparisons of a kind grouped by (project, model) for a pair, in report order. */
function comparisonGroups(
  report: Report,
  kinds: readonly string[],
  a: string,
  b: string,
): { project: string; model: string; comps: Comparison[] }[] {
  const out: { project: string; model: string; comps: Comparison[] }[] = [];
  for (const c of report.comparisons) {
    if (!kinds.includes(c.kind) || c.a !== a || c.b !== b) continue;
    let g = out.find((x) => x.project === c.project && x.model === c.model);
    if (!g) {
      g = { project: c.project, model: c.model, comps: [] };
      out.push(g);
    }
    g.comps.push(c);
  }
  return out.sort((x, y) => (x.project + x.model < y.project + y.model ? -1 : 1));
}

function cellFor(v: View, c: Comparison, bucket: string): Cell | undefined {
  return v.cells.get([c.kind, c.category, c.context, c.project, c.model, bucket].join('|'));
}

const label = (c: { kind: string; category: string }): string =>
  c.kind === 'episode' ? c.category : c.kind === 'wait' ? `wait: ${c.category}` : c.kind.replace('_', ' ');

// ---------------------------------------------------------------------------------------------- sections

function header(r: Report): string[] {
  const m = r.manifest;
  return [
    '# ghx-eval: GitHub work with ghx and with raw gh',
    '',
    `> ${r.header.statement}`,
    '',
    `Manifest \`${m.hash.slice(0, 12)}\` (snapshot ${m.createdAt}, ${group(m.files)} files, ${group(m.bytes)} bytes). ` +
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
      ? `**${b.dominant.length} session${b.dominant.length > 1 ? 's' : ''} hold ${pct(b.dominant.reduce((s, d) => s + d.share, 0))}**: ` +
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

function baseline(r: Report): string[] {
  const d = r.baseline;
  if (!d) return [];
  const lines = [
    '## Definition changes since the baseline',
    '',
    `Baseline manifest \`${d.manifest.slice(0, 12)}\`, METRIC_VERSION ${d.metric_version.from} → ${d.metric_version.to}.`,
    '',
  ];
  if (d.unversioned) lines.push('**Definitions changed but METRIC_VERSION did not.**', '');
  if (d.changes.length === 0) lines.push('No definition changes.', '');
  else lines.push(...d.changes.map((c) => `- \`${c.what}\`: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`), '');
  return lines;
}

function excluded(r: Report): string[] {
  const e = r.excluded;
  const dev = e.dev_projects;
  const om = e.outside_manifest;
  const pe = e.parse_errors;
  const dd = e.deduplicated;
  const kv = (o: Record<string, number>): string =>
    Object.keys(o).length
      ? Object.entries(o)
          .map(([k, n]) => `${k} ${n}`)
          .join(', ')
      : 'none';
  return [
    '## Excluded and deduplicated',
    '',
    `- \`<synthetic>\` records (API errors): ${e.synthetic_records}`,
    `- Dev projects (bucket dogfood-dev, never compared): ${dev.sessions} sessions, ${dev.units} units` +
      (dev.projects.length ? ` in ${dev.projects.map((p) => `\`${esc(p)}\``).join(', ')}` : ''),
    `- Outside the manifest: ${om.recent.files} files modified after the cutoff ${om.cutoff}, ` +
      `${om.unmatched.files} files matching no include pattern`,
    `- Parse errors: ${pe.lines} lines in ${pe.files} files, ${pe.json_files} unreadable .json files, ` +
      `${pe.partial_last_line.files} partial last lines (${pe.partial_last_line.bytes} bytes)`,
    `- Invalid records: ${kv(e.invalid_records)}; unknown record types: ${kv(e.unknown_record_types)}`,
    `- Files outside any session: ${e.files_outside_sessions}; unlinked agents: ${e.unlinked_agents}`,
    `- Deduplicated: ${dd.assistant_records} assistant records, ${dd.fork_copied_calls} fork-copied API calls, ` +
      `${dd.notification_sightings} repeated notification sightings`,
    '',
  ];
}

const HEADLINE = ['round_trips', 'tool_calls', 'cost_norm'];

function summary(v: View): string[] {
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
      return `${id.replace('_', ' ')} ${arrow(fmt(m.a, u), fmt(m.b, u))}${m.test ? ` (p ${fmt(m.test.p, 'ratio')})` : ''}`;
    });
    lines.push(
      `- **${label(c)}**, ${c.context}, \`${esc(c.project)}\`, ${c.model}, ${c.a} → ${c.b} (n ${c.n_a} → ${c.n_b}): ${parts.join('; ')}`,
    );
  }
  lines.push('');
  return lines;
}

function turns(v: View): string[] {
  const r = v.report;
  const rows: string[][] = [];
  for (const c of r.cells) {
    if (c.kind !== 'session' && c.kind !== 'pr_lifecycle' && c.kind !== 'wait') continue;
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

function byIntent(v: View): string[] {
  const out = [
    '## By intent (findings §4.1)',
    '',
    'Episodes, gh-pre → ghx-post, one table per repo and model; findings §4.1 pooled main and subagent, this ' +
      'splits them. Tool calls and result characters: median [95% CI] p90.',
    '',
  ];
  const groups = comparisonGroups(v.report, ['episode'], 'gh-pre', 'ghx-post');
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
        arrow(nonzeroOf(a, 'errors'), nonzeroOf(b, 'errors')),
        arrow(stat(v, a, 'wall_s', { p90: true }), stat(v, b, 'wall_s', { p90: true })),
      ];
    });
    out.push(
      ...table(
        ['intent', 'context', 'n gh / ghx', 'tool calls', 'p', 'result chars', 'with error', 'wall-clock s'],
        rows,
      ),
    );
  }
  return out;
}

function byUnit(v: View): string[] {
  const out = [
    '## By unit, split by context (findings §4.2)',
    '',
    'gh-pre → ghx-post. Round trips here are GitHub round trips (API calls emitting a gh/ghx call), the column ' +
      'findings §4.2 reports; cost_norm is the headline dollar figure. Medians [95% CI]; the rest are means per unit.',
    '',
  ];
  const groups = comparisonGroups(v.report, ['episode', 'pr_cycle', 'pr_lifecycle'], 'gh-pre', 'ghx-post');
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
        arrow(meanOf(a, 'errors'), meanOf(b, 'errors')),
        arrow(meanOf(a, 'refusals'), meanOf(b, 'refusals')),
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
          'errors',
          'refusals',
          'cache rewrites',
          'result tokens',
        ],
        rows,
      ),
    );
  }
  return out;
}

function waits(v: View): string[] {
  const rows: string[][] = [];
  for (const c of v.report.cells) {
    if (c.kind !== 'wait') continue;
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
    '## Waiting for CI, by mechanism (findings §4.3)',
    '',
    'Wait units per repo, model and bucket (findings §4.3 pooled all repos and models). cost_norm per wait: ' +
      'median [95% CI]; cache rewrites: mean per wait.',
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

const LIFECYCLE: { id: string; name: string; per?: number; unit?: string }[] = [
  { id: 'gh_tool_calls', name: 'GitHub calls' },
  { id: 'res_chars', name: 'Result chars' },
  { id: 'wakeups', name: 'Wakeups' },
  { id: 'rounds', name: 'CI rounds' },
  { id: 'wall_s', name: 'Elapsed (h)', per: 3600, unit: 'hours' },
  { id: 'round_trips', name: 'Round trips' },
  { id: 'cost_norm', name: 'cost_norm' },
];

function lifecycle(v: View): string[] {
  const out = [
    '## Whole PR lifecycle (findings §4.4)',
    '',
    'One session (with its subagents) and one PR, gh-pre vs ghx-post. Medians [95% CI].',
    '',
  ];
  const groups = comparisonGroups(v.report, ['pr_lifecycle'], 'gh-pre', 'ghx-post');
  if (groups.length === 0) out.push('_No repo has PR lifecycles on both sides._', '');
  for (const g of groups) {
    out.push(`### \`${esc(g.project)}\`, ${g.model}`, '');
    for (const c of g.comps) {
      const a = cellFor(v, c, c.a);
      const b = cellFor(v, c, c.b);
      const rows = LIFECYCLE.map((m) => {
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
    ...buckets(report),
    ...baseline(report),
    ...summary(v),
    ...turns(v),
    ...byIntent(v),
    ...byUnit(v),
    ...waits(v),
    ...lifecycle(v),
    ...excluded(report),
    ...definitions(report),
  ];
  while (lines.at(-1) === '') lines.pop();
  return `${lines.join('\n')}\n`;
}
