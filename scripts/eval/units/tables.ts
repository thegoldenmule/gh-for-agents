// Lookups over M1's tables that every unit builder shares. Built once per buildUnits call; every list keeps
// table order (sessions, then files by path, then file order), so nothing depends on Map insertion from the
// filesystem.
import type { ApiCallRow, SessionRow, Tables, ToolCallRow, TurnRow } from '../model/session.ts';

export interface FileIndex {
  file: string;
  session_id: string;
  agent_id: string | null;
  /** Tool calls in file order. */
  tools: ToolCallRow[];
  /** Owned API calls by call_index (copies owned by another file are absent). */
  calls: Map<number, ApiCallRow>;
  /** One past the largest call_index seen (copies count: call_index runs over them too). */
  nCalls: number;
  /** call_index of the first call after each compaction, ascending. */
  compactions: number[];
  /** call_index of the first API call of each human turn, ascending. */
  humanTurns: number[];
}

export interface TableIndex {
  tables: Tables;
  files: Map<string, FileIndex>;
  /** Files in table order. */
  fileOrder: string[];
  sessions: Map<string, SessionRow>;
  /** Global ordinal of each tool call in tables.tool_calls. */
  pos: Map<string, number>;
  toolById: Map<string, ToolCallRow>;
  byMessage: Map<string, ToolCallRow[]>;
  /** Human turns per session, table order. */
  humanTurns: Map<string, TurnRow[]>;
  apiCallsBySession: Map<string, ApiCallRow[]>;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const l = m.get(k);
  if (l) l.push(v);
  else m.set(k, [v]);
}

export function indexTables(tables: Tables): TableIndex {
  const files = new Map<string, FileIndex>();
  const fileOrder: string[] = [];
  const fileOf = (file: string, session_id: string, agent_id: string | null): FileIndex => {
    let f = files.get(file);
    if (!f) {
      f = { file, session_id, agent_id, tools: [], calls: new Map(), nCalls: 0, compactions: [], humanTurns: [] };
      files.set(file, f);
      fileOrder.push(file);
    }
    return f;
  };
  const firstCallOfTurn = new Map<string, ApiCallRow>();
  const apiCallsBySession = new Map<string, ApiCallRow[]>();
  for (const c of tables.api_calls) {
    const f = fileOf(c.file, c.session_id, c.agent_id);
    f.calls.set(c.call_index, c);
    f.nCalls = Math.max(f.nCalls, c.call_index + 1);
    if (c.after_compaction) f.compactions.push(c.call_index);
    if (c.turn_id !== null && !firstCallOfTurn.has(c.turn_id)) firstCallOfTurn.set(c.turn_id, c);
    push(apiCallsBySession, c.session_id, c);
  }
  const pos = new Map<string, number>();
  const toolById = new Map<string, ToolCallRow>();
  const byMessage = new Map<string, ToolCallRow[]>();
  for (const [i, t] of tables.tool_calls.entries()) {
    const f = fileOf(t.file, t.session_id, t.agent_id);
    f.tools.push(t);
    f.nCalls = Math.max(f.nCalls, t.call_index + 1);
    pos.set(t.tool_use_id, i);
    toolById.set(t.tool_use_id, t);
    push(byMessage, t.message_id, t);
  }
  const humanTurns = new Map<string, TurnRow[]>();
  for (const t of tables.turns) {
    if (!t.is_human) continue;
    push(humanTurns, t.session_id, t);
    const first = firstCallOfTurn.get(t.turn_id);
    if (first) files.get(first.file)?.humanTurns.push(first.call_index);
  }
  for (const f of files.values()) {
    f.compactions.sort((a, b) => a - b);
    f.humanTurns.sort((a, b) => a - b);
  }
  const sessions = new Map<string, SessionRow>();
  for (const s of tables.sessions) sessions.set(s.session_id, s);
  return { tables, files, fileOrder, sessions, pos, toolById, byMessage, humanTurns, apiCallsBySession };
}

/** True when some value v in the sorted list has lo < v ≤ hi. */
export function anyBetween(sorted: readonly number[], lo: number, hi: number): boolean {
  for (const v of sorted) {
    if (v > hi) return false;
    if (v > lo) return true;
  }
  return false;
}

/** API calls from `callIndex` (inclusive) up to the next compaction after it, or the end of the file. */
export function callsUntilBoundary(f: FileIndex | undefined, callIndex: number): number {
  if (!f) return 0;
  const next = f.compactions.find((k) => k > callIndex);
  return (next ?? f.nCalls) - callIndex;
}
