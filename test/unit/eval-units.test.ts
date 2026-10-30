// ghx-eval M2: units (scripts/eval/units). Synthetic transcripts with known answers for each unit kind:
// glue, slack/gap/prompt/compaction closing, waits keyed by task id, PR attribution, SHA cycles, lifecycles,
// session shares and determinism. Builders: test/fixtures/eval/units/scenarios.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONSTANTS } from '../../scripts/eval/metrics/catalog.ts';
import {
  buildTables,
  headShasIn,
  type InputFile,
  pathsIn,
  prRefsIn,
  type Tables,
} from '../../scripts/eval/model/session.ts';
import { segmentFile } from '../../scripts/eval/units/episode.ts';
import { type BuildUnitsOptions, buildUnits } from '../../scripts/eval/units/index.ts';
import { indexTables } from '../../scripts/eval/units/tables.ts';
import type { Unit } from '../../scripts/eval/units/types.ts';
import { bash, call, ghxStatus, human, main, notify, S, sub, TASKS } from '../fixtures/eval/units/scenarios.ts';

const units = (files: InputFile[], opts: BuildUnitsOptions = { slack: 0 }): Unit[] => {
  S.resetIds();
  return buildUnits(buildTables(files), opts);
};
const tables = (files: InputFile[]): Tables => {
  S.resetIds();
  return buildTables(files);
};
const ofKind = (us: Unit[], kind: Unit['kind']): Unit[] => us.filter((u) => u.kind === kind);
const at = S.ts;

test('glue: redirect-target reads, cat|grep of it, bare sleep and logPath reads join the episode', () => {
  const us = units([
    main([
      human('why did CI fail', 'p1', at(0)),
      bash('msg_1', at(1), 'tu_log', 'gh run view 77 --log-failed > /tmp/w/run.log'),
      call({
        msg: 'msg_2',
        at: at(2),
        tools: [{ id: 'tu_read', name: 'Read', input: { file_path: '/tmp/w/run.log' }, result: 'x'.repeat(220) }],
      }),
      bash('msg_3', at(3), 'tu_grep', 'cat /tmp/w/run.log | grep -n error', 'error: boom'),
      bash('msg_4', at(4), 'tu_sleep', 'sleep 20'),
      bash('msg_5', at(5), 'tu_why', 'ghx ci why 12', '{"logPath":"/tmp/w/ci-12.log","failed":1}'),
      call({
        msg: 'msg_6',
        at: at(6),
        tools: [{ id: 'tu_read2', name: 'Read', input: { file_path: '/tmp/w/ci-12.log' }, result: 'log' }],
      }),
      call({
        msg: 'msg_7',
        at: at(7),
        tools: [{ id: 'tu_edit', name: 'Edit', input: { file_path: '/src/a.ts' }, result: 'ok' }],
      }),
    ]),
  ]);
  const eps = ofKind(us, 'episode');
  assert.equal(eps.length, 1);
  const ep = eps[0] as Unit;
  assert.deepEqual(ep.tool_use_ids, ['tu_log', 'tu_read', 'tu_grep', 'tu_sleep', 'tu_why', 'tu_read2']);
  assert.equal(ep.intent, 'diagnose');
  assert.equal(ep.metrics.gh_tool_calls, 2);
  assert.equal(ep.metrics.glue_calls, 4);
  assert.equal(ep.metrics.follow_reads, 3, 'Read, cat|grep and the logPath Read; sleep is not a read');
  assert.equal(ep.metrics.round_trips, 6);
  assert.ok(ep.flags.includes('closed:tool'));
});

test('glue: a Write whose file the next call sends as --body-file starts the episode', () => {
  const us = units([
    main([
      human('open a PR', 'p1', at(0)),
      call({
        msg: 'msg_1',
        at: at(1),
        tools: [{ id: 'tu_w', name: 'Write', input: { file_path: '/tmp/w/body.md', content: 'Body' }, result: 'ok' }],
      }),
      bash(
        'msg_2',
        at(2),
        'tu_create',
        'gh pr create --title T --body-file /tmp/w/body.md',
        'https://github.com/acme/widgets/pull/41',
      ),
    ]),
  ]);
  const ep = ofKind(us, 'episode')[0] as Unit;
  assert.deepEqual(ep.tool_use_ids, ['tu_w', 'tu_create']);
  assert.equal(ep.intent, 'create');
  assert.equal(ep.pr, 'acme/widgets#41', 'a create names its PR in the output');
  assert.equal(ep.start_ts, at(1));
});

const twoCallsAround = (between: Record<string, unknown>[][], gapMinutes = 1): InputFile =>
  main([
    human('status', 'p1', at(0)),
    bash('msg_a', at(1), 'tu_a', 'gh pr view 12 --json state'),
    ...between,
    bash('msg_b', at(1 + gapMinutes), 'tu_b', 'gh pr view 12 --json state'),
  ]);
const nEpisodes = (f: InputFile, opts?: BuildUnitsOptions): number => ofKind(units([f], opts), 'episode').length;

test('closing: another tool call closes at slack 0 and is tolerated at slack 1', () => {
  const edit = call({
    msg: 'msg_e',
    at: at(1, 30),
    tools: [{ id: 'tu_e', name: 'Edit', input: { file_path: '/src/a.ts' }, result: 'ok' }],
  });
  assert.equal(nEpisodes(twoCallsAround([edit], 2), { slack: 0 }), 2);
  const tolerated = units([twoCallsAround([edit], 2)], { slack: 1 });
  const eps = ofKind(tolerated, 'episode');
  assert.equal(eps.length, 1);
  assert.deepEqual(eps[0]?.tool_use_ids, ['tu_a', 'tu_b'], 'slack calls are in the span, not the unit');
  assert.equal(eps[0]?.metrics.span_calls, 3);
  const twoEdits = [
    edit,
    call({ msg: 'msg_f', at: at(1, 40), tools: [{ id: 'tu_f', name: 'Edit', input: {}, result: 'ok' }] }),
  ];
  assert.equal(nEpisodes(twoCallsAround(twoEdits, 2), { slack: 1 }), 2, 'the second other call closes at slack 1');
});

test('closing: ToolSearch is neutral', () => {
  const ts = call({
    msg: 'msg_t',
    at: at(1, 30),
    tools: [{ id: 'tu_t', name: 'ToolSearch', input: { query: 'x' }, result: 'ok' }],
  });
  assert.equal(nEpisodes(twoCallsAround([ts], 2)), 1);
});

test('closing: a gap over 10 minutes, a human prompt and a compaction each close an episode', () => {
  assert.equal(nEpisodes(twoCallsAround([], 9)), 1);
  assert.equal(nEpisodes(twoCallsAround([], 12)), 2);
  assert.equal(nEpisodes(twoCallsAround([], 12), { slack: 0, gapMs: 30 * 60_000 }), 1);
  assert.equal(nEpisodes(twoCallsAround([human('and now?', 'p2', at(1, 30))], 2)), 2);
  assert.equal(nEpisodes(twoCallsAround([[S.compactBoundary({ ts: at(1, 30) })]], 2)), 2);
});

/** A main thread: status read, background ghx ci wait (task b1), another read, the wake, the output read. */
function waitScenario(triple: boolean): InputFile {
  return main([
    human('wait for CI', 'p1', at(0)),
    bash('msg_1', at(1), 'tu_st', 'ghx pr status 12', ghxStatus(12, 'a'.repeat(40))),
    call({ msg: 'msg_2', at: at(2), tools: [{ id: 'tu_wait', command: 'ghx ci wait 12', result: '', bgTask: 'b1' }] }),
    bash('msg_3', at(3), 'tu_st2', 'ghx pr status 12 --brief', ghxStatus(12, 'a'.repeat(40))),
    notify({
      taskId: 'b1',
      toolUseId: 'tu_wait',
      status: 'completed',
      summary: 'exit code 0',
      at: at(30),
      triple,
      promptId: 'p2',
    }),
    call({
      msg: 'msg_4',
      at: at(31),
      tools: [
        { id: 'tu_out', name: 'Read', input: { file_path: `${TASKS}/b1.output` }, result: '{"outcome":"green"}' },
      ],
      usage: { input: 2, cacheRead: 1_000, write1h: 30_000, output: 30 },
    }),
  ]);
}

test('waits: keyed by task id; launching one leaves the episode open; triple notifications count once', () => {
  for (const triple of [false, true]) {
    const us = units([waitScenario(triple)]);
    const ep = ofKind(us, 'episode');
    assert.equal(ep.length, 1);
    assert.deepEqual(ep[0]?.tool_use_ids, ['tu_st', 'tu_st2']);
    const waits = ofKind(us, 'wait');
    assert.equal(waits.length, 1);
    const w = waits[0] as Unit;
    assert.equal(w.unit_id, 'wait:tu_wait');
    assert.equal(w.category, 'bg-ghx-ci-wait');
    assert.equal(w.intent, 'wait');
    assert.deepEqual(w.tool_use_ids, ['tu_wait', 'tu_out'], 'the output-file read attaches to the wait');
    assert.equal(w.metrics.notifications, 1);
    assert.equal(w.metrics.wakeups, 1);
    assert.equal(w.metrics.bg, 1);
    assert.equal(w.metrics.cache_rewrites, 1, 'the wake call rewrote 30k of 31k context');
    assert.ok(w.flags.includes('closed:notification'));
    assert.equal(w.end_ts, '2026-10-24T10:31:02.000Z');
  }
});

/**
 * Status read, background `ghx ci wait 12` (b1), a status read while waiting, the wake, the output read, a
 * status read on `after`, a merge of #12, an Edit. Everything is inside the 10-minute gap.
 */
function wakeScenario(after = 'ghx pr status 12 --brief'): InputFile {
  const sha = 'a'.repeat(40);
  return main([
    human('land #12', 'p1', at(0)),
    bash('msg_1', at(1), 'tu_st', 'ghx pr status 12', ghxStatus(12, sha)),
    call({ msg: 'msg_2', at: at(2), tools: [{ id: 'tu_wait', command: 'ghx ci wait 12', result: '', bgTask: 'b1' }] }),
    bash('msg_3', at(3), 'tu_st2', 'ghx pr status 12 --brief', ghxStatus(12, sha)),
    notify({ taskId: 'b1', toolUseId: 'tu_wait', status: 'completed', summary: 'exit 0', at: at(5), promptId: 'p2' }),
    call({
      msg: 'msg_4',
      at: at(6),
      tools: [
        { id: 'tu_out', name: 'Read', input: { file_path: `${TASKS}/b1.output` }, result: '{"outcome":"green"}' },
      ],
    }),
    bash('msg_5', at(6, 30), 'tu_st3', after, ghxStatus(12, sha)),
    bash('msg_6', at(7), 'tu_merge', `ghx pr merge 12 --expect-head ${sha.slice(0, 7)}`, '{"merged":true}'),
    call({
      msg: 'msg_7',
      at: at(8),
      tools: [{ id: 'tu_e', name: 'Edit', input: { file_path: '/src/a.ts' }, result: 'ok' }],
    }),
  ]);
}

test('after a wake: a merge opens an after-wake episode linked to the wait; the earlier episode stops', () => {
  const us = units([wakeScenario()]);
  const eps = ofKind(us, 'episode');
  assert.deepEqual(
    eps.map((e) => e.tool_use_ids),
    [['tu_st', 'tu_st2'], ['tu_merge']],
    'without the wake rule the merge would join the open status episode (all inside the gap)',
  );
  const [before, merge] = eps as [Unit, Unit];
  assert.ok(before.flags.includes('closed:wake'));
  assert.ok(!before.flags.includes('after-wake'));
  assert.equal(before.parent_unit_id, null);
  assert.equal(merge.intent, 'merge');
  assert.equal(merge.category, 'merge');
  assert.ok(merge.flags.includes('after-wake'));
  assert.equal(merge.parent_unit_id, 'wait:tu_wait');
  assert.equal(merge.pr, '#12');
  assert.equal(merge.metrics.span_calls, 2, 'the call that emitted the merge and the one that read its result');
});

test('after a wake: the output-file read and a status read on the same target stay in the wait', () => {
  const us = units([wakeScenario()]);
  const w = ofKind(us, 'wait')[0] as Unit;
  assert.deepEqual(w.tool_use_ids, ['tu_wait', 'tu_out', 'tu_st3']);
  assert.equal(w.intent, 'wait');
  assert.equal(w.category, 'bg-ghx-ci-wait');
  assert.equal(w.metrics.gh_tool_calls, 2);
  assert.equal(w.end_ts, at(6, 32), "the attached status read's result");
  assert.ok(!us.some((u) => u.kind === 'episode' && u.tool_use_ids.includes('tu_st3')));
});

test('after a wake: the wait is charged up to the read of its last attached call, not the merge', () => {
  const us = units([wakeScenario()]);
  const w = ofKind(us, 'wait')[0] as Unit;
  // msg_2 launch, msg_3 reads its placeholder, msg_4 the wake (emits the output read), msg_5 reads it and emits
  // the status read, msg_6 reads that (and emits the merge). msg_7, which reads the merge, is not the wait's.
  assert.equal(w.metrics.span_calls, 5);
  assert.equal(w.metrics.round_trips, 3, 'msg_2, msg_4, msg_5 emitted its calls');
  const merge = ofKind(us, 'episode').find((e) => e.intent === 'merge') as Unit;
  const one = (merge.metrics.cost as number) / 2;
  assert.ok(Math.abs((w.metrics.cost as number) - 5 * one) < 1e-9, 'every call has the same usage');
});

test('after a wake: a status read on another PR is not about the wait and opens an after-wake episode', () => {
  const us = units([wakeScenario('ghx pr status 13 --brief')]);
  const w = ofKind(us, 'wait')[0] as Unit;
  assert.deepEqual(w.tool_use_ids, ['tu_wait', 'tu_out']);
  const eps = ofKind(us, 'episode');
  assert.deepEqual(
    eps.map((e) => [e.tool_use_ids, e.intent, e.parent_unit_id]),
    [
      [['tu_st', 'tu_st2'], 'status', null],
      [['tu_st3', 'tu_merge'], 'merge', 'wait:tu_wait'],
    ],
    'the episode the status read opened takes the merge by the normal rules',
  );
  assert.ok(eps[1]?.flags.includes('after-wake'));
});

test('after a wake: any other tool call in between ends the wake', () => {
  const eps = ofKind(units([wakeScenario('git push')]), 'episode');
  assert.deepEqual(
    eps.map((e) => [e.tool_use_ids, e.parent_unit_id]),
    [
      [['tu_st', 'tu_st2'], null],
      [['tu_merge'], null],
    ],
  );
  assert.ok(eps[0]?.flags.includes('closed:tool'));
  assert.ok(!eps[1]?.flags.includes('after-wake'));
});

test('waits: TaskStop closes an open wait; Monitor waits are their own mechanism', () => {
  const us = units([
    main([
      human('watch', 'p1', at(0)),
      call({
        msg: 'msg_1',
        at: at(1),
        tools: [
          {
            id: 'tu_mon',
            name: 'Monitor',
            input: { command: 'while true; do gh pr checks 12; sleep 60; done' },
            result: 'started',
            bgTask: 'm1',
          },
        ],
      }),
      notify({ taskId: 'm1', toolUseId: 'tu_mon', status: 'running', summary: 'event', at: at(3), promptId: 'p2' }),
      call({
        msg: 'msg_2',
        at: at(4),
        tools: [{ id: 'tu_stop', name: 'TaskStop', input: { task_id: 'm1' }, result: 'stopped' }],
      }),
    ]),
  ]);
  const w = ofKind(us, 'wait')[0] as Unit;
  assert.equal(w.category, 'monitor');
  assert.deepEqual(w.tool_use_ids, ['tu_mon', 'tu_stop']);
  assert.ok(w.flags.includes('closed:TaskStop'));
  assert.equal(w.metrics.monitor, 1);
});

test('waits: a foreground polling episode gets a derived wait view', () => {
  const us = units([
    main([human('poll', 'p1', at(0)), bash('msg_1', at(1), 'tu_loop', 'until gh pr checks 12; do sleep 30; done')]),
  ]);
  const w = ofKind(us, 'wait')[0] as Unit;
  assert.equal(w.category, 'fg-sleep-loop');
  assert.ok(w.flags.includes('derived'));
  assert.deepEqual(w.children, ['episode:tu_loop']);
});

test('PRs: multi-pr flag, charge to the last PR named, unrelated reads stay unattributed', () => {
  const us = units([
    main([
      human('go', 'p1', at(0)),
      bash('msg_1', at(1), 'tu_1', 'gh pr view 12 --json state; gh pr view 13 --json state'),
      call({ msg: 'msg_e', at: at(2), tools: [{ id: 'tu_e', name: 'Edit', input: {}, result: 'ok' }] }),
      bash('msg_2', at(3), 'tu_2', 'gh run list --branch feat --json status'),
      call({ msg: 'msg_f', at: at(4), tools: [{ id: 'tu_f', name: 'Edit', input: {}, result: 'ok' }] }),
      bash('msg_3', at(5), 'tu_3', 'gh issue list'),
    ]),
  ]);
  const [a, b, c] = ofKind(us, 'episode');
  assert.equal(a?.pr, '#13');
  assert.ok(a?.flags.includes('multi-pr'));
  assert.equal(b?.pr, '#13');
  assert.ok(b?.flags.includes('charged-to-last-pr'));
  assert.equal(c?.pr, null);
});

const failing = (msg: string, when: string, id: string, command: string, code = 'VALIDATION') =>
  call({
    msg,
    at: when,
    tools: [{ id, command, isError: true, result: `Exit code 2\n{"error":{"code":"${code}","message":"m"}}` }],
  });
const edit = (msg: string, id: string, when: string) =>
  call({ msg, at: when, tools: [{ id, name: 'Edit', input: { file_path: '/src/a.ts' }, result: 'ok' }] });

test('PRs: a failed or dry-run create is the PR the next create in its file produced, not the last PR named', () => {
  const us = units([
    main([
      human('next PR', 'p1', at(0)),
      bash('msg_1', at(1), 'tu_st', 'ghx pr status 3287', ghxStatus(3287, 'a'.repeat(40))),
      edit('msg_e1', 'tu_e1', at(2)),
      failing('msg_2', at(3), 'tu_dry1', 'ghx pr create --input /tmp/w/pr.json --dry-run'),
      bash('msg_3', at(4), 'tu_dry2', 'ghx pr create --input /tmp/w/pr.json --dry-run', '{"preview":{}}'),
      bash(
        'msg_4',
        at(5),
        'tu_create',
        'ghx pr create --input /tmp/w/pr.json',
        '{"url":"https://github.com/acme/widgets/pull/3288"}',
      ),
      edit('msg_e2', 'tu_e2', at(6)),
      failing('msg_5', at(7), 'tu_other', 'gh pr create --head feat-b --title T --body B'),
    ]),
  ]);
  const [status, create, other] = ofKind(us, 'episode') as [Unit, Unit, Unit];
  assert.equal(status.pr, 'acme/widgets#3287');
  assert.equal(create.pr, 'acme/widgets#3288');
  assert.ok(create.flags.includes('create-forward'));
  assert.ok(!create.flags.includes('charged-to-last-pr') && !create.flags.includes('multi-pr'));
  assert.deepEqual([create.metrics.mistakes, create.metrics.dry_run_mistakes, create.metrics.first_try], [1, 1, 0]);
  assert.equal(other.pr, null, 'a create whose PR never showed up is charged to no PR');
  assert.ok(!other.flags.includes('charged-to-last-pr'));
  const life = new Map(ofKind(us, 'pr_lifecycle').map((u) => [u.pr, u]));
  assert.deepEqual([...life.keys()], ['acme/widgets#3287', 'acme/widgets#3288']);
  assert.deepEqual(life.get('acme/widgets#3287')?.tool_use_ids, ['tu_st']);
  assert.deepEqual(life.get('acme/widgets#3288')?.tool_use_ids, ['tu_dry1', 'tu_dry2', 'tu_create']);
  assert.ok(life.get('acme/widgets#3288')?.flags.includes('created'));
  assert.ok(!life.get('acme/widgets#3287')?.flags.includes('created'));
});

test('PRs: a create attempt with another --head is not the next create’s PR', () => {
  const us = units([
    main([
      human('two PRs', 'p1', at(0)),
      failing('msg_1', at(1), 'tu_a', 'gh pr create --head feat-a --title T --body B', 'X'),
      bash('msg_2', at(2), 'tu_b', 'gh pr create --head feat-b --title T --body B', 'https://github.com/acme/w/pull/7'),
    ]),
  ]);
  const ep = ofKind(us, 'episode')[0] as Unit;
  assert.ok(!ep.flags.includes('create-forward'));
  assert.equal(ep.pr, 'acme/w#7', 'the unit still names #7 through the second create');
});

test('PRs: a call naming no PR takes its own unit’s PR, not the one its file named last', () => {
  const us = units([
    main([
      human('next PR', 'p1', at(0)),
      bash('msg_1', at(1), 'tu_v', 'gh pr view 40 --json state'),
      edit('msg_e', 'tu_e', at(2)),
      bash('msg_2', at(3), 'tu_help', 'ghx pr create --help', '{"name":"pr create"}'),
      bash('msg_3', at(4), 'tu_c', 'ghx pr create --input pr.json', 'https://github.com/acme/w/pull/41'),
    ]),
  ]);
  const life = new Map(ofKind(us, 'pr_lifecycle').map((u) => [u.pr, u.tool_use_ids]));
  assert.deepEqual(life.get('acme/w#40'), ['tu_v'], 'the --help call no longer drags the create episode into #40');
  assert.deepEqual(life.get('acme/w#41'), ['tu_help', 'tu_c']);
});

test('PRs: a wait on main-branch CI after a merge is no PR’s work and has its own intent', () => {
  const us = units([
    main([
      human('land #12', 'p1', at(0)),
      bash('msg_1', at(1), 'tu_merge', 'ghx pr merge 12', '{"merged":true,"mergeCommit":"abc1234"}'),
      call({
        msg: 'msg_2',
        at: at(2),
        tools: [{ id: 'tu_mw', command: 'ghx ci wait branch:main@abc1234 --until settled', result: '', bgTask: 'b1' }],
      }),
      notify({ taskId: 'b1', toolUseId: 'tu_mw', status: 'completed', summary: 'exit 0', at: at(9), promptId: 'p2' }),
      call({
        msg: 'msg_3',
        at: at(10),
        tools: [{ id: 'tu_out', name: 'Read', input: { file_path: `${TASKS}/b1.output` }, result: '{}' }],
      }),
      bash('msg_4', at(10, 30), 'tu_runs', 'ghx run list --branch main --limit 3', '[]'),
    ]),
  ]);
  const w = ofKind(us, 'wait')[0] as Unit;
  assert.deepEqual(w.tool_use_ids, ['tu_mw', 'tu_out', 'tu_runs'], 'a read of main after the wake stays with it');
  assert.deepEqual([w.intent, w.category, w.pr], ['main_ci', 'bg-ghx-ci-wait', null]);
  assert.ok(!w.flags.includes('charged-to-last-pr'));
  assert.deepEqual(ofKind(us, 'pr_lifecycle')[0]?.tool_use_ids, ['tu_merge']);
  assert.equal(w.metrics.first_try, 1);
});

test('PR cycles: split by head SHA; units before the first SHA join it', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const edit = (m: string, t: string, when: string) =>
    call({ msg: m, at: when, tools: [{ id: t, name: 'Edit', input: {}, result: 'ok' }] });
  const us = units([
    main([
      human('land it', 'p1', at(0)),
      bash('msg_0', at(1), 'tu_0', 'ghx pr status 12', '{"pr":{"number":12}}'),
      edit('msg_e0', 'tu_e0', at(2)),
      bash('msg_1', at(3), 'tu_1', 'ghx pr status 12', ghxStatus(12, A)),
      bash('msg_push', at(4), 'tu_push', 'git push'),
      bash('msg_2', at(5), 'tu_2', 'ghx pr status 12', ghxStatus(12, B)),
      edit('msg_e1', 'tu_e1', at(6)),
      bash('msg_3', at(7), 'tu_3', 'ghx pr status 12', '{"pr":{"number":12}}'),
    ]),
  ]);
  const cycles = ofKind(us, 'pr_cycle');
  assert.deepEqual(
    cycles.map((c) => [c.unit_id, c.children.length]),
    [
      [`pr_cycle:${S.SESSION}:main:#12:aaaaaaa`, 2],
      [`pr_cycle:${S.SESSION}:main:#12:bbbbbbb`, 2],
    ],
  );
  assert.ok(cycles.every((c) => c.metrics.rounds === 1 && !c.flags.includes('sha-fallback')));
  const life = ofKind(us, 'pr_lifecycle')[0] as Unit;
  assert.equal(life.metrics.rounds, 2);
});

test('PR cycles: with no SHA in sight they split at git push and say so', () => {
  const us = units([
    main([
      human('land it', 'p1', at(0)),
      bash('msg_1', at(1), 'tu_1', 'gh pr checks 12'),
      bash('msg_push', at(2), 'tu_push', 'git push origin feat'),
      bash('msg_2', at(3), 'tu_2', 'gh pr checks 12'),
    ]),
  ]);
  const cycles = ofKind(us, 'pr_cycle');
  assert.equal(cycles.length, 2);
  assert.ok(cycles.every((c) => c.flags.includes('sha-fallback')));
  assert.equal(ofKind(us, 'pr_lifecycle')[0]?.metrics.rounds, 2, '1 + one push during the lifecycle');
});

test('PR lifecycles span main and subagents; created and merged come from calls on that PR', () => {
  const us = units([
    main([
      human('ship', 'p1', at(0)),
      bash('msg_1', at(1), 'tu_create', 'gh pr create --title T --body B', 'https://github.com/acme/widgets/pull/41'),
      bash('msg_2', at(20), 'tu_merge', 'gh pr merge 41 --squash', 'merged'),
    ]),
    sub('a1', [
      [S.prompt('watch CI for #41', { agentId: 'a1', ts: at(2) })],
      bash('msg_s1', at(3), 'tu_s1', 'gh pr checks 41', 'pass', 'a1'),
    ]),
  ]);
  const lifes = ofKind(us, 'pr_lifecycle');
  assert.equal(lifes.length, 1);
  const l = lifes[0] as Unit;
  assert.equal(l.pr, 'acme/widgets#41');
  assert.deepEqual(l.tool_use_ids, ['tu_create', 'tu_merge', 'tu_s1']);
  for (const f of ['created', 'merged', 'mixed-context']) assert.ok(l.flags.includes(f), f);
  assert.equal(l.metrics.units, 3);
});

test('session units: GitHub share of calls and cost, human turns from the session', () => {
  const us = units([
    main([
      human('status', 'p1', at(0)),
      bash('msg_1', at(1), 'tu_1', 'gh pr view 12 --json state'),
      call({ msg: 'msg_2', at: at(2), tools: [{ id: 'tu_e', name: 'Edit', input: {}, result: 'ok' }] }),
      call({ msg: 'msg_3', at: at(3), tools: [{ id: 'tu_e2', name: 'Edit', input: {}, result: 'ok' }] }),
      call({ msg: 'msg_4', at: at(4), tools: [{ id: 'tu_e3', name: 'Edit', input: {}, result: 'ok' }] }),
    ]),
  ]);
  const s = ofKind(us, 'session')[0] as Unit;
  assert.equal(s.metrics.api_calls, 4);
  assert.equal(s.metrics.span_calls, 2, 'the gh call and the call that read its result');
  assert.equal(s.metrics.gh_share_calls, 0.5);
  assert.equal(s.metrics.human_turns, 1);
  assert.ok(Math.abs((s.metrics.gh_share_cost as number) - 0.5) < 1e-9, 'four calls with equal usage');
});

test('determinism: same tables, same units in the same order; ids derive from content', () => {
  const files = [waitScenario(true)];
  const a = units(files);
  const b = units([...files].reverse());
  assert.deepEqual(a, b);
  assert.deepEqual(
    a.map((u) => u.unit_id),
    // Roll-ups start where their first child starts, so they sort next to it.
    [
      'episode:tu_st',
      `pr_cycle:${S.SESSION}:main:#12:aaaaaaa`,
      `pr_lifecycle:${S.SESSION}:#12`,
      `session:${S.SESSION}`,
      'wait:tu_wait',
    ],
  );
});

test('segmentFile: an output-file Read is glue of the wait it reads', () => {
  const idx = indexTables(tables([waitScenario(false)]));
  const seg = idx.fileOrder.flatMap((file) =>
    segmentFile(idx.files.get(file)!, { slack: 0, gapMs: CONSTANTS.EPISODE_GAP_MS }),
  );
  assert.deepEqual(
    seg.map((e) => [e.kind, e.closed_by]),
    [
      ['wait_bg', 'notification:completed'],
      ['contiguous', 'eof'],
    ],
    "the output-file Read is the wait's glue, so it does not close the episode",
  );
});

test('M1 row extensions: wake call indexes, PR refs, head SHAs and output paths', () => {
  const t = tables([waitScenario(true)]);
  const w = t.tool_calls.find((x) => x.tool_use_id === 'tu_wait');
  assert.deepEqual(w?.notif_wake_call_indexes, [3], 'the first copy in the file wakes call 3 (msg_4)');
  assert.deepEqual(prRefsIn('see https://github.com/acme/widgets/pull/41 and github.com/a/b/pull/7'), [
    'acme/widgets#41',
    'a/b#7',
  ]);
  const sha = 'c'.repeat(40);
  assert.deepEqual(headShasIn(`{"headRefOid": "${sha}"}`, null), [sha]);
  assert.deepEqual(headShasIn(`${sha}\n`, 'gh pr view 1 --json headRefOid -q .headRefOid'), [sha]);
  assert.deepEqual(headShasIn(`${sha}\n`, 'git log -1'), [], 'a bare SHA counts only when the command asked for one');
  assert.deepEqual(pathsIn('Full log saved to /tmp/w/x.log\n{"logPath": "/tmp/w/y.log"}'), [
    '/tmp/w/x.log',
    '/tmp/w/y.log',
  ]);
});
