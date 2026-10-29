#!/usr/bin/env node
// M1 validation: build the tables session by session over an extracted corpus and print aggregate counts
// next to the findings' numbers, plus the cost-state cross-check (rule 9) for every unresumed session.
//
//   node scripts/eval/model/validate.ts <projects-root> [--session <id>]
//
// <projects-root> is a directory laid out like ~/.claude/projects (e.g. the extracted 2026-10-29 archive).
// Reads one session at a time; prints one JSON document.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseJsonlText } from './records.ts';
import { buildSessionTables, costStateCheck, emptyCounts, groupBySession, mergeCounts } from './session.ts';

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
}

function load(root: string, rel: string): { path: string; records: unknown[] } {
  const text = readFileSync(join(root, rel), 'utf8');
  if (rel.endsWith('.jsonl')) return { path: rel, records: parseJsonlText(text).records };
  try {
    return { path: rel, records: [JSON.parse(text)] };
  } catch {
    return { path: rel, records: [] };
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const root = args.find((a) => !a.startsWith('--'));
  const only = args.includes('--session') ? args[args.indexOf('--session') + 1] : undefined;
  if (!root) {
    process.stdout.write(`${JSON.stringify({ error: 'usage: validate.ts <projects-root> [--session <id>]' })}\n`);
    process.exitCode = 2;
    return;
  }
  const all: string[] = [];
  walk(root, all);
  const rels = all.map((p) => relative(root, p)).sort();
  let counts = emptyCounts();
  const agg = {
    files: rels.length,
    transcripts: rels.filter((r) => r.endsWith('.jsonl') && !r.includes('/tool-results/')).length,
    sessions: 0,
    api_calls: { main: 0, subagent: 0 },
    api_calls_in_gh_files: { main: 0, subagent: 0 },
    stop_null: { main: 0, subagent: 0 },
    stop_null_in_gh_files: { main: 0, subagent: 0 },
    out_src: {} as Record<string, number>,
    out_src_gh_subagents: {} as Record<string, number>,
    tool_calls: 0,
    gh_tool_calls: { gh: 0, ghx: 0, mixed: 0 },
    turns_by_starter_main: {} as Record<string, number>,
    human_turns: 0,
    eras: {} as Record<string, number>,
    error_kinds: {} as Record<string, number>,
    ghx_error_codes: {} as Record<string, number>,
    refusals: {} as Record<string, number>,
    agents: { total: 0, linked_tool_use_id: 0, linked_skill_result: 0, unlinked: 0, parent_mismatch: 0 },
    cost_usd: 0,
  };
  const checks: unknown[] = [];
  const bump = (m: Record<string, number>, k: string): void => {
    m[k] = (m[k] ?? 0) + 1;
  };
  for (const { paths } of groupBySession(rels)) {
    if (only && !paths.some((p) => p.includes(only))) continue;
    const t = buildSessionTables(paths.map((p) => load(root, p)));
    counts = mergeCounts(counts, t.counts);
    agg.sessions += t.sessions.length;
    const ghFiles = new Set(t.tool_calls.filter((c) => c.cli && c.cli !== 'other').map((c) => c.file));
    for (const c of t.api_calls) {
      const k = c.agent_id === null ? 'main' : 'subagent';
      agg.api_calls[k]++;
      if (c.stop_reason === null) agg.stop_null[k]++;
      bump(agg.out_src, c.out_src);
      if (ghFiles.has(c.file)) {
        agg.api_calls_in_gh_files[k]++;
        if (c.stop_reason === null) agg.stop_null_in_gh_files[k]++;
        if (k === 'subagent') bump(agg.out_src_gh_subagents, c.out_src);
      }
      agg.cost_usd += c.cost_usd;
    }
    for (const c of t.tool_calls) {
      agg.tool_calls++;
      if (c.cli === 'gh' || c.cli === 'ghx' || c.cli === 'mixed') agg.gh_tool_calls[c.cli]++;
      if (c.error_kind) bump(agg.error_kinds, c.error_kind);
      if (c.ghx_error_code) bump(agg.ghx_error_codes, c.ghx_error_code);
      if (c.refusal) bump(agg.refusals, c.refusal);
    }
    for (const tr of t.turns) {
      if (tr.agent_id === null) bump(agg.turns_by_starter_main, tr.starter_kind);
      if (tr.is_human) agg.human_turns++;
    }
    for (const a of t.agents) {
      agg.agents.total++;
      if (a.linked_via === 'tool_use_id') agg.agents.linked_tool_use_id++;
      else if (a.linked_via === 'skill_result') agg.agents.linked_skill_result++;
      else agg.agents.unlinked++;
      if (a.parent_mismatch) agg.agents.parent_mismatch++;
    }
    for (const s of t.sessions) {
      bump(agg.eras, s.era);
      const chk = costStateCheck(s, t.api_calls);
      const mainCalls = t.api_calls.filter((c) => c.agent_id === null);
      const mainOnly = costStateCheck(s, mainCalls);
      if (s.cost_state) {
        checks.push({
          session: s.session_id,
          project: s.project.slice(-24),
          resumed: s.cost_state.resumed,
          n_agents: s.n_agents,
          cost_state_total: s.cost_state.total_usd,
          computed_total: s.cost_usd,
          per_model: chk.usable ? chk.rows : chk.reason,
          per_model_main_only: mainOnly.usable ? mainOnly.rows : mainOnly.reason,
        });
      }
    }
  }
  process.stdout.write(`${JSON.stringify({ aggregate: agg, counts, cost_state_checks: checks }, null, 1)}\n`);
}

if (import.meta.main) main();
