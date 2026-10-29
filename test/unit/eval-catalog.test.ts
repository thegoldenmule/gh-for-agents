// ghx-eval M2: the metric catalog (scripts/eval/metrics/catalog.ts): the prototype's 32 ids, robustness per
// plan 07, the versioned constants, and known answers for the trickier formulas.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CATALOG,
  CONSTANTS,
  computeMetrics,
  costNorm,
  isRewrite,
  type MetricContext,
  PROTOTYPE_IDS,
} from '../../scripts/eval/metrics/catalog.ts';
import type { ApiCallRow, ToolCallRow } from '../../scripts/eval/model/session.ts';
import { CHARS_PER_TOKEN, RESULT_OVERHEAD } from '../../scripts/eval/model/usage.ts';
import type { Unit, UnitKind } from '../../scripts/eval/units/types.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const close = (a: number | null | undefined, b: number, msg?: string) =>
  assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-9, msg ?? `${a} != ${b}`);

const api = (p: Partial<ApiCallRow>): ApiCallRow =>
  ({
    message_id: 'm',
    file: 'f',
    call_index: 0,
    model: 'claude-opus-5-5',
    context_tokens: 0,
    cache_creation: 0,
    cache_read: 0,
    output_tokens: 0,
    cost_usd: 0,
    cost_output_usd: 0,
    cost_advisor_usd: 0,
    n_tool_uses: 1,
    ...p,
  }) as ApiCallRow;

const tool = (p: Partial<ToolCallRow>): ToolCallRow =>
  ({
    tool_use_id: 't',
    message_id: 'm',
    file: 'f',
    call_index: 0,
    name: 'Bash',
    input_chars: 10,
    command: 'gh pr view 1',
    cli: 'gh',
    n_invocations: 1,
    intent: 'status',
    intents: ['status'],
    glue: null,
    run_in_background: false,
    background: false,
    background_task_id: null,
    call_ts: null,
    result_ts: null,
    error_kind: null,
    refusal: null,
    result_chars: 0,
    notif_count: 0,
    notif_wake_call_indexes: [],
    next_call_index: null,
    meta_only: false,
    ...p,
  }) as ToolCallRow;

const unit = (kind: UnitKind): Unit => ({
  unit_id: 'u',
  kind,
  session_id: 's',
  agent_id: null,
  context: 'main',
  project: 'p',
  model: '',
  bucket: 'gh-pre',
  category: 'status',
  intent: 'status',
  pr: null,
  start_ts: '2026-10-24T10:00:00.000Z',
  end_ts: '2026-10-24T10:01:30.000Z',
  tool_use_ids: [],
  flags: [],
  metrics: {},
  children: [],
  start_pos: 0,
});

function ctxOf(calls: ToolCallRow[], span: ApiCallRow[], extra: Partial<MetricContext> = {}): MetricContext {
  const at = new Map(span.map((c) => [`${c.file}:${c.call_index}`, c]));
  return {
    calls,
    span,
    toolCallsOf: (m) => calls.filter((t) => t.message_id === m),
    apiCallAt: (f, i) => at.get(`${f}:${i}`),
    callsUntilBoundary: () => 10,
    wakeups: 0,
    human_turns: 0,
    ...extra,
  };
}

test('the catalog ports all 32 prototype metrics, with unique ids', () => {
  const proto = JSON.parse(
    readFileSync(join(ROOT, 'docs/research/ghx-impact/metrics/metric_catalog.json'), 'utf8'),
  ) as { metrics: { id: string }[] };
  assert.deepEqual([...PROTOTYPE_IDS].sort(), proto.metrics.map((m) => m.id).sort());
  const ids = CATALOG.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of PROTOTYPE_IDS) assert.ok(ids.includes(id), id);
  for (const id of ['human_turns', 'round_trips', 'tool_calls', 'wakeups', 'rounds']) assert.ok(ids.includes(id), id);
  for (const d of CATALOG) assert.ok(d.formula && d.description && d.unit && d.applies_to.length > 0, d.id);
});

test('robustness follows plan 07: proxies are write tokens, carry-forward, retries and wall-clock', () => {
  const proxy = CATALOG.filter((d) => d.robustness === 'proxy').map((d) => d.id);
  assert.deepEqual(proxy.sort(), ['carry_cost_h50', 'res_tok_measured', 'retries', 'wall_s', 'write_tok']);
  for (const id of [
    'round_trips',
    'res_tok_est',
    'cache_rewrites',
    'cost',
    'cost_norm',
    'errors',
    'refusals',
    'wakeups',
  ]) {
    assert.equal(CATALOG.find((d) => d.id === id)?.robustness, 'robust', id);
  }
});

test('constants: the versioned set of plan 07 Determinism item 4, the result constants imported from M1', () => {
  assert.equal(CONSTANTS.CHARS_PER_TOKEN, CHARS_PER_TOKEN);
  assert.equal(CONSTANTS.RESULT_OVERHEAD, RESULT_OVERHEAD);
  assert.deepEqual(
    [CONSTANTS.CHARS_PER_TOKEN, CONSTANTS.RESULT_OVERHEAD, CONSTANTS.EPISODE_SLACK, CONSTANTS.EPISODE_GAP_MS],
    [2.2, 70, 3, 600_000],
  );
  assert.deepEqual([CONSTANTS.REF_CTX, CONSTANTS.REWRITE_THRESHOLD, CONSTANTS.CARRY_HORIZON], [50_000, 0.5, 50]);
});

test('cost_norm replaces the base context with 50k and keeps the unit’s own growth', () => {
  const span = [
    api({ context_tokens: 100_000, cost_usd: 1.0, cost_output_usd: 0.2 }),
    api({ call_index: 1, context_tokens: 120_000, cost_usd: 1.2, cost_output_usd: 0.1, cost_advisor_usd: 0.1 }),
  ];
  // 0.2 + 0.8 × 50k/100k, then 0.1 + 0.1 + 1.0 × (120k − 100k + 50k)/120k.
  close(costNorm(span), 0.2 + 0.4 + 0.2 + 70 / 120);
  close(costNorm([api({ context_tokens: 10_000, cost_usd: 1, cost_output_usd: 0 })]), 5, 'a small base scales up');
});

test('cache rewrites: context over 5000 and more than half of it written', () => {
  assert.equal(isRewrite(api({ context_tokens: 5000, cache_creation: 4000 })), false, 'context not over 5000');
  assert.equal(isRewrite(api({ context_tokens: 5001, cache_creation: 2600 })), true);
  assert.equal(isRewrite(api({ context_tokens: 10_000, cache_creation: 5000 })), false, 'exactly half is not over');
});

test('result tokens, write-token allocation, carry-forward, blocked time, glue counts', () => {
  const gh = tool({
    tool_use_id: 'a',
    message_id: 'm1',
    input_chars: 30,
    result_chars: 220,
    next_call_index: 1,
    call_ts: '2026-10-24T10:00:00.000Z',
    result_ts: '2026-10-24T10:00:04.000Z',
    glue: {
      pipe: true,
      jq: true,
      sleep: false,
      loop: false,
      watch: false,
      timeout: false,
      perlAlarm: false,
      redirects: [],
      inputFiles: [],
    },
  });
  const edit = tool({ tool_use_id: 'b', message_id: 'm1', name: 'Edit', cli: null, command: null, input_chars: 70 });
  const read = tool({
    tool_use_id: 'c',
    message_id: 'm2',
    call_index: 1,
    name: 'Read',
    cli: null,
    command: null,
    result_chars: 0,
    next_call_index: 2,
  });
  const span = [
    api({ message_id: 'm1', output_tokens: 100, n_tool_uses: 2 }),
    api({ message_id: 'm2', call_index: 1, output_tokens: 10 }),
  ];
  const m = computeMetrics(
    unit('episode'),
    ctxOf([gh, read], span, { toolCallsOf: (id) => (id === 'm1' ? [gh, edit] : [read]) }),
  );
  close(m.res_tok_est, 220 / 2.2 + 70 + 70, 'the gh result and the follow-up read');
  close(m.write_tok, 30, '100 output tokens × 30 / (30 + 70) input chars');
  // (170 + 30) × 10 calls + 70 × 10 calls, at opus cache read $0.20/MTok.
  close(m.carry_cost_h50, ((200 + 70) * 10 * 0.2) / 1e6);
  close(m.blocked_s, 4);
  close(m.wall_s, 90);
  assert.deepEqual([m.gh_tool_calls, m.glue_calls, m.follow_reads, m.pipes, m.jq], [1, 1, 1, 1, 1]);
  assert.deepEqual([m.round_trips, m.gh_round_trips, m.span_calls, m.out_tok], [2, 1, 2, 110]);
});

test('retries and repeats: equal signatures in a row, the first failed', () => {
  const calls = [
    tool({ tool_use_id: 'a', command: 'gh pr view 1', error_kind: 'command' }),
    tool({ tool_use_id: 'b', command: 'gh pr view 1 --json state' }),
    tool({ tool_use_id: 'c', command: 'gh run list' }),
  ];
  const m = computeMetrics(unit('episode'), ctxOf(calls, []));
  assert.deepEqual([m.distinct_cmds, m.repeats, m.retries, m.errors], [2, 1, 1, 1]);
});

test('computeMetrics returns exactly the metrics that apply to the unit kind', () => {
  for (const kind of ['episode', 'wait', 'pr_cycle', 'pr_lifecycle', 'session'] as UnitKind[]) {
    const want = CATALOG.filter((d) => d.applies_to.includes(kind)).map((d) => d.id);
    const session = { api_calls: 4, round_trips: 4, tool_calls: 4, cost: 1 };
    const got = computeMetrics(unit(kind), ctxOf([], [], kind === 'session' ? { session } : {}));
    assert.deepEqual(Object.keys(got), want, kind);
  }
  assert.equal(computeMetrics(unit('episode'), ctxOf([], [])).res_tok_measured, null, 'no clean call to measure');
});
