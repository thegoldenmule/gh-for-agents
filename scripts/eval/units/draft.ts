// A unit before its metrics: the rows it covers. Shared by the episode, wait, PR and session builders; turns
// a draft into a Unit (span, model, bucket, metrics) the same way for every kind.
import type { CommandCli } from '../classify/command.ts';
import { computeMetrics, isGitHubCall } from '../metrics/catalog.ts';
import {
  type ApiCallRow,
  bucketOf,
  DEFAULT_ERA_CONFIG,
  type EraConfig,
  eraAt,
  type ToolCallRow,
} from '../model/session.ts';
import { callsUntilBoundary, type TableIndex } from './tables.ts';
import type { Context, Unit, UnitKind } from './types.ts';

export interface Draft {
  kind: UnitKind;
  unit_id: string;
  session_id: string;
  agent_id: string | null;
  context: Context;
  category: string;
  intent: string | null;
  pr: string | null;
  /**
   * Every PR the unit's GitHub calls name or are charged to (prototype pr_lifecycles charges per call), and
   * per call. A multi-PR unit joins each PR's lifecycle.
   */
  prs: string[];
  callPrs: Map<string, string[]>;
  flags: Set<string>;
  /** Tool calls, global table order. */
  calls: ToolCallRow[];
  /** API calls charged, one per message.id, table order. */
  span: ApiCallRow[];
  /** `${file}\u0000${call_index}` of each call a notification woke. */
  wake: Set<string>;
  start_ts: string | null;
  end_ts: string | null;
  children: string[];
  /** The unit this one follows from: an after-wake episode's wait. */
  parent?: string;
  rounds?: number;
}

export const byPos =
  (idx: TableIndex) =>
  (a: ToolCallRow, b: ToolCallRow): number =>
    (idx.pos.get(a.tool_use_id) ?? 0) - (idx.pos.get(b.tool_use_id) ?? 0);

function fileRank(idx: TableIndex): Map<string, number> {
  const m = new Map<string, number>();
  for (const [i, f] of idx.fileOrder.entries()) m.set(f, i);
  return m;
}
const rankCache = new WeakMap<TableIndex, Map<string, number>>();
export function sortCalls(idx: TableIndex, calls: Iterable<ApiCallRow>): ApiCallRow[] {
  let rank = rankCache.get(idx);
  if (!rank) {
    rank = fileRank(idx);
    rankCache.set(idx, rank);
  }
  const r = rank;
  const seen = new Map<string, ApiCallRow>();
  for (const c of calls) if (!seen.has(c.message_id)) seen.set(c.message_id, c);
  return [...seen.values()].sort((a, b) => (r.get(a.file) ?? 0) - (r.get(b.file) ?? 0) || a.call_index - b.call_index);
}

/**
 * Span of a set of tool calls: each call's emitting API call and the call that read its result, the call each
 * of its notifications woke, and with `fill` every call in between per file (a contiguous episode).
 */
export function spanOf(
  idx: TableIndex,
  calls: readonly ToolCallRow[],
  fill: boolean,
): { span: ApiCallRow[]; wake: Set<string> } {
  const at = new Map<string, Set<number>>();
  const wake = new Set<string>();
  const add = (file: string, i: number | null): void => {
    if (i === null) return;
    const s = at.get(file) ?? new Set<number>();
    s.add(i);
    at.set(file, s);
  };
  for (const t of calls) {
    add(t.file, t.call_index);
    add(t.file, t.next_call_index);
    if (t.background) {
      for (const w of t.notif_wake_call_indexes) {
        add(t.file, w);
        wake.add(`${t.file}\u0000${w}`);
      }
    }
  }
  const rows: ApiCallRow[] = [];
  for (const [file, set] of at) {
    const f = idx.files.get(file);
    if (!f) continue;
    const ixs = [...set].sort((a, b) => a - b);
    if (fill && ixs.length > 0) {
      const lo = ixs[0] as number;
      const hi = ixs.at(-1) as number;
      for (let i = lo; i <= hi; i++) {
        const c = f.calls.get(i);
        if (c) rows.push(c);
      }
    } else {
      for (const i of ixs) {
        const c = f.calls.get(i);
        if (c) rows.push(c);
      }
    }
  }
  return { span: sortCalls(idx, rows), wake };
}

/** gh, ghx or mixed over a unit's non-meta GitHub calls (meta-only units are ghx). */
export function unitCli(calls: readonly ToolCallRow[]): CommandCli | null {
  const gh = calls.filter(isGitHubCall);
  if (gh.length === 0) return null;
  const sides = new Set(gh.filter((t) => !t.meta_only).map((t) => t.cli));
  if (sides.size === 0) return 'ghx';
  if (sides.size === 1) return [...sides][0] as CommandCli;
  return 'mixed';
}

export function dominantModel(span: readonly ApiCallRow[]): string {
  const n = new Map<string, number>();
  for (const c of span) if (c.model) n.set(c.model, (n.get(c.model) ?? 0) + 1);
  let best = '';
  let bestN = 0;
  for (const [m, k] of [...n].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (k > bestN) {
      best = m;
      bestN = k;
    }
  }
  return best;
}

const tsMs = (s: string | null): number => (s ? Date.parse(s) : Number.NaN);

/** Earliest and latest of a set of timestamps (values only; structure never depends on them). */
export function tsRange(xs: Iterable<string | null>): { start: string | null; end: string | null } {
  let start: string | null = null;
  let end: string | null = null;
  for (const x of xs) {
    if (!x || Number.isNaN(tsMs(x))) continue;
    if (start === null || tsMs(x) < tsMs(start)) start = x;
    if (end === null || tsMs(x) > tsMs(end)) end = x;
  }
  return { start, end };
}

export interface FinalizeOptions {
  era?: EraConfig;
  session?: { api_calls: number; round_trips: number; tool_calls: number; cost: number; human_turns: number };
}

export function finalize(idx: TableIndex, d: Draft, opts: FinalizeOptions = {}): Unit {
  const s = idx.sessions.get(d.session_id);
  const project = s?.project ?? '';
  const start = d.start_ts ?? d.calls[0]?.call_ts ?? '';
  const end = d.end_ts ?? start;
  const era = eraAt(project, start || null, opts.era ?? DEFAULT_ERA_CONFIG);
  const bucket = bucketOf(era, unitCli(d.calls));
  let human = 0;
  if (opts.session) human = opts.session.human_turns;
  else {
    const a = tsMs(start);
    const b = tsMs(end);
    for (const t of idx.humanTurns.get(d.session_id) ?? []) {
      const x = tsMs(t.start_ts);
      if (x > a && x <= b) human++;
    }
  }
  const unit: Unit = {
    unit_id: d.unit_id,
    kind: d.kind,
    session_id: d.session_id,
    agent_id: d.agent_id,
    context: d.context,
    project,
    model: dominantModel(d.span),
    bucket,
    category: d.category,
    intent: d.intent,
    pr: d.pr,
    start_ts: start,
    end_ts: end,
    tool_use_ids: d.calls.map((t) => t.tool_use_id),
    flags: [...d.flags].sort(),
    metrics: {},
    children: d.children,
    parent_unit_id: d.parent ?? null,
    start_pos: d.calls.length > 0 ? Math.min(...d.calls.map((t) => idx.pos.get(t.tool_use_id) ?? 0)) : 0,
  };
  unit.metrics = computeMetrics(unit, {
    calls: d.calls,
    span: d.span,
    toolCallsOf: (m) => idx.byMessage.get(m) ?? [],
    apiCallAt: (file, i) => idx.files.get(file)?.calls.get(i),
    callsUntilBoundary: (file, i) => callsUntilBoundary(idx.files.get(file), i),
    wakeups: d.wake.size,
    human_turns: human,
    ...(d.children.length > 0 || d.kind === 'session' ? { children: d.children.length } : {}),
    ...(d.rounds !== undefined ? { rounds: d.rounds } : {}),
    ...(opts.session ? { session: opts.session } : {}),
  });
  return unit;
}
