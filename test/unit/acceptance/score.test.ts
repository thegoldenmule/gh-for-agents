// The acceptance scorer (03 §8.2, M12.4) over synthetic session JSONL in Claude Code 2.1.280's shapes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { score, scoreSession } from '../../../scripts/acceptance/score.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const FIX = join(ROOT, 'test', 'fixtures', 'acceptance');
const session = (name: string) => scoreSession(name, readFileSync(join(FIX, name), 'utf8'));

test('pass-session.jsonl: two background waits, one diagnosis call, five GitHub calls end to end', () => {
  const s = session('pass-session.jsonl');
  assert.equal(s.pass, true, JSON.stringify(s, null, 2));
  assert.deepEqual(
    s.waits.map((w) => [w.taskId, w.background, w.notifications, w.calls, w.pass]),
    [
      ['bsyn0001', true, 1, 1, true],
      ['bsyn0002', true, 1, 1, true],
    ],
  );
  assert.equal(s.metrics.githubCallsToDiagnose.value, 1);
  assert.equal(s.metrics.githubCallsEndToEnd.value, 5);
  assert.equal(s.metrics.rawGh.value, 0);
  assert.equal(s.metrics.wrappedGhx.value, 0);
  assert.equal(s.metrics.harnessRefusals.value, 0);
});

test('pass-session.jsonl: the absorbed notification (queued_command attachment) counts exactly once', () => {
  const s = session('pass-session.jsonl');
  assert.equal(s.waits[1]?.notifications, 1);
});

test('fail-session.jsonl: every failing metric is reported', () => {
  const s = session('fail-session.jsonl');
  assert.equal(s.pass, false);
  const [foreground, watched] = s.waits;
  assert.equal(foreground?.background, false, 'the tool_result was the summary, not "Command running in background"');
  assert.ok(foreground?.violations.some((v) => v.startsWith('not in the background')));
  assert.equal(watched?.notifications, 2);
  const v = watched?.violations.join('\n') ?? '';
  assert.match(v, /2 task notifications/);
  assert.match(v, /Monitor call during the wait/);
  assert.match(v, /Read of the task output file .*bsyn0003\.output/);
  assert.match(v, /sleep during the wait: sleep 120/);
  assert.equal(s.metrics.githubCallsToDiagnose.value, 4);
  assert.equal(s.metrics.githubCallsToDiagnose.pass, false);
  assert.equal(s.metrics.rawGh.value, 3);
  assert.deepEqual(s.metrics.wrappedGhx.examples, ['ghx pr status 3266 -R octo/demo | jq .ci']);
  assert.equal(s.metrics.harnessRefusals.value, 1);
});

test('resume-session.jsonl: an identical re-run after exit 15 is the same wait', () => {
  const s = session('resume-session.jsonl');
  assert.equal(s.pass, true);
  assert.equal(s.waits.length, 1);
  assert.equal(s.waits[0]?.calls, 2);
  assert.equal(s.metrics.githubCallsToDiagnose.pass, null, 'no source edit: not applicable');
});

// Inline sessions for the smaller rules.
const use = (id: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });
const result = (id: string, content: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: false }] },
    ...extra,
  });
const bg = (id: string, task: string) =>
  result(id, `Command running in background with ID: ${task}. Output is being written to: /x/tasks/${task}.output.`, {
    toolUseResult: { backgroundTaskId: task },
  });
const note = (task: string, code: number) =>
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: `<task-notification>\n<task-id>${task}</task-id>\n<status>${code === 0 ? 'completed' : 'failed'}</status>\n<summary>Background command "w" failed with exit code ${code}</summary>\n</task-notification>`,
    },
    origin: { kind: 'task-notification' },
  });

test('without queue operations, delivered notification records are counted (stream-json and older sessions)', () => {
  const s = scoreSession(
    'inline',
    [use('t1', 'Bash', { command: 'ghx ci wait 7' }), bg('t1', 'k1'), note('k1', 10)].join('\n'),
  );
  assert.deepEqual(
    s.waits.map((w) => [w.notifications, w.pass]),
    [[1, true]],
  );
});

test('a second identical ghx ci wait before the notification fails the first wait', () => {
  const s = scoreSession(
    'inline',
    [
      use('t1', 'Bash', { command: 'ghx ci wait 7' }),
      bg('t1', 'k1'),
      use('t2', 'Bash', { command: 'ghx ci wait 7' }),
      bg('t2', 'k2'),
      note('k1', 0),
      note('k2', 0),
    ].join('\n'),
  );
  assert.match(s.waits[0]?.violations.join('\n') ?? '', /second identical ghx ci wait/);
});

test('a wait that never notifies fails; a Monitor-run wait fails', () => {
  const none = scoreSession('inline', [use('t1', 'Bash', { command: 'ghx ci wait 7' }), bg('t1', 'k1')].join('\n'));
  assert.match(none.waits[0]?.violations.join('\n') ?? '', /0 task notifications/);
  const mon = scoreSession('inline', [use('t1', 'Monitor', { command: 'ghx ci wait 7', timeout_ms: 1 })].join('\n'));
  assert.match(mon.waits[0]?.violations.join('\n') ?? '', /ran under Monitor/);
});

test('pipes, sleep, timeout, --jq and perl alarm around ghx are counted; plain ghx is not', () => {
  const cmds = [
    'ghx pr status 7 | head -50',
    'sleep 60 && ghx pr status 7',
    'timeout 600 ghx ci wait 7',
    'ghx api repos/o/r/pulls/7 --jq .state',
    "perl -e 'alarm shift; exec @ARGV' 600 ghx ci wait 7",
    'ghx pr status 7',
    'ghx pr status 7 > /tmp/s.json',
  ];
  const s = scoreSession('inline', cmds.map((c, i) => use(`t${i}`, 'Bash', { command: c })).join('\n'));
  assert.deepEqual(s.metrics.wrappedGhx.examples, cmds.slice(0, 5));
});

test('raw gh counts every gh call, including wrapped and chained ones; discovery ghx calls touch no GitHub', () => {
  const s = scoreSession(
    'inline',
    [
      use('t1', 'Bash', { command: 'git push && gh pr view 7' }),
      use('t2', 'Bash', { command: 'X=$(gh api repos/o/r/pulls/7)' }),
      use('t3', 'Bash', { command: 'ghx --help' }),
      use('t4', 'Bash', { command: 'ghx pr create --schema' }),
      use('t5', 'Bash', { command: 'echo "gh pr view 7"' }),
    ].join('\n'),
  );
  assert.equal(s.metrics.rawGh.value, 2);
  assert.equal(s.metrics.githubCallsEndToEnd.value, 2);
});

test('a Write of a ghx --input file is not the first source edit', () => {
  const s = scoreSession(
    'inline',
    [
      use('t1', 'Bash', { command: 'ghx ci why 7' }),
      use('t2', 'Write', { file_path: '/repo/comment.json', content: '{}' }),
      use('t3', 'Bash', { command: 'ghx pr comment 7 --input comment.json' }),
      use('t4', 'Edit', { file_path: '/repo/src/sum.ts', old_string: 'a', new_string: 'b' }),
    ].join('\n'),
  );
  assert.equal(s.metrics.githubCallsToDiagnose.value, 2);
});

test('hook and permission refusals are harness refusals', () => {
  const refused = (id: string, text: string) =>
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: true }] },
    });
  const s = scoreSession(
    'inline',
    [
      use('t1', 'Bash', { command: 'gh pr merge 7' }),
      refused('t1', 'Permission to use Bash with command gh pr merge 7 has been denied.'),
      use('t2', 'Bash', { command: 'gh pr checks 7' }),
      refused('t2', 'PreToolUse:Bash hook error: Use: ghx ci wait 7'),
      use('t3', 'Bash', { command: 'false' }),
      refused('t3', 'Exit code 1'),
    ].join('\n'),
  );
  assert.equal(s.metrics.harnessRefusals.value, 2);
});

test('score(): passes only when every session passes; unparsable lines are counted, not fatal', () => {
  const pass = { path: 'p', content: readFileSync(join(FIX, 'pass-session.jsonl'), 'utf8') };
  const fail = { path: 'f', content: readFileSync(join(FIX, 'fail-session.jsonl'), 'utf8') };
  assert.equal(score([pass]).pass, true);
  assert.equal(score([pass, fail]).pass, false);
  assert.equal(score([]).pass, false);
  assert.equal(scoreSession('x', `${pass.content}not json\n`).unparsedLines, 1);
});

test('the CLI prints a JSON report and exits 0 on pass, 1 on fail, 2 without a readable file', () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [join(ROOT, 'scripts', 'acceptance', 'score.ts'), ...args], { encoding: 'utf8' });
  const ok = run(join(FIX, 'pass-session.jsonl'));
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).pass, true);
  assert.equal(run(join(FIX, 'pass-session.jsonl'), join(FIX, 'fail-session.jsonl')).status, 1);
  assert.equal(run().status, 2);
  assert.equal(run(join(FIX, 'missing.jsonl')).status, 2);
});
