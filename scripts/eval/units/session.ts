// Session units (plan 07 "Units" 4): GitHub's share of a session's API calls and cost. Too few pure-ghx
// sessions exist for an arm comparison, so the report shows these shares by era. The span is the union of the
// session's episode and wait spans, so a call two units share counts once.
import type { Draft } from './draft.ts';
import { sortCalls } from './draft.ts';
import type { TableIndex } from './tables.ts';

export function sessionDrafts(idx: TableIndex, atoms: readonly Draft[]): Draft[] {
  const by = new Map<string, Draft[]>();
  for (const d of atoms) {
    if (d.flags.has('derived')) continue;
    const l = by.get(d.session_id);
    if (l) l.push(d);
    else by.set(d.session_id, [d]);
  }
  const out: Draft[] = [];
  for (const s of idx.tables.sessions) {
    const ds = by.get(s.session_id);
    if (!ds) continue;
    const calls = [...new Map(ds.flatMap((d) => d.calls).map((t) => [t.tool_use_id, t])).values()].sort(
      (a, b) => (idx.pos.get(a.tool_use_id) ?? 0) - (idx.pos.get(b.tool_use_id) ?? 0),
    );
    out.push({
      kind: 'session',
      unit_id: `session:${s.session_id}`,
      session_id: s.session_id,
      agent_id: null,
      context: 'main',
      category: 'session',
      intent: null,
      pr: null,
      prs: [],
      callPrs: new Map(),
      flags: new Set(s.has_main_file ? [] : ['no-main-file']),
      calls,
      span: sortCalls(
        idx,
        ds.flatMap((d) => d.span),
      ),
      wake: new Set(ds.flatMap((d) => [...d.wake])),
      start_ts: s.first_ts,
      end_ts: s.last_ts,
      children: ds.map((d) => d.unit_id),
    });
  }
  return out;
}
