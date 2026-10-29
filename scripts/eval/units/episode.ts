// Intent episodes and background waits (findings §3), per transcript file: a port of segment() in
// docs/research/ghx-impact/episodes/episodes.py over M1's rows. Slack 0 reproduces the prototype, which
// closes an episode at the first non-glue tool call; ToolSearch is neutral. Launching a background wait
// leaves the current episode alone; a closed wait keeps its output-file reads until the next prompt.
// Structure comes from file order (call_index, then tool order); timestamps only measure the gap.
import { type Intent, intentRank } from '../classify/intent.ts';
import { isGitHubCall } from '../metrics/catalog.ts';
import type { ToolCallRow } from '../model/session.ts';
import { byPos, type Draft, spanOf, tsRange } from './draft.ts';
import { anyBetween, type FileIndex, type TableIndex } from './tables.ts';

export type RawKind = 'contiguous' | 'wait_bg';

export interface RawEpisode {
  kind: RawKind;
  file: string;
  /** GitHub calls, file order. */
  gh: ToolCallRow[];
  /** Glue calls, file order of attachment. */
  glue: ToolCallRow[];
  /** prompt, compact, gap, tool:<name>, eof; waits: notification:<status>, TaskStop, censored. */
  closed_by: string;
  start_ts: string | null;
  end_ts: string | null;
  /** A compaction happened while the wait was open. */
  compact_inside: boolean;
}

export interface SegmentOptions {
  slack: number;
  gapMs: number;
}

const BARE_SLEEP = /^\s*sleep\s+\d+\s*$/;
const GLUE_BASH =
  /^\s*(?:cd\s+\S+\s*(?:&&|;)\s*)?(?:sleep\s+\d+\s*(?:;|&&)?\s*)*(?:cat|head|tail|grep|rg|jq|wc|sed|awk|less|python3?\s+-c)\b/;

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const ms = (s: string | null): number | null => (s ? Date.parse(s) : null);

/** Files and task ids a contiguous episode's GitHub calls wrote or named (prototype ep_files). */
function episodeFiles(ep: RawEpisode): Set<string> {
  const s = new Set<string>();
  for (const c of ep.gh) {
    for (const r of c.glue?.redirects ?? []) s.add(r);
    for (const p of c.result_paths) s.add(basename(p));
    if (c.background_task_id) s.add(c.background_task_id);
  }
  s.delete('');
  return s;
}

/** A background GitHub call that starts its own wait unit. */
export function startsWait(t: ToolCallRow): boolean {
  return isGitHubCall(t) && t.background && t.intent === 'wait' && t.background_task_id !== null;
}

/** Index of the call the wait's terminal notification woke, or +∞ when it never ended (or nothing followed). */
function terminalAt(w: ToolCallRow): number {
  if (w.notif_ts === null) return Number.POSITIVE_INFINITY;
  return w.notif_wake_call_indexes.at(-1) ?? Number.POSITIVE_INFINITY;
}

export function segmentFile(f: FileIndex, opts: SegmentOptions): RawEpisode[] {
  const out: RawEpisode[] = [];
  let cur: RawEpisode | null = null;
  let pending: ToolCallRow[] = [];
  /** Open waits by task id, insertion order. */
  let waits = new Map<string, { ep: RawEpisode; launch: ToolCallRow }>();
  /** Closed waits whose output may still be read (until the next prompt). */
  let closed = new Map<string, RawEpisode>();
  let prevTool: ToolCallRow | null = null;
  let prevIndex = -1;

  const newEp = (kind: RawKind, t: ToolCallRow): RawEpisode => ({
    kind,
    file: f.file,
    gh: [],
    glue: [],
    closed_by: '',
    start_ts: t.call_ts,
    end_ts: t.result_ts ?? t.call_ts,
    compact_inside: false,
  });
  const close = (reason: string): void => {
    if (cur) {
      cur.closed_by = reason;
      out.push(cur);
    }
    cur = null;
    pending = [];
  };
  const finishWait = (tid: string, reason: string, end: string | null): void => {
    const w = waits.get(tid);
    if (!w) return;
    w.ep.closed_by = reason;
    if (end) w.ep.end_ts = end;
    out.push(w.ep);
    waits.delete(tid);
    closed.set(tid, w.ep);
  };

  for (const t of f.tools) {
    const at = t.call_index;
    // Terminal notifications that arrived before this call close their waits.
    for (const [tid, w] of [...waits]) {
      if (terminalAt(w.launch) <= at)
        finishWait(tid, `notification:${w.launch.notif_status ?? 'unknown'}`, w.launch.notif_ts);
    }
    if (anyBetween(f.compactions, prevIndex, at)) {
      close('compact');
      for (const w of waits.values()) w.ep.compact_inside = true;
    }
    if (anyBetween(f.humanTurns, prevIndex, at)) {
      close('prompt');
      closed = new Map();
    }
    const before = prevTool;
    prevTool = t;
    prevIndex = at;

    if (isGitHubCall(t)) {
      if (startsWait(t)) {
        const w = newEp('wait_bg', t);
        w.gh.push(t);
        waits.set(t.background_task_id as string, { ep: w, launch: t });
        continue;
      }
      const curEnd = cur ? ms((cur as RawEpisode).end_ts) : null;
      const start = ms(t.call_ts);
      if (cur && curEnd !== null && start !== null && start - curEnd > opts.gapMs) close('gap');
      const sendsFile =
        before !== null &&
        (before.name === 'Write' || before.name === 'Edit') &&
        before.file_path !== null &&
        (t.command ?? '').includes(basename(before.file_path));
      if (!cur) {
        cur = newEp('contiguous', t);
        if (sendsFile && before) {
          cur.glue.push(before);
          cur.start_ts = before.call_ts;
        }
      } else if (sendsFile && before && pending.includes(before)) {
        cur.glue.push(before);
      }
      pending = [];
      cur.gh.push(t);
      cur.end_ts = t.result_ts ?? t.call_ts;
      continue;
    }

    // Not a GitHub call: glue for a wait or the current episode, neutral, slack, or a boundary.
    const refs = `${t.file_path ?? ''} ${t.command ?? ''} ${t.task_ref ?? t.background_task_id ?? ''}`;
    let target: RawEpisode | null = null;
    let targetTask: string | null = null;
    for (const [tid, w] of waits) {
      if (refs.includes(tid)) {
        target = w.ep;
        targetTask = tid;
        break;
      }
    }
    if (!target) {
      for (const [tid, w] of closed) {
        if (refs.includes(tid)) {
          target = w;
          targetTask = tid;
          break;
        }
      }
    }
    if (!target && cur) {
      const files = episodeFiles(cur);
      if (t.name === 'Read') {
        if (files.has(basename(t.file_path ?? ''))) target = cur;
      } else if (t.name === 'Bash') {
        const cmd = t.command ?? '';
        if (BARE_SLEEP.test(cmd) || (GLUE_BASH.test(cmd) && [...files].some((x) => cmd.includes(x)))) target = cur;
      } else if (t.name === 'ToolSearch') {
        continue;
      }
    } else if (!target && t.name === 'ToolSearch') {
      continue;
    }
    if (target) {
      target.glue.push(t);
      const openWait = targetTask !== null && waits.get(targetTask)?.ep === target;
      if (!openWait) target.end_ts = t.result_ts ?? t.call_ts;
      if (openWait && t.name === 'TaskStop') finishWait(targetTask as string, 'TaskStop', t.result_ts ?? t.call_ts);
      continue;
    }
    if (cur && pending.length < opts.slack) {
      pending.push(t);
      continue;
    }
    close(`tool:${(pending[0] ?? t).name}`);
  }
  close('eof');
  for (const [tid, w] of [...waits]) {
    if (w.launch.notif_ts !== null)
      finishWait(tid, `notification:${w.launch.notif_status ?? 'unknown'}`, w.launch.notif_ts);
  }
  for (const w of waits.values()) {
    w.ep.closed_by = 'censored';
    out.push(w.ep);
  }
  waits = new Map();
  return out;
}

/** Highest-priority non-meta intent of the GitHub calls, 'meta' when there is none (prototype finish()). */
export function episodeIntent(gh: readonly ToolCallRow[]): string {
  const xs = gh.map((t) => t.intent).filter((i): i is Intent => i !== null && i !== 'meta');
  if (xs.length === 0) return 'meta';
  return xs.reduce((a, b) => (intentRank(b) < intentRank(a) ? b : a));
}

/** A contiguous episode as a draft (PR assigned later by pr.ts). */
export function episodeDraft(idx: TableIndex, f: FileIndex, ep: RawEpisode): Draft {
  const calls = [...ep.gh, ...ep.glue].sort(byPos(idx));
  const { span, wake } = spanOf(idx, calls, true);
  const intent = episodeIntent(ep.gh);
  const flags = new Set<string>([`closed:${ep.closed_by.split(':')[0] ?? ''}`]);
  if (ep.gh.length === 0) flags.add('continuation');
  const first = calls[0] as ToolCallRow;
  const range = tsRange(calls.flatMap((t) => [t.call_ts, t.result_ts]));
  return {
    kind: 'episode',
    unit_id: `episode:${first.tool_use_id}`,
    session_id: f.session_id,
    agent_id: f.agent_id,
    context: f.agent_id === null ? 'main' : 'subagent',
    category: intent,
    intent,
    pr: null,
    prs: [],
    callPrs: new Map(),
    flags,
    calls,
    span,
    wake,
    start_ts: range.start,
    end_ts: range.end,
    children: [],
  };
}
