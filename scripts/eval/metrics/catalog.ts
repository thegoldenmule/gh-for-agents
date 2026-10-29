// The metric catalog (plan 07 "Metric catalog"): every metric the report shows, with its unit, formula and
// robustness, and one pure function that computes all of them for a unit from the rows it covers. Ported from
// docs/research/ghx-impact/metrics/metric_catalog.json (32 metrics) plus the plan's three "turns" numbers,
// wakeups and rounds. Changing a definition or a constant bumps METRIC_VERSION.

import { classifyCommand } from '../classify/command.ts';
import { PRICE_TABLE_VERSION, priceOf } from '../model/pricing.ts';
import type { ApiCallRow, ToolCallRow } from '../model/session.ts';
import { CHARS_PER_TOKEN, RECOVERY_MIN_SHARE, RESULT_OVERHEAD, resultTokenEstimate } from '../model/usage.ts';
import type { MetricDef, Unit, UnitKind } from '../units/types.ts';

export const METRIC_VERSION = '1.0.0';

/** Every constant a metric or a unit boundary depends on (plan 07 Determinism item 4). Emitted in report.json. */
export const CONSTANTS = {
  /** Characters per token for tool results (c). */
  CHARS_PER_TOKEN,
  /** Per-result overhead in tokens. */
  RESULT_OVERHEAD,
  /** Subagent output recovery: recovered value used when ≥ this share of the visible estimate (M1). */
  RECOVERY_MIN_SHARE,
  /**
   * Episode slack: consecutive non-GitHub, non-glue tool calls tolerated inside an episode before it closes.
   * 0 is episodes/episodes.py, which produced the findings' 1,439 episodes. Plan 07 lists 3, from findings §3,
   * which took the metrics prototype's GAP_CALLS (API calls, another segmentation) for this; 3 gives about 17%
   * fewer episodes on the 2026-10-29 snapshot. Changing it bumps METRIC_VERSION. buildUnits takes an override.
   */
  EPISODE_SLACK: 0,
  /** An episode closes when the next GitHub call starts more than this long after the episode's last event. */
  EPISODE_GAP_MS: 10 * 60 * 1000,
  /** Reference context for cost_norm (tokens). */
  REF_CTX: 50_000,
  /** A call is a cache rewrite when cache_creation / context exceeds this share... */
  REWRITE_THRESHOLD: 0.5,
  /** ...and its context exceeds this many tokens. */
  REWRITE_MIN_CTX: 5000,
  /** Carry-forward counts at most this many later API calls. */
  CARRY_HORIZON: 50,
  PRICE_TABLE_VERSION,
} as const;

const ALL: UnitKind[] = ['episode', 'wait', 'pr_cycle', 'pr_lifecycle', 'session'];
const PRS: UnitKind[] = ['pr_cycle', 'pr_lifecycle'];

const def = (
  id: string,
  unit: string,
  robustness: MetricDef['robustness'],
  applies_to: UnitKind[],
  description: string,
  formula: string,
): MetricDef => ({ id, unit, description, formula, robustness, applies_to });

/**
 * Terms used in formulas. GitHub calls: Bash or Monitor tool calls that run gh or ghx. Glue: the unit's other
 * tool calls (reads of redirect targets, logPath and output files, bare sleep, a Write whose file is sent as
 * --input/--body-file, TaskStop/TaskOutput of the unit's task). Span: the API calls charged to the unit — every
 * call that emitted one of its tool calls, the call that read its last result, the wake call after each of its
 * notifications, and (for an episode) every call in between in the same file. Each message.id counts once.
 */
export const CATALOG: MetricDef[] = [
  // --- the three "turns" numbers (plan "What turns means")
  def(
    'human_turns',
    'turns',
    'robust',
    ALL,
    'Prompts a person typed (findings §1.4) inside the unit. 0 for episodes by construction (a prompt closes one).',
    'count of main-thread turns with is_human whose start lies inside the unit (session: all of them)',
  ),
  def(
    'round_trips',
    'calls',
    'robust',
    ALL,
    "API calls that emitted one of the unit's tool calls (GitHub calls and glue). Findings §4.2's 'Round trips' " +
      'column is gh_round_trips, which counts only calls emitting a GitHub call.',
    "unique message.id over the unit's tool calls (session: all API calls)",
  ),
  def(
    'tool_calls',
    'calls',
    'robust',
    ALL,
    'GitHub calls plus glue calls inside the unit (session: every tool call).',
    'count of tool_use ids in the unit',
  ),
  // --- prototype catalog (metric_catalog.json v0.1), ids kept verbatim
  def(
    'gh_round_trips',
    'calls',
    'robust',
    ALL,
    'API calls that emitted at least one GitHub tool call.',
    'unique message.id over GitHub tool calls',
  ),
  def(
    'span_calls',
    'calls',
    'robust',
    ALL,
    'API calls charged to the unit (see Span). For a session, the sum over its GitHub units.',
    'len(span)',
  ),
  def(
    'glue_calls',
    'calls',
    'robust',
    ALL,
    'Glue tool calls: work done on GitHub output that is not itself a gh/ghx call. The prototype counted API ' +
      'calls (span_calls − linked − 1); units here carry glue explicitly, so this counts glue tool calls.',
    'tool_calls − gh_tool_calls',
  ),
  def('gh_tool_calls', 'calls', 'robust', ALL, 'GitHub tool calls.', 'count of Bash/Monitor calls running gh or ghx'),
  def(
    'gh_invocations',
    'invocations',
    'robust',
    ALL,
    'gh/ghx invocations in the command texts (a compound command can hold several).',
    'sum of n_invocations over GitHub calls',
  ),
  def(
    'distinct_cmds',
    'commands',
    'robust',
    ALL,
    'Distinct normalised command signatures.',
    'unique signatures; signature = "<cli> <subcommand>" per invocation joined by " ; "',
  ),
  def(
    'repeats',
    'commands',
    'robust',
    ALL,
    'GitHub calls that repeat an earlier signature.',
    'gh_tool_calls − distinct_cmds',
  ),
  def(
    'retries',
    'commands',
    'proxy',
    ALL,
    'A GitHub call with the same signature as the previous one, which failed.',
    'consecutive equal signatures where the first has error_kind ≠ null',
  ),
  def(
    'out_tok',
    'tokens',
    'robust',
    ALL,
    'Output tokens over the span (thinking included). Subagent values are recovered (M1 out_src); the recovery ' +
      'has a +14% aggregate bias.',
    'sum output_tokens over span',
  ),
  def(
    'write_tok',
    'tokens',
    'proxy',
    ALL,
    'Output tokens spent writing GitHub calls: each emitting call’s output split across its tool calls by input size.',
    'sum over GitHub-emitting calls of output_tokens × (GitHub tool input chars / all tool input chars)',
  ),
  def(
    'res_chars',
    'chars',
    'robust',
    ALL,
    'Characters of GitHub results and follow-up reads the model saw (tool_result.content).',
    'sum result_chars over GitHub calls and read glue',
  ),
  def(
    'res_tok_est',
    'tokens',
    'robust',
    ALL,
    'Context added by GitHub results and follow-up reads (R² 0.93–0.96 against measured Δcontext).',
    `sum over GitHub calls and read glue of result_chars / ${CHARS_PER_TOKEN} + ${RESULT_OVERHEAD}`,
  ),
  def(
    'res_tok_measured',
    'tokens',
    'proxy',
    ALL,
    'Measured Δcontext for GitHub calls where it is clean; validation only (about half of calls qualify). Null ' +
      'when no call qualifies.',
    'sum over GitHub calls whose emitting call has one tool_use and whose next call is the next index of ' +
      'ctx(next) − ctx(call) − output_tokens(call)',
  ),
  def(
    'follow_reads',
    'calls',
    'robust',
    ALL,
    'Glue calls that read GitHub output (redirect targets, logPath files, background output files).',
    'count of read glue',
  ),
  def(
    'cache_read',
    'tokens',
    'robust',
    ALL,
    'Cache-read tokens over the span. Dominated by session context; do not compare raw across arms.',
    'sum cache_read over span',
  ),
  def(
    'cache_write',
    'tokens',
    'robust',
    ALL,
    'Cache-write tokens (5m + 1h) over the span.',
    'sum cache_creation over span',
  ),
  def(
    'cache_rewrites',
    'calls',
    'robust',
    ALL,
    'Span calls that rewrote most of their context (an idle gap past the cache lifetime: 5m subagent, 1h main).',
    `count of span calls with context > ${CONSTANTS.REWRITE_MIN_CTX} and cache_creation / context > ${CONSTANTS.REWRITE_THRESHOLD}`,
  ),
  def(
    'cost',
    'usd',
    'robust',
    ALL,
    'Priced usage over the span, including 5m/1h cache writes and advisor iterations. Confounded by context ' +
      'size. Caveats (M1): subagent advisor cost is invisible in transcripts; opus is 6–20% under cost-state ' +
      'in subagent-heavy sessions (unrecorded side calls).',
    'sum cost_usd over span',
  ),
  def(
    'cost_norm',
    'usd',
    'robust',
    ALL,
    'Headline dollar figure (findings §2): keeps the unit’s own context growth and cache rewrites but replaces ' +
      'the session’s base context with 50k. Same caveats as cost.',
    `sum over span of [output + advisor cost + input cost × max(0, ctx − C0 + ${CONSTANTS.REF_CTX}) / ctx], ` +
      'C0 = context of the first span call, input cost = cost − output − advisor',
  ),
  def(
    'carry_cost_h50',
    'usd',
    'proxy',
    ALL,
    'Re-reading GitHub results on later calls, capped at 50 calls. Depends on unrelated later work; secondary.',
    `sum over GitHub calls and read glue of (result tokens + allocated emitting output) × min(calls until ` +
      `compaction or end of file, ${CONSTANTS.CARRY_HORIZON}) × cache-read price`,
  ),
  def(
    'wall_s',
    'seconds',
    'proxy',
    ALL,
    'Elapsed time from the unit’s first call to its last event. Includes CI’s own duration: report, never optimise.',
    'end_ts − start_ts',
  ),
  def(
    'blocked_s',
    'seconds',
    'robust',
    ALL,
    'Time the agent waited on foreground GitHub calls.',
    'sum over foreground GitHub calls of result_ts − call_ts',
  ),
  def(
    'errors',
    'calls',
    'robust',
    ALL,
    'GitHub calls that failed: a non-zero exit, a ghx error body (even behind a pipe), a hook block or a denial. ' +
      'ghx exits 10, 11 and 15 are outcomes, not errors.',
    'count of GitHub calls with error_kind ≠ null',
  ),
  def(
    'refusals',
    'calls',
    'robust',
    ALL,
    'GitHub calls refused by ghx policy, a hook, the permission system or the harness.',
    'count of GitHub calls with refusal ≠ null',
  ),
  def(
    'pipes',
    'calls',
    'robust',
    ALL,
    'GitHub commands piped into another command.',
    'count of GitHub calls with glue.pipe',
  ),
  def('jq', 'calls', 'robust', ALL, 'GitHub commands using --jq, -q or | jq.', 'count of GitHub calls with glue.jq'),
  def(
    'sleep_loops',
    'calls',
    'robust',
    ALL,
    'GitHub commands with a sleep or a while/until loop (polling).',
    'count of GitHub calls with glue.sleep or glue.loop',
  ),
  def(
    'watch',
    'calls',
    'robust',
    ALL,
    'GitHub commands using --watch or run watch.',
    'count of GitHub calls with glue.watch',
  ),
  def(
    'bg',
    'calls',
    'robust',
    ALL,
    'GitHub Bash calls that ran in the background.',
    'count of GitHub Bash calls with run_in_background or a background task id',
  ),
  def(
    'monitor',
    'calls',
    'robust',
    ALL,
    'Monitor tool calls whose script runs gh or ghx.',
    'count of GitHub Monitor calls',
  ),
  def(
    'notifications',
    'notifications',
    'robust',
    ALL,
    'Task notifications for the unit’s background GitHub calls and Monitors (each counted once: rule 6).',
    'sum notif_count over background GitHub calls',
  ),
  def(
    'wakeups',
    'calls',
    'robust',
    ALL,
    'Distinct API calls that a notification of the unit started or fed (a notification arriving mid-turn and ' +
      'one starting a turn both make the next call read it). Reported per wait and per lifecycle.',
    'unique (file, call index) of the call after each notification of the unit',
  ),
  def(
    'rounds',
    'rounds',
    'robust',
    PRS,
    'CI rounds: distinct head SHAs seen on the PR (git push boundaries when no SHA is visible: flag sha-fallback).',
    'pr_cycle: 1; pr_lifecycle: number of its cycles',
  ),
  def('units', 'units', 'robust', [...PRS, 'session'], 'Episodes and waits the unit is built from.', 'len(children)'),
  def('api_calls', 'calls', 'robust', ['session'], 'API calls in the session (main + subagents).', 'unique message.id'),
  def(
    'gh_share_calls',
    'ratio',
    'robust',
    ['session'],
    'GitHub work’s share of the session’s API calls.',
    'span_calls (union over episodes and waits) / api_calls',
  ),
  def(
    'gh_share_cost',
    'ratio',
    'robust',
    ['session'],
    'GitHub work’s share of the session’s cost.',
    'cost (union of episode and wait spans) / session cost',
  ),
];

/** The 32 prototype ids (metric_catalog.json v0.1); a test checks each has a definition here. */
export const PROTOTYPE_IDS: readonly string[] = [
  'gh_round_trips',
  'span_calls',
  'glue_calls',
  'gh_tool_calls',
  'gh_invocations',
  'distinct_cmds',
  'out_tok',
  'write_tok',
  'res_tok_est',
  'res_tok_measured',
  'cache_read',
  'cache_rewrites',
  'cost',
  'cost_norm',
  'carry_cost_h50',
  'wall_s',
  'blocked_s',
  'errors',
  'refusals',
  'retries',
  'repeats',
  'pipes',
  'jq',
  'sleep_loops',
  'watch',
  'bg',
  'monitor',
  'notifications',
  'human_turns',
  'api_calls',
  'gh_share_calls',
  'gh_share_cost',
];

// ---------------------------------------------------------------------------------------------- compute

/** What computeMetrics needs besides the unit: the rows it covers and a few lookups into the tables. */
export interface MetricContext {
  /** The unit's tool calls, in unit.tool_use_ids order. */
  calls: readonly ToolCallRow[];
  /** API calls charged to the unit (Span), one per message.id, file order. */
  span: readonly ApiCallRow[];
  /** Every tool call a message emitted (write_tok allocation). */
  toolCallsOf(messageId: string): readonly ToolCallRow[];
  /** The API call at a file position (copies owned by another file are absent). */
  apiCallAt(file: string, callIndex: number): ApiCallRow | undefined;
  /** API calls from `callIndex` (inclusive) to the next compaction or the end of the file. */
  callsUntilBoundary(file: string, callIndex: number): number;
  /** Distinct (file, call index) positions woken by the unit's notifications. */
  wakeups: number;
  human_turns: number;
  /** Children (episodes and waits) for cycles, lifecycles and sessions. */
  children?: number;
  /** pr_cycle and pr_lifecycle. */
  rounds?: number;
  /** Session units only. */
  session?: { api_calls: number; round_trips: number; tool_calls: number; cost: number };
}

export function isGitHubCall(t: ToolCallRow): boolean {
  return t.cli === 'gh' || t.cli === 'ghx' || t.cli === 'mixed';
}

const READ_GLUE = new Set(['Read', 'Bash', 'TaskOutput', 'BashOutput', 'Grep']);
const BARE_SLEEP = /^\s*sleep\s+\d+(?:\.\d+)?\s*$/;

/** Glue that reads GitHub output (not a Write of an input file, not a bare sleep, not TaskStop). */
export function isReadGlue(t: ToolCallRow): boolean {
  if (isGitHubCall(t) || !READ_GLUE.has(t.name)) return false;
  return !(t.name === 'Bash' && BARE_SLEEP.test(t.command ?? ''));
}

export function signature(t: ToolCallRow): string {
  if (t.command === null) return t.name;
  const invs = classifyCommand(t.command).invocations;
  return invs.map((i) => `${i.cli} ${i.subcommand}`.trim()).join(' ; ');
}

export function isRewrite(c: ApiCallRow): boolean {
  return (
    c.context_tokens > CONSTANTS.REWRITE_MIN_CTX && c.cache_creation / c.context_tokens > CONSTANTS.REWRITE_THRESHOLD
  );
}

/** cost_norm of a span: the base context replaced by REF_CTX, the unit's own growth kept (findings §2). */
export function costNorm(span: readonly ApiCallRow[]): number {
  const c0 = span[0]?.context_tokens ?? 0;
  let s = 0;
  for (const c of span) {
    const ctx = c.context_tokens || 1;
    const inputCost = c.cost_usd - c.cost_output_usd - c.cost_advisor_usd;
    s += c.cost_output_usd + c.cost_advisor_usd + (inputCost * Math.max(0, ctx - c0 + CONSTANTS.REF_CTX)) / ctx;
  }
  return s;
}

const seconds = (a: string | null, b: string | null): number | null =>
  a && b ? Math.max(0, (Date.parse(b) - Date.parse(a)) / 1000) : null;

/** Output tokens of a call allocated to `t` by its share of the call's tool input characters. */
function emittedShare(t: ToolCallRow, ctx: MetricContext): number {
  const call = ctx.apiCallAt(t.file, t.call_index);
  if (!call) return 0;
  const all = ctx.toolCallsOf(t.message_id);
  const total = all.reduce((s, x) => s + x.input_chars, 0) || 1;
  return (call.output_tokens * t.input_chars) / total;
}

/** Every metric in CATALOG that applies to `unit.kind`; null where it cannot be measured. */
export function computeMetrics(unit: Unit, ctx: MetricContext): Record<string, number | null> {
  const calls = ctx.calls;
  const gh = calls.filter(isGitHubCall);
  const reads = calls.filter(isReadGlue);
  const span = ctx.span;
  const resCalls = [...gh, ...reads];
  const sigs = gh.map(signature);
  let retries = 0;
  for (let i = 1; i < gh.length; i++) {
    if (sigs[i] === sigs[i - 1] && (gh[i - 1] as ToolCallRow).error_kind !== null) retries++;
  }
  let writeTok = 0;
  for (const t of gh) writeTok += emittedShare(t, ctx);
  let measured = 0;
  let nMeasured = 0;
  for (const t of gh) {
    const call = ctx.apiCallAt(t.file, t.call_index);
    if (call?.n_tool_uses !== 1 || t.next_call_index !== t.call_index + 1) continue;
    const next = ctx.apiCallAt(t.file, t.next_call_index);
    if (!next) continue;
    measured += next.context_tokens - call.context_tokens - call.output_tokens;
    nMeasured++;
  }
  let carry = 0;
  let carryPriced = true;
  for (const t of resCalls) {
    if (t.next_call_index === null) continue;
    const after = Math.min(ctx.callsUntilBoundary(t.file, t.next_call_index), CONSTANTS.CARRY_HORIZON);
    let tok = resultTokenEstimate(t.result_chars);
    if (isGitHubCall(t)) tok += emittedShare(t, ctx);
    const model = ctx.apiCallAt(t.file, t.call_index)?.model ?? null;
    const p = priceOf(model);
    if (!p) {
      carryPriced = false;
      continue;
    }
    carry += (tok * after * p.cacheRead) / 1e6;
  }
  let blocked = 0;
  for (const t of gh) {
    if (t.background) continue;
    blocked += seconds(t.call_ts, t.result_ts) ?? 0;
  }
  const spanCost = span.reduce((s, c) => s + c.cost_usd, 0);
  const all: Record<string, number | null> = {
    human_turns: ctx.human_turns,
    round_trips: ctx.session?.round_trips ?? new Set(calls.map((t) => t.message_id)).size,
    tool_calls: ctx.session?.tool_calls ?? calls.length,
    gh_round_trips: new Set(gh.map((t) => t.message_id)).size,
    span_calls: span.length,
    glue_calls: calls.length - gh.length,
    gh_tool_calls: gh.length,
    gh_invocations: gh.reduce((s, t) => s + t.n_invocations, 0),
    distinct_cmds: new Set(sigs).size,
    repeats: gh.length - new Set(sigs).size,
    retries,
    out_tok: span.reduce((s, c) => s + c.output_tokens, 0),
    write_tok: writeTok,
    res_chars: resCalls.reduce((s, t) => s + t.result_chars, 0),
    res_tok_est: resCalls.reduce((s, t) => s + resultTokenEstimate(t.result_chars), 0),
    res_tok_measured: nMeasured > 0 ? measured : null,
    follow_reads: reads.length,
    cache_read: span.reduce((s, c) => s + c.cache_read, 0),
    cache_write: span.reduce((s, c) => s + c.cache_creation, 0),
    cache_rewrites: span.filter(isRewrite).length,
    cost: spanCost,
    cost_norm: costNorm(span),
    carry_cost_h50: carryPriced ? carry : null,
    wall_s: seconds(unit.start_ts, unit.end_ts),
    blocked_s: blocked,
    errors: gh.filter((t) => t.error_kind !== null).length,
    refusals: gh.filter((t) => t.refusal !== null).length,
    pipes: gh.filter((t) => t.glue?.pipe === true).length,
    jq: gh.filter((t) => t.glue?.jq === true).length,
    sleep_loops: gh.filter((t) => t.glue?.sleep === true || t.glue?.loop === true).length,
    watch: gh.filter((t) => t.glue?.watch === true).length,
    bg: gh.filter((t) => t.name === 'Bash' && (t.run_in_background || t.background_task_id !== null)).length,
    monitor: gh.filter((t) => t.name === 'Monitor').length,
    notifications: gh.filter((t) => t.background).reduce((s, t) => s + t.notif_count, 0),
    wakeups: ctx.wakeups,
    rounds: ctx.rounds ?? null,
    units: ctx.children ?? null,
    api_calls: ctx.session?.api_calls ?? null,
    gh_share_calls: ctx.session ? (ctx.session.api_calls > 0 ? span.length / ctx.session.api_calls : null) : null,
    gh_share_cost: ctx.session ? (ctx.session.cost > 0 ? spanCost / ctx.session.cost : null) : null,
  };
  const out: Record<string, number | null> = {};
  for (const d of CATALOG) if (d.applies_to.includes(unit.kind)) out[d.id] = all[d.id] ?? null;
  return out;
}

export const METRIC_IDS: readonly string[] = CATALOG.map((d) => d.id);
