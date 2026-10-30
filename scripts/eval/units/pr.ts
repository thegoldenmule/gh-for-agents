// PR attribution, PR cycles and PR lifecycles (plan 07 "Units" 2–3, findings §3).
//
// A GitHub call names a PR through its arguments (`pr <verb> 123`, `#123`, `.../pull/123`, `api .../pulls/123`)
// or, for a create, through the URL in its output. A create that names none (a failed or dry-run attempt) is
// the PR the next create in its file produced, unless their --head flags differ ('create-forward'). A unit's
// PR is the last one its calls name (flag 'multi-pr' when several); a call that names none takes its unit's
// PR, and a unit that names none is charged to the PR its file last named ('charged-to-last-pr'), unless all
// it did was unrelated reads, creates whose PR never showed up, or waits on the main branch's CI, which belong
// to no PR. Cycles split one context's waits and status reads on a PR by head SHA; with no SHA in sight they
// split at `git push` ('sha-fallback'). A lifecycle is one session (with its subagents) and one PR.
import { classifyCommand, flagValue } from '../classify/command.ts';
import { isGitHubCall, MAIN_CI } from '../metrics/catalog.ts';
import type { ToolCallRow } from '../model/session.ts';
import { byPos, type Draft, sortCalls, tsRange } from './draft.ts';
import type { TableIndex } from './tables.ts';

export interface PrRef {
  repo: string | null;
  number: number;
}

const PULL_URL = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/;
const API_PR = /(?:repos\/([\w.-]+)\/([\w.-]+)\/)?(?:pulls|issues)\/(\d+)/;
const PR_WORD = /(?:^|#|pull\/)(\d{2,6})$/;
export const PUSH_RE = /\bgit\s+(?:-C\s+\S+\s+)?push\b/;

/** PRs a GitHub call names (prototype pr_numbers, plus the repo when the call gives one). */
export function prsOfCall(t: ToolCallRow): PrRef[] {
  if (t.command === null || !isGitHubCall(t)) return [];
  const out: PrRef[] = [];
  for (const inv of classifyCommand(t.command).invocations) {
    const pos = inv.positional;
    const repoFlag = flagValue(inv.args, '-R', '--repo') || null;
    if (pos[0] === 'pr' || pos[0] === 'ci') {
      for (const w of pos.slice(2)) {
        const url = PULL_URL.exec(w);
        if (url) {
          out.push({ repo: `${url[1]}/${url[2]}`, number: Number(url[3]) });
          continue;
        }
        const m = PR_WORD.exec(w);
        if (m) out.push({ repo: repoFlag, number: Number(m[1]) });
      }
    } else if (pos[0] === 'api') {
      for (const w of pos.slice(1)) {
        const m = API_PR.exec(w);
        if (m) out.push({ repo: m[1] && m[2] ? `${m[1]}/${m[2]}` : repoFlag, number: Number(m[3]) });
      }
    }
  }
  if (out.length === 0 && t.intents.includes('create')) {
    const ref = t.result_pr_refs[0];
    const m = ref ? /^(.+)#(\d+)$/.exec(ref) : null;
    if (m) out.push({ repo: m[1] as string, number: Number(m[2]) });
  }
  return out;
}

const MAIN_BRANCH = /^branch:(?:main|master)(?:@.*)?$/;

/** A wait on the default branch's CI (`ghx ci wait branch:main@sha`, after a merge): no PR's work. */
export function isMainBranchWait(t: ToolCallRow): boolean {
  if (t.command === null || !t.intents.includes('wait') || !isGitHubCall(t)) return false;
  const invs = classifyCommand(t.command).invocations;
  return prsOfCall(t).length === 0 && invs.some((i) => i.positional.some((w) => MAIN_BRANCH.test(w)));
}

/** Relabel units whose waits are all on the main branch's CI: intent (and an episode's category) MAIN_CI. */
export function labelMainBranchWaits(drafts: readonly Draft[]): void {
  for (const d of drafts) {
    if (d.intent !== 'wait') continue;
    const waits = d.calls.filter((t) => isGitHubCall(t) && t.intents.includes('wait'));
    if (waits.length === 0 || !waits.every(isMainBranchWait)) continue;
    d.intent = MAIN_CI;
    if (d.kind === 'episode') d.category = MAIN_CI;
  }
}

const headOf = (t: ToolCallRow): string => {
  for (const inv of classifyCommand(t.command ?? '').invocations) {
    const h = flagValue(inv.args, '--head', '-H');
    if (h) return h;
  }
  return '';
};

/**
 * Creates that name no PR (a failed or dry-run attempt), mapped to the PR the next create in the same file
 * produced. A later create with a different --head is another PR's and is skipped.
 */
function forwardCreates(ordered: readonly ToolCallRow[], named: ReadonlyMap<string, string[]>): Map<string, string> {
  const out = new Map<string, string>();
  const byFile = new Map<string, ToolCallRow[]>();
  for (const t of ordered) {
    if (!t.intents.includes('create')) continue;
    const l = byFile.get(t.file);
    if (l) l.push(t);
    else byFile.set(t.file, [t]);
  }
  for (const creates of byFile.values()) {
    for (const [i, t] of creates.entries()) {
      if ((named.get(t.tool_use_id) ?? []).length > 0) continue;
      const head = headOf(t);
      for (const later of creates.slice(i + 1)) {
        const pr = named.get(later.tool_use_id)?.at(-1);
        if (pr === undefined) continue;
        const h = headOf(later);
        if (head !== '' && h !== '' && head !== h) continue;
        out.set(t.tool_use_id, pr);
        break;
      }
    }
  }
  return out;
}

/** The session's own repo: most often named by its pr-link records and PR URLs in results (ties by name). */
export function sessionRepo(idx: TableIndex, sessionId: string, calls: readonly ToolCallRow[]): string | null {
  const n = new Map<string, number>();
  const bump = (r: string | null): void => {
    if (r) n.set(r, (n.get(r) ?? 0) + 1);
  };
  for (const l of idx.sessions.get(sessionId)?.pr_links ?? []) bump(l.repo);
  for (const t of calls) for (const r of t.result_pr_refs) bump(r.replace(/#\d+$/, ''));
  let best: string | null = null;
  let bestN = 0;
  for (const [r, k] of [...n].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (k > bestN) {
      best = r;
      bestN = k;
    }
  }
  return best;
}

const fmt = (r: PrRef, repo: string | null): string => `${r.repo ?? repo ?? ''}#${r.number}`;

/** Set `pr` and the PR flags on episode and background-wait drafts, file by file in file order. */
export function assignPrs(idx: TableIndex, drafts: readonly Draft[]): void {
  const bySession = new Map<string, Draft[]>();
  for (const d of drafts) {
    const l = bySession.get(d.session_id);
    if (l) l.push(d);
    else bySession.set(d.session_id, [d]);
  }
  for (const [sessionId, ds] of bySession) {
    const calls = ds.flatMap((d) => d.calls);
    const repo = sessionRepo(idx, sessionId, calls);
    const ordered = calls.filter(isGitHubCall).sort(byPos(idx));
    // The PR each GitHub call names, and the last PR named before it in its file.
    const named = new Map<string, string[]>();
    for (const t of ordered)
      named.set(
        t.tool_use_id,
        prsOfCall(t).map((r) => fmt(r, repo)),
      );
    const forward = forwardCreates(ordered, named);
    for (const [id, pr] of forward) named.set(id, [pr]);
    const lastBefore = new Map<string, string | null>();
    const last = new Map<string, string>();
    for (const t of ordered) {
      lastBefore.set(t.tool_use_id, last.get(t.file) ?? null);
      const tail = forward.has(t.tool_use_id) ? undefined : named.get(t.tool_use_id)?.at(-1);
      if (tail !== undefined) last.set(t.file, tail);
    }
    for (const d of ds) {
      const gh = d.calls.filter(isGitHubCall);
      if (gh.some((t) => forward.has(t.tool_use_id))) d.flags.add('create-forward');
      const prs = [...new Set(gh.flatMap((t) => named.get(t.tool_use_id) ?? []))];
      // Unrelated: reads of other things, main-branch waits, and creates whose PR never showed up (another
      // PR's attempt is never charged to the PR the file named last).
      const unrelated = (t: ToolCallRow): boolean =>
        t.intent === 'other_read' ||
        isMainBranchWait(t) ||
        (t.intents.includes('create') && (named.get(t.tool_use_id) ?? []).length === 0);
      let pr: string | null = prs.at(-1) ?? null;
      if (prs.length > 1) d.flags.add('multi-pr');
      if (pr === null && !gh.every(unrelated)) {
        pr = lastBefore.get((gh.find((t) => !unrelated(t)) as ToolCallRow).tool_use_id) ?? null;
        if (pr !== null) d.flags.add('charged-to-last-pr');
      }
      d.pr = pr;
      // A call naming no PR takes its unit's PR; unrelated reads and main-branch waits take none.
      for (const t of gh) {
        const own = named.get(t.tool_use_id) ?? [];
        d.callPrs.set(t.tool_use_id, own.length > 0 ? own : unrelated(t) || pr === null ? [] : [pr]);
      }
      d.prs = [...new Set(gh.flatMap((t) => d.callPrs.get(t.tool_use_id) ?? []))];
    }
  }
}

const shaKey = (s: string): string => s.slice(0, 7);

/** First head SHA a unit's calls saw, normalised to 7 characters. */
export function observedSha(d: Draft): string | null {
  for (const t of d.calls) {
    const s = t.result_head_shas[0];
    if (s) return shaKey(s);
  }
  return null;
}

function union(idx: TableIndex, id: string, base: Draft, children: readonly Draft[]): Draft {
  const calls = [...new Map(children.flatMap((c) => c.calls).map((t) => [t.tool_use_id, t])).values()].sort(byPos(idx));
  const flags = new Set<string>();
  for (const c of children) {
    for (const f of c.flags) if (f === 'multi-pr' || f === 'charged-to-last-pr' || f === 'create-forward') flags.add(f);
  }
  const { start } = tsRange(children.map((c) => c.start_ts));
  const { end } = tsRange(children.map((c) => c.end_ts));
  return {
    ...base,
    unit_id: id,
    category: 'pr',
    intent: null,
    flags,
    calls,
    span: sortCalls(
      idx,
      children.flatMap((c) => c.span),
    ),
    wake: new Set(children.flatMap((c) => [...c.wake])),
    start_ts: start,
    end_ts: end,
    children: children.map((c) => c.unit_id),
  };
}

const CYCLE_INTENTS = new Set(['wait', 'status']);

/**
 * PR cycles: per (session, context file, PR), the waits and status reads between two head SHAs. A unit that
 * sees no SHA belongs to the cycle of the last SHA seen before it (units before the first SHA join the first).
 */
export function buildCycles(idx: TableIndex, atoms: readonly Draft[]): Draft[] {
  const groups = new Map<string, Draft[]>();
  for (const d of atoms) {
    if (d.pr === null || d.intent === null || !CYCLE_INTENTS.has(d.intent) || d.flags.has('derived')) continue;
    const file = d.calls[0]?.file ?? '';
    const k = `${d.session_id}\u0000${file}\u0000${d.pr}`;
    const l = groups.get(k);
    if (l) l.push(d);
    else groups.set(k, [d]);
  }
  const out: Draft[] = [];
  for (const k of [...groups.keys()].sort()) {
    const ds = (groups.get(k) as Draft[]).sort(
      (a, b) => (idx.pos.get(a.calls[0]?.tool_use_id ?? '') ?? 0) - (idx.pos.get(b.calls[0]?.tool_use_id ?? '') ?? 0),
    );
    const first = ds[0] as Draft;
    const shas = ds.map(observedSha);
    const fallback = shas.every((s) => s === null);
    const keys: string[] = [];
    if (fallback) {
      const file = idx.files.get(first.calls[0]?.file ?? '');
      const pushes = (file?.tools ?? [])
        .filter((t) => t.name === 'Bash' && PUSH_RE.test(t.command ?? ''))
        .map((t) => idx.pos.get(t.tool_use_id) ?? 0);
      for (const d of ds) {
        const at = idx.pos.get(d.calls[0]?.tool_use_id ?? '') ?? 0;
        keys.push(`push${pushes.filter((p) => p < at).length}`);
      }
    } else {
      let cur = shas.find((s) => s !== null) as string;
      for (const s of shas) {
        if (s !== null) cur = s;
        keys.push(cur);
      }
    }
    const used = new Map<string, number>();
    let start = 0;
    for (let i = 1; i <= ds.length; i++) {
      if (i < ds.length && keys[i] === keys[start]) continue;
      const key = keys[start] as string;
      const n = used.get(key) ?? 0;
      used.set(key, n + 1);
      const children = ds.slice(start, i);
      const id = `pr_cycle:${first.session_id}:${first.agent_id ?? 'main'}:${first.pr}:${key}${n > 0 ? `:${n}` : ''}`;
      const c = union(idx, id, { ...first, kind: 'pr_cycle' }, children);
      if (fallback) c.flags.add('sha-fallback');
      c.rounds = 1;
      out.push(c);
      start = i;
    }
  }
  return out;
}

/** Created: a create call on the PR. Merged: a merge call on the PR that exited 0 with no ghx error. */
function lifecycleFlags(calls: readonly ToolCallRow[]): string[] {
  const out: string[] = [];
  if (calls.some((t) => t.intents.includes('create'))) out.push('created');
  if (
    calls.some(
      (t) => t.intents.includes('merge') && (t.effective_exit ?? t.exit_code) === 0 && t.ghx_error_code === null,
    )
  ) {
    out.push('merged');
  }
  return out;
}

/**
 * PR lifecycles: per (session, PR), every episode and background wait on the PR across the main thread and
 * subagents. Rounds count distinct head SHAs seen; with none, 1 + git pushes in the session during the
 * lifecycle ('sha-fallback').
 */
export function buildLifecycles(idx: TableIndex, atoms: readonly Draft[]): Draft[] {
  const groups = new Map<string, Draft[]>();
  for (const d of atoms) {
    if (d.flags.has('derived')) continue;
    for (const pr of d.prs) {
      const k = `${d.session_id}\u0000${pr}`;
      const l = groups.get(k);
      if (l) l.push(d);
      else groups.set(k, [d]);
    }
  }
  const pushes = new Map<string, number[]>();
  for (const t of idx.tables.tool_calls) {
    if (t.name !== 'Bash' || !PUSH_RE.test(t.command ?? '')) continue;
    const l = pushes.get(t.session_id) ?? [];
    l.push(Date.parse(t.call_ts ?? ''));
    pushes.set(t.session_id, l);
  }
  const out: Draft[] = [];
  for (const k of [...groups.keys()].sort()) {
    const ds = groups.get(k) as Draft[];
    const first = ds[0] as Draft;
    const pr = k.slice(k.indexOf('\u0000') + 1);
    const contexts = new Set(ds.map((d) => d.context));
    const u = union(
      idx,
      `pr_lifecycle:${first.session_id}:${pr}`,
      { ...first, kind: 'pr_lifecycle', agent_id: null, context: contexts.has('main') ? 'main' : 'subagent', pr },
      ds,
    );
    if (contexts.size > 1) u.flags.add('mixed-context');
    if (ds.some((d) => d.prs.length > 1)) u.flags.add('multi-pr');
    const onPr = ds.flatMap((d) => d.calls.filter((t) => d.callPrs.get(t.tool_use_id)?.includes(pr) === true));
    for (const f of lifecycleFlags(onPr)) u.flags.add(f);
    const shas = new Set(u.calls.flatMap((t) => t.result_head_shas.map(shaKey)));
    if (shas.size > 0) u.rounds = shas.size;
    else {
      u.flags.add('sha-fallback');
      const a = Date.parse(u.start_ts ?? '');
      const b = Date.parse(u.end_ts ?? '');
      u.rounds = 1 + (pushes.get(first.session_id) ?? []).filter((x) => x >= a && x <= b).length;
    }
    out.push(u);
  }
  return out;
}
