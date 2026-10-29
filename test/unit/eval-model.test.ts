// ghx-eval M1: the transcript model (scripts/eval/model). One test per parsing rule of plan 07, each on
// hand-built records in Claude Code 2.1.280's shapes (test/fixtures/eval/model/shapes.ts), plus linkage,
// turns, eras and determinism.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dedupeNotifications, lastOfType, type NotificationSighting } from '../../scripts/eval/model/dedupe.ts';
import { parseNotification } from '../../scripts/eval/model/notifications.ts';
import { callCost, PRICE_TABLE_VERSION, priceOf } from '../../scripts/eval/model/pricing.ts';
import { fileKind, parseJsonlText, parseRecord } from '../../scripts/eval/model/records.ts';
import {
  buildTables,
  costStateCheck,
  DEFAULT_ERA_CONFIG,
  eraAt,
  groupBySession,
  type InputFile,
  type Tables,
} from '../../scripts/eval/model/session.ts';
import { contextTokens, pyJsonDumps, resultText } from '../../scripts/eval/model/usage.ts';
import * as S from '../fixtures/eval/model/shapes.ts';

const OPUS = 'claude-opus-5-5';
const FABLE = 'claude-fable-5-1';
const close = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-9, msg ?? `${a} != ${b}`);
const one = <T>(xs: readonly T[], pred: (x: T) => boolean): T => {
  const hits = xs.filter(pred);
  assert.equal(hits.length, 1, `expected exactly one match, got ${hits.length}`);
  return hits[0] as T;
};

/** A main thread with one human turn and one ghx call: the base most rules extend. */
function simpleMain(extra: Record<string, unknown>[] = []): Record<string, unknown>[] {
  return [
    S.humanPrompt('Check PR 12', 'p1', { ts: S.ts(0) }),
    ...S.response({
      id: 'msg_main1',
      ts: S.ts(0, 5),
      content: [S.thinking(), S.bash('toolu_status', 'ghx pr status 12')],
      usage: S.usage({ input: 2, cacheRead: 10_000, write1h: 1_000, output: 50 }),
    }),
    S.toolResult('toolu_status', '{"pr":12,"ci":"green"}', {
      promptId: 'p1',
      ts: S.ts(0, 8),
      toolUseResult: S.bashResult('{"pr":12,"ci":"green"}'),
    }),
    ...extra,
  ];
}

const build = (files: InputFile[]): Tables => buildTables(files);

test('rule 1: records sharing a message.id are one API call with the last usage, not a sum', () => {
  S.resetIds();
  const t = build([{ path: S.mainPath(), records: [...simpleMain(), S.synthetic({ ts: S.ts(1) })] }]);
  const c = one(t.api_calls, (x) => x.message_id === 'msg_main1');
  assert.equal(c.n_records, 2);
  assert.deepEqual([c.input, c.cache_read, c.cache_creation, c.output_tokens], [2, 10_000, 1_000, 50]);
  // 2×4 + 10k×0.2 + 1k×4×2 (1h write) + 50×20, per MTok; summing both records would double it.
  close(c.cost_usd, 11_008 / 1e6);
  assert.equal(t.counts.duplicate_assistant_records, 1);
  assert.equal(t.counts.synthetic_records, 1, '<synthetic> API errors are counted, not calls');
  assert.equal(t.api_calls.length, 1);
  assert.equal(t.tool_calls.length, 1, 'the tool_use repeated in no other record is one tool call');
});

test('rule 2: a fork copies its parent records; each message.id is kept once, in the non-fork file', () => {
  S.resetIds();
  const spawn = S.response({
    id: 'msg_spawn',
    ts: S.ts(1),
    content: [S.toolUse('toolu_fork', 'Agent', { description: 'Fork', prompt: 'Go', subagent_type: 'fork' })],
    usage: S.usage({ cacheRead: 12_000, output: 40 }),
  });
  const fork = 'afork0000000000001';
  const files: InputFile[] = [
    { path: S.mainPath(), records: [...simpleMain(), ...spawn] },
    {
      path: S.agentPath(fork),
      records: [
        // The fork's copy of its parent's history: the same message ids.
        S.humanPrompt('Check PR 12', 'p1', { ts: S.ts(0) }),
        ...spawn.map((r) => ({ ...r, isSidechain: true, agentId: fork })),
        S.prompt('Fork task: summarise', { agentId: fork, ts: S.ts(2) }),
        ...S.response({
          id: 'msg_fork_own',
          agentId: fork,
          ts: S.ts(2, 5),
          content: [S.text('Summary.')],
          usage: S.usage({ cacheRead: 12_000, output: 20 }),
          stop: 'end_turn',
        }),
      ],
    },
    { path: S.agentPath(fork, '.meta.json'), records: [S.agentMeta({ toolUseId: 'toolu_fork', isFork: true })] },
  ];
  const t = build(files);
  assert.equal(one(t.api_calls, (c) => c.message_id === 'msg_spawn').agent_id, null, 'owned by the main file');
  assert.equal(one(t.api_calls, (c) => c.message_id === 'msg_fork_own').agent_id, fork);
  assert.equal(t.counts.fork_copied_calls, 1);
  assert.equal(t.tool_calls.filter((c) => c.tool_use_id === 'toolu_fork').length, 1, 'copied tool_use dropped too');
  assert.equal(t.counts.fork_copied_turns, 1, "the fork's copied turn is not a turn of its own");
  assert.equal(t.turns.filter((x) => x.agent_id === fork).length, 1);
  const a = one(t.agents, (x) => x.agent_id === fork);
  assert.deepEqual([a.is_fork, a.parent_agent_id, a.linked_via], [true, null, 'tool_use_id']);
});

test('rule 3: stop_reason null outputs are recovered from the next call’s Δcontext, with out_src', () => {
  S.resetIds();
  const sub = 'asub00000000000001';
  const files: InputFile[] = [
    {
      path: S.mainPath(),
      records: simpleMain(
        S.response({
          id: 'msg_spawn',
          ts: S.ts(1),
          content: [S.toolUse('toolu_spawn', 'Agent', { description: 'Look', prompt: 'Look', subagent_type: 'x' })],
          usage: S.usage({ cacheRead: 12_000, output: 40 }),
        }),
      ),
    },
    {
      path: S.agentPath(sub),
      records: [
        S.prompt('List the files', { agentId: sub, ts: S.ts(2), promptId: 'sp1' }),
        // Stream-start snapshot: input final, output_tokens a placeholder.
        ...S.response({
          id: 'msg_sub0',
          agentId: sub,
          ts: S.ts(2, 1),
          stop: null,
          content: [S.thinking(), S.bash('toolu_ls', 'ls')],
          usage: { ...S.usage({ input: 3, write5m: 20_000, output: 8 }), output_tokens_details: undefined },
        }),
        S.toolResult('toolu_ls', 'x'.repeat(220), { agentId: sub, ts: S.ts(2, 2), toolUseResult: S.bashResult('') }),
        // Next call: context grew by 1,170 = output (1,000) + the result (220 / 2.2 + 70 = 170).
        ...S.response({
          id: 'msg_sub1',
          agentId: sub,
          ts: S.ts(2, 3),
          stop: null,
          content: [S.text('All done.')],
          usage: S.usage({ input: 3, cacheRead: 20_000, write5m: 1_170, output: 3 }),
        }),
      ],
    },
    { path: S.agentPath(sub, '.meta.json'), records: [S.agentMeta({ toolUseId: 'toolu_spawn' })] },
  ];
  const t = build(files);
  const c0 = one(t.api_calls, (c) => c.message_id === 'msg_sub0');
  assert.deepEqual([c0.out_logged, c0.output_tokens, c0.out_src], [8, 1_000, 'recovered']);
  const c1 = one(t.api_calls, (c) => c.message_id === 'msg_sub1');
  // No next call: the visible estimate ('All done.' = 9 chars / 2.2 ≈ 4), never below the logged 3.
  assert.deepEqual([c1.output_tokens, c1.out_src], [4, 'visible_est']);
  assert.equal(one(t.api_calls, (c) => c.message_id === 'msg_main1').out_src, 'final');
  close(c0.cost_output_usd, (1_000 * 20) / 1e6, 'priced on the recovered output');
});

test('rule 4: advisor iterations are priced at their own model; input per message iteration', () => {
  S.resetIds();
  const u = S.usage({
    input: 4,
    cacheRead: 2_500,
    write1h: 500,
    write5m: 200,
    output: 50,
    // Real multi-iteration records carry only the first iteration's 1h/5m split at the top level.
    split: { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 0 },
    iterations: [
      S.iteration('message', { input: 2, cacheRead: 1_000, write1h: 500, output: 30 }),
      S.iteration('advisor_message', { input: 5_000, output: 400 }, FABLE),
      S.iteration('message', { input: 2, cacheRead: 1_500, write5m: 200, output: 20 }),
    ],
  });
  const t = build([
    {
      path: S.mainPath(),
      records: [
        S.humanPrompt('Plan it', 'p1'),
        S.assistant({ id: 'msg_adv', content: [S.text('Plan.')], usage: u, stop: 'end_turn' }),
      ],
    },
  ]);
  const c = one(t.api_calls, (x) => x.message_id === 'msg_adv');
  // Opus: 4×4 + 2,500×0.2 + 500×4×2 + 200×4×1.25 + 50×20 = 6,516; Fable advisor: 5,000×10 + 400×50 = 70,000.
  close(c.cost_usd - c.cost_advisor_usd, 6_516 / 1e6);
  close(c.cost_advisor_usd, 70_000 / 1e6);
  assert.deepEqual(
    c.advisor.map((a) => [a.model, a.input, a.output]),
    [[FABLE, 5_000, 400]],
  );
  assert.equal(c.context_tokens, 2 + 200 + 1_500, 'context is the last message iteration');
  assert.deepEqual([c.cache_creation_1h, c.cache_creation_5m], [500, 200]);
  assert.equal(priceOf('claude-opus-5-5[1m]')?.input, 4);
  assert.equal(priceOf('claude-haiku-4-5-20251001')?.output, 5);
  assert.match(PRICE_TABLE_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  assert.equal(callCost('claude-unknown', {}, 10).unpriced, true);
});

test('rule 5: result size comes from tool_result.content, not toolUseResult.stdout', () => {
  S.resetIds();
  const preview =
    '<persisted-output>\nOutput too large (40.0KB). Full output saved to: ' +
    `/Users/dev/.claude/projects/${S.PROJECT}/${S.SESSION}/tool-results/bxyz.txt\n\nPreview (first 2KB):\n` +
    `${'a'.repeat(2_000)}\n...\n</persisted-output>`;
  const t = build([
    {
      path: S.mainPath(),
      records: [
        S.humanPrompt('Show the log', 'p1'),
        ...S.response({
          id: 'msg_log',
          content: [S.bash('toolu_log', 'gh run view 99 --log-failed')],
          usage: S.usage({ cacheRead: 5_000, output: 30 }),
        }),
        S.toolResult('toolu_log', preview, { toolUseResult: S.bashResult('a'.repeat(40_000)) }),
      ],
    },
  ]);
  const c = one(t.tool_calls, (x) => x.tool_use_id === 'toolu_log');
  assert.equal(c.result_chars, preview.length);
  assert.equal(c.persisted, true);
  // List content: text blocks count their text, images nothing, other blocks their (Python) JSON.
  const block = { type: 'tool_reference', tool_name: 'X' };
  assert.equal(
    resultText([{ type: 'text', text: 'abc' }, { type: 'image', source: { data: 'zz' } }, block]),
    `abc${pyJsonDumps(block)}`,
  );
});

test('rule 6: a notification seen three times counts once, keyed by task id, earliest copy', () => {
  S.resetIds();
  const note = S.notificationText({
    taskId: 'bwait0001',
    toolUseId: 'toolu_wait',
    status: 'failed',
    summary: 'Background command "Wait for CI" failed with exit code 10',
  });
  const placeholder =
    'Command running in background with ID: bwait0001. Output is being written to: ' +
    `/private/tmp/claude-501/${S.PROJECT}/${S.SESSION}/tasks/bwait0001.output`;
  const t = build([
    {
      path: S.mainPath(),
      records: simpleMain([
        ...S.response({
          id: 'msg_wait',
          ts: S.ts(1),
          content: [S.bash('toolu_wait', 'ghx ci wait 12', { run_in_background: true })],
          usage: S.usage({ cacheRead: 11_000, output: 30 }),
        }),
        S.toolResult('toolu_wait', placeholder, {
          promptId: 'p1',
          ts: S.ts(1, 1),
          toolUseResult: { ...S.bashResult(''), backgroundTaskId: 'bwait0001' },
        }),
        S.queueOperation('enqueue', note, S.ts(20)),
        S.queuedCommand(note, { ts: S.ts(20, 1) }),
        S.queueOperation('remove', note, S.ts(20, 2)),
        S.prompt(note, { promptId: 'p2', origin: 'task-notification', turnOrigin: 'task_notification', ts: S.ts(21) }),
        ...S.response({
          id: 'msg_read',
          ts: S.ts(21, 5),
          content: [
            S.toolUse('toolu_read', 'Read', {
              file_path: `/private/tmp/claude-501/${S.PROJECT}/${S.SESSION}/tasks/bwait0001.output`,
            }),
          ],
          usage: S.usage({ cacheRead: 11_500, output: 30 }),
        }),
        S.toolResult('toolu_read', 'r'.repeat(500), { promptId: 'p2', ts: S.ts(21, 6) }),
      ]),
    },
  ]);
  const w = one(t.tool_calls, (x) => x.tool_use_id === 'toolu_wait');
  assert.deepEqual(
    [w.background, w.background_task_id, w.notif_count, w.notif_ts, w.notif_status, w.notif_exit],
    [true, 'bwait0001', 1, S.ts(20), 'failed', 10],
  );
  assert.equal(t.counts.notification_sightings, 4);
  assert.equal(t.counts.notifications, 1);
  assert.equal(w.output_file_read_bytes, 500, 'the later Read of the output file attaches to the wait');
  assert.deepEqual([w.ghx_outcome, w.error_kind, w.effective_exit], ['ci_red', null, 10], 'exit 10 is an outcome');
  assert.equal(w.intent, 'wait');

  // Distinct Monitor events for one task are separate notifications; exact copies collapse.
  const ev = (line: string, order: number, at: string | null): NotificationSighting => ({
    notification: parseNotification(
      `[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>\n<task-id>bmon1</task-id>\n<summary>Monitor event: "ci"</summary>\n<event>${line}</event>\n</task-notification>`,
    ) as NonNullable<ReturnType<typeof parseNotification>>,
    ts: at,
    order,
    file: 'f',
    source: 'user',
  });
  const kept = dedupeNotifications([ev('a', 0, S.ts(5)), ev('b', 1, S.ts(6)), ev('a', 2, S.ts(4))]);
  assert.deepEqual(
    kept.map((k) => [k.order, k.ts]),
    [
      [1, S.ts(6)],
      [2, S.ts(4)],
    ],
  );
  assert.equal(kept[0]?.notification.event, true);
});

test('rule 7: Bash exit codes come from is_error + `Exit code N`; blocks and denials are their own kind', () => {
  S.resetIds();
  const call = (id: string, cmd: string, mid: string) =>
    S.response({ id: mid, content: [S.bash(id, cmd)], usage: S.usage({ cacheRead: 9_000, output: 20 }) });
  const t = build([
    {
      path: S.mainPath(),
      records: [
        S.humanPrompt('Go', 'p1'),
        ...call('toolu_fail', 'gh pr checks 12', 'msg_a'),
        S.toolResult('toolu_fail', 'Exit code 8\nci  fail  1m  https://example.invalid/run/1', {
          isError: true,
          toolUseResult: 'Error: Exit code 8\nci  fail',
        }),
        S.hookAttachment('toolu_hook', 'deny', 'ghx replaces `gh run rerun 9`.'),
        ...call('toolu_hook', 'gh run rerun 9 --failed', 'msg_b'),
        S.toolResult(
          'toolu_hook',
          'PreToolUse:Bash hook error: ghx replaces `gh run rerun 9 --failed`. Use: ghx ci rerun <pr>',
          {
            isError: true,
            toolDenialKind: 'permission-rule',
          },
        ),
        ...call('toolu_deny', 'git push --force', 'msg_c'),
        S.toolResult('toolu_deny', 'Permission for this action was denied by the Claude Code auto mode classifier.', {
          isError: true,
          toolDenialKind: 'automode-blocked',
        }),
        ...call('toolu_ok', 'gh pr view 12 --json state', 'msg_d'),
        S.toolResult('toolu_ok', '{"state":"OPEN"}', { toolUseResult: S.bashResult('{"state":"OPEN"}') }),
      ],
    },
  ]);
  const row = (id: string) => one(t.tool_calls, (x) => x.tool_use_id === id);
  assert.deepEqual([row('toolu_fail').exit_code, row('toolu_fail').error_kind], [8, 'command']);
  assert.deepEqual(
    [
      row('toolu_hook').exit_code,
      row('toolu_hook').error_kind,
      row('toolu_hook').refusal,
      row('toolu_hook').hook_decision,
    ],
    [null, 'hook_block', 'hook', 'deny'],
  );
  assert.deepEqual([row('toolu_deny').error_kind, row('toolu_deny').refusal], ['permission_denied', 'permission']);
  assert.deepEqual([row('toolu_ok').exit_code, row('toolu_ok').error_kind], [0, null]);
});

test('rule 8: ghx exits 10/11/15 are outcomes; a JSON error body is an error even when a pipe made it exit 0', () => {
  S.resetIds();
  const call = (id: string, cmd: string, mid: string) =>
    S.response({ id: mid, content: [S.bash(id, cmd)], usage: S.usage({ cacheRead: 9_000, output: 20 }) });
  const body = '{"error":{"code":"VALIDATION","message":"title is required","hint":"pass --title"}}';
  const t = build([
    {
      path: S.mainPath(),
      records: [
        S.humanPrompt('Go', 'p1'),
        ...call('toolu_piped', 'ghx pr create --input body.json | tail -5', 'msg_a'),
        S.toolResult('toolu_piped', body, { toolUseResult: S.bashResult(body) }),
        ...call('toolu_red', 'ghx ci wait 12', 'msg_b'),
        S.toolResult('toolu_red', 'Exit code 11\n{"outcome":"failure"}', { isError: true }),
        ...call('toolu_policy', 'ghx pr merge 12', 'msg_c'),
        S.toolResult('toolu_policy', 'Exit code 6\n{"error":{"code":"POLICY_MERGE_METHOD","message":"no"}}', {
          isError: true,
        }),
      ],
    },
  ]);
  const row = (id: string) => one(t.tool_calls, (x) => x.tool_use_id === id);
  const piped = row('toolu_piped');
  assert.deepEqual([piped.exit_code, piped.error_kind, piped.ghx_error_code], [0, 'command', 'VALIDATION']);
  assert.deepEqual(piped.glue?.inputFiles, ['body.json']);
  assert.deepEqual([row('toolu_red').error_kind, row('toolu_red').ghx_outcome], [null, 'ci_red_on_main']);
  assert.deepEqual(
    [row('toolu_policy').error_kind, row('toolu_policy').refusal, row('toolu_policy').ghx_error_code],
    ['command', 'ghx_policy', 'POLICY_MERGE_METHOD'],
  );
});

test('rule 9: cost-state is a cross-check for unresumed sessions only', () => {
  const start = Date.parse(S.ts(0));
  const want = 11_008 / 1e6;
  const cs = (startTime: number) => S.costState({ startTime, total: want, modelUsage: { [OPUS]: { costUSD: want } } });
  const check = (records: Record<string, unknown>[]) => {
    S.resetIds();
    const t = build([{ path: S.mainPath(), records }]);
    return costStateCheck(t.sessions[0] as Tables['sessions'][number], t.api_calls);
  };
  const ok = check([...simpleMain(), cs(start)]);
  assert.ok(ok.usable);
  assert.deepEqual(
    ok.rows.map((r) => [r.model, r.delta]),
    [[OPUS, 0]],
  );
  // Two processes (a resume): the last record covers only the second.
  assert.equal(check([...simpleMain(), cs(start), cs(start + 3_600_000)]).usable, false);
  // One process that started long after the session's first record.
  assert.equal(check([...simpleMain(), cs(start + 3_600_000)]).usable, false);
  // Calls after the last cost-state: a later process never wrote one.
  const tail = S.response({ id: 'msg_later', content: [S.text('later')], usage: S.usage({}), stop: 'end_turn' });
  assert.equal(check([...simpleMain(), cs(start), ...tail]).usable, false);
  assert.equal(check(simpleMain()).usable, false, 'no cost-state at all');
});

test('rule 10: JSONL is read to the last newline; a half-written last line waits for the next read', () => {
  const text = '{"type":"user"}\n{"type":"ai-title","aiTitle":"t"}\nnot json\n{"type":"assist';
  const r = parseJsonlText(text);
  assert.equal(r.records.length, 2);
  assert.equal(r.badLines, 1);
  assert.equal(r.bytes, Buffer.byteLength('{"type":"user"}\n{"type":"ai-title","aiTitle":"t"}\nnot json\n'));
  assert.deepEqual(parseJsonlText('{"a":1}'), { records: [], badLines: 0, bytes: 0 });
});

test('records: unknown types and schema failures are counted, never fatal; loose schemas keep new fields', () => {
  assert.equal(parseRecord({ type: 'brand-new-thing', x: 1 }).type, 'unknown');
  assert.equal(parseRecord({ type: 'mode', mode: 'auto' }).type, 'ignored');
  assert.equal(parseRecord({ type: 'assistant' }).type, 'invalid');
  assert.equal(parseRecord({ type: 'toString' }).type, 'unknown', 'no prototype keys');
  const p = parseRecord({ type: 'ai-title', aiTitle: 'x', futureField: 7 });
  assert.equal(p.type === 'ai-title' && (p.record as Record<string, unknown>).futureField, 7);
  S.resetIds();
  const t = build([{ path: S.mainPath(), records: [...simpleMain(), { type: 'brand-new-thing' }, { type: 'user' }] }]);
  assert.deepEqual(t.counts.unknown_types, { 'brand-new-thing': 1 });
  assert.deepEqual(t.counts.invalid_records, { user: 1 });
  assert.equal(t.api_calls.length, 1);
});

test('rule 4 of §1.2: re-appended metadata takes the last record (ai-title), PR links once each', () => {
  S.resetIds();
  const t = build([
    {
      path: S.mainPath(),
      records: [...simpleMain(), S.aiTitle('First'), S.prLink(12), S.aiTitle('Second'), S.prLink(12), S.prLink(13)],
    },
  ]);
  const s = t.sessions[0];
  assert.equal(s?.title, 'Second');
  assert.deepEqual(
    s?.pr_links.map((p) => p.number),
    [12, 13],
  );
  assert.equal(lastOfType([{ type: 'a', v: 1 }, { type: 'b' }, { type: 'a', v: 2 }] as const, 'a')?.v, 2);
});

test('linkage: meta.toolUseId finds the spawning file (the file beats parentAgentId); skill forks link via the Skill result', () => {
  S.resetIds();
  const parent = 'aparent00000000001';
  const child = 'achild000000000001';
  const skill = 'askill000000000001';
  const files: InputFile[] = [
    {
      path: S.mainPath(),
      records: simpleMain([
        ...S.response({
          id: 'msg_spawn',
          content: [S.toolUse('toolu_parent', 'Agent', { description: 'P', prompt: 'P', run_in_background: 'true' })],
          usage: S.usage({ cacheRead: 12_000, output: 10 }),
        }),
        ...S.response({
          id: 'msg_skill',
          content: [S.toolUse('toolu_skill', 'Skill', { skill: 'code-review' })],
          usage: S.usage({ cacheRead: 12_100, output: 10 }),
        }),
        S.toolResult('toolu_skill', 'Skill "code-review" launched (forked execution, running in the background).', {
          toolUseResult: {
            success: true,
            commandName: 'code-review',
            status: 'forked',
            background: true,
            agentId: skill,
          },
        }),
      ]),
    },
    {
      path: S.agentPath(parent),
      records: [
        S.prompt('P', { agentId: parent }),
        ...S.response({
          id: 'msg_p0',
          agentId: parent,
          content: [S.toolUse('toolu_child', 'Agent', { description: 'C', prompt: 'C' })],
          usage: S.usage({ write5m: 9_000, output: 10 }),
        }),
      ],
    },
    { path: S.agentPath(parent, '.meta.json'), records: [S.agentMeta({ toolUseId: 'toolu_parent' })] },
    { path: S.agentPath(child, '.jsonl'), records: [S.prompt('C', { agentId: child })] },
    {
      path: S.agentPath(child, '.meta.json'),
      records: [S.agentMeta({ toolUseId: 'toolu_child', parentAgentId: 'asomeoneelse0001', spawnDepth: 2 })],
    },
    { path: S.agentPath(skill, '.jsonl'), records: [S.prompt('Review', { agentId: skill })] },
    { path: S.agentPath(skill, '.meta.json'), records: [S.agentMeta({ name: 'code-review' })] },
    { path: S.agentPath(skill, '.forked-skill.json'), records: [{ skillName: 'code-review' }] },
    {
      path: S.agentPath(skill, '.forked-skill.marker.json'),
      records: [{ forkedSkill: true, skillName: 'code-review' }],
    },
  ];
  const t = build(files);
  const a = (id: string) => one(t.agents, (x) => x.agent_id === id);
  assert.deepEqual(
    [a(parent).parent_agent_id, a(parent).spawn_tool_use_id, a(parent).linked_via, a(parent).parent_mismatch],
    [null, 'toolu_parent', 'tool_use_id', false],
  );
  assert.deepEqual([a(child).parent_agent_id, a(child).parent_mismatch, a(child).spawn_depth], [parent, true, 2]);
  assert.deepEqual(
    [a(skill).parent_agent_id, a(skill).linked_via, a(skill).skill_fork, a(skill).spawn_tool],
    [null, 'skill_result', true, 'Skill'],
  );
  assert.equal(one(t.tool_calls, (c) => c.tool_use_id === 'toolu_skill').spawned_agent_id, skill);
  assert.equal(one(t.tool_calls, (c) => c.tool_use_id === 'toolu_parent').run_in_background, true);
  assert.equal(t.counts.parent_mismatches, 1);
  assert.equal(t.counts.unlinked_agents, 0);
  assert.deepEqual(fileKind(S.agentPath(skill, '.forked-skill.marker.json')), {
    kind: 'skill_fork_marker',
    project: S.PROJECT,
    sessionId: S.SESSION,
    agentId: skill,
  });
});

test('turns: main turns by promptId and starter; subagent turns split on non-tool-result prompts', () => {
  S.resetIds();
  const sub = 'asub00000000000002';
  const note = S.notificationText({
    taskId: 'bx',
    toolUseId: 'toolu_bg',
    status: 'completed',
    summary: 'done (exit code 0)',
  });
  const files: InputFile[] = [
    {
      path: S.mainPath(),
      records: [
        ...simpleMain([
          S.prompt('[Request interrupted by user]', { promptId: 'p1', ts: S.ts(0, 9) }),
          S.prompt(note, { promptId: 'p2', origin: 'task-notification', turnOrigin: 'task_notification', ts: S.ts(5) }),
          S.prompt('<command-name>/clear</command-name>', { promptId: 'p3', ts: S.ts(6) }),
          S.prompt('Merge it', { promptId: 'p4', origin: 'human', promptSource: 'suggestion_accepted', ts: S.ts(7) }),
        ]),
      ],
    },
    {
      path: S.agentPath(sub),
      records: [
        S.prompt('Do the thing', { agentId: sub, promptId: 's1', ts: S.ts(1) }),
        S.prompt('<system-reminder>\nReport back.\n</system-reminder>', { agentId: sub, promptId: 's1', isMeta: true }),
        ...S.response({
          id: 'msg_s0',
          agentId: sub,
          ts: S.ts(1, 1),
          content: [S.bash('toolu_s0', 'ls')],
          usage: S.usage({ write5m: 9_000, output: 10 }),
        }),
        S.toolResult('toolu_s0', 'a', { agentId: sub, promptId: 's2' }),
        ...S.response({ id: 'msg_s1', agentId: sub, content: [S.text('ok')], usage: S.usage({}), stop: 'end_turn' }),
        S.prompt(`[SYSTEM NOTIFICATION - NOT USER INPUT]\n${note}`, {
          agentId: sub,
          promptId: 's3',
          isMeta: true,
          origin: 'task-notification',
          ts: S.ts(3),
        }),
        ...S.response({ id: 'msg_s2', agentId: sub, content: [S.text('ok')], usage: S.usage({}), stop: 'end_turn' }),
      ],
    },
  ];
  const t = build(files);
  const main = t.turns.filter((x) => x.agent_id === null);
  assert.deepEqual(
    main.map((x) => [x.prompt_id, x.starter_kind, x.is_human, x.interrupted, x.n_api_calls]),
    [
      ['p1', 'human', true, true, 1],
      ['p2', 'task_notification', false, false, 0],
      ['p3', 'command', false, false, 0],
      ['p4', 'human', true, false, 0],
    ],
  );
  const subTurns = t.turns.filter((x) => x.agent_id === sub);
  assert.deepEqual(
    subTurns.map((x) => [x.starter_kind, x.n_api_calls]),
    [
      ['spawn', 2],
      ['task_notification', 1],
    ],
  );
  assert.equal(one(t.api_calls, (c) => c.message_id === 'msg_s1').turn_id, subTurns[0]?.turn_id);
  assert.equal(t.sessions[0]?.n_human_turns, 2);
});

test('eras: adoption by project and time; dev projects are dogfood-dev; others never-adopted', () => {
  const cfg = { adoptions: { proj: '2026-10-23T18:00:00.000Z' }, devProjectMarkers: ['gh-for-agents'] };
  assert.equal(eraAt('proj', '2026-10-23T17:59:59.000Z', cfg), 'gh-pre');
  assert.equal(eraAt('proj', '2026-10-23T18:00:00.000Z', cfg), 'ghx-post');
  assert.equal(eraAt('-Users-x-gh-for-agents', '2026-10-01T00:00:00.000Z', cfg), 'dogfood-dev');
  assert.equal(eraAt('other', '2026-10-01T00:00:00.000Z', cfg), 'never-adopted');
  assert.equal(eraAt('-Users-benjaminjordan-projects-powerhouse-powerhouse', '2026-10-24T00:00:00Z'), 'ghx-post');
  assert.ok(DEFAULT_ERA_CONFIG.devProjectMarkers.includes('hookspike'));
  S.resetIds();
  const t = buildTables([{ path: S.mainPath(), records: simpleMain() }], { era: cfg });
  assert.equal(t.sessions[0]?.era, 'never-adopted');
});

test('determinism: input order does not change the tables; sessions and files sort by path', () => {
  const files = (): InputFile[] => {
    S.resetIds();
    const other = '0b0b0b0b-1111-4222-8333-444444444444';
    return [
      { path: S.mainPath(), records: simpleMain() },
      { path: S.mainPath(other), records: simpleMain().map((r) => ({ ...r, sessionId: other })) },
    ];
  };
  const a = JSON.stringify(buildTables(files()));
  const b = JSON.stringify(buildTables(files().reverse()));
  assert.equal(a, b);
  assert.deepEqual(
    groupBySession(['p/s2.jsonl', 'p/s1/subagents/agent-a.jsonl', 'p/s1.jsonl']).map((g) => [g.session, g.paths]),
    [
      ['p/s1', ['p/s1.jsonl', 'p/s1/subagents/agent-a.jsonl']],
      ['p/s2', ['p/s2.jsonl']],
    ],
  );
  assert.equal(contextTokens(null), 0);
});
