// M5 done-when (07): a session with GHX_HOOK_LOG and GHX_LOG both on joins every ghx call to its
// tool_use. The hook lines come from the real hook, the invocation lines from withInvocationLog, each
// on a FakeClock at the time the session would produce them; joinInvocations (src/hook/join.ts, which
// documents the rule) must give each invocation its tool_use_id.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createMemorySink } from '../../../src/core/output.ts';
import { ghxCalls, joinInvocations } from '../../../src/hook/join.ts';
import type { HookLogLine } from '../../../src/hook/log.ts';
import { type InvocationLogLine, withInvocationLog } from '../../../src/proc/invocation-log.ts';
import { FakeClock } from '../../helpers/fake-clock.ts';
import { FakeProc } from '../../helpers/fake-proc.ts';
import { runInProcess } from '../../helpers/harness.ts';

const tmp = mkdtempSync(join(tmpdir(), 'ghx-join-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const REPO = join(tmp, 'repo');
mkdirSync(join(REPO, '.git'), { recursive: true });
mkdirSync(join(REPO, '.github'));
writeFileSync(join(REPO, '.github', 'ghx.json'), '{}\n');

const T0 = Date.UTC(2026, 9, 29, 9, 0, 0);
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

const read = <T>(p: string): T[] =>
  readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as T);

/** The hook sees one Bash tool_use at T0 + s seconds. */
async function toolUse(log: string, s: number, id: string, command: string, session = S1): Promise<void> {
  const event = {
    session_id: session,
    tool_use_id: id,
    cwd: REPO,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
  };
  await runInProcess(['hook', 'claude-pretooluse'], {
    stdin: JSON.stringify(event),
    env: { GHX_HOOK_LOG: log },
    clock: new FakeClock(T0 + s * 1000),
  });
}

/** ghx runs `argv` at T0 + s seconds, making one gh call. */
async function ghx(log: string, s: number, argv: string[], session: string | null = S1): Promise<void> {
  const env: Record<string, string> = session === null ? {} : { CLAUDE_CODE_SESSION_ID: session };
  const proc = new FakeProc().on({ cmd: 'gh' }, { stdout: '{}' }).runner();
  const l = withInvocationLog(
    { proc, stdout: createMemorySink() },
    { path: log, argv, cwd: REPO, env, clock: new FakeClock(T0 + s * 1000), version: '0.0.0' },
  );
  await l.deps.proc({ cmd: 'gh', args: ['api', 'x'], env: {}, signal: new AbortController().signal });
  await l.deps.stdout.writeLine('{}');
  l.finish(0);
}

test('every ghx call in a session joins to the tool_use that ran it', async () => {
  const hookLog = join(tmp, 'hook.ndjson');
  const ghxLog = join(tmp, 'ghx.ndjson');
  // A raw gh read the hook denies, then the ghx call it named.
  await toolUse(hookLog, 0, 'toolu_01', 'gh pr view 12 --json state');
  await toolUse(hookLog, 1, 'toolu_02', 'ghx pr status 12');
  await ghx(ghxLog, 1.2, ['pr', 'status', '12']);
  // A foreground ci wait the hook moves to the background (rewrite).
  await toolUse(hookLog, 2, 'toolu_03', 'ghx ci wait 12');
  await ghx(ghxLog, 2.1, ['ci', 'wait', '12']);
  // Two ghx calls in one command: two slots in one tool_use.
  await toolUse(hookLog, 3, 'toolu_04', 'cd sub && ghx pr status 12 && ghx ci why 12 --brief');
  await ghx(ghxLog, 3.1, ['pr', 'status', '12']);
  await ghx(ghxLog, 3.4, ['ci', 'why', '12', '--brief']);
  // A polling loop with a ghx call in it is denied, so it never ran.
  await toolUse(hookLog, 4, 'toolu_05', 'while true; do ghx pr status 12; sleep 30; done');
  // The same command again later: the nearest preceding tool_use wins.
  await toolUse(hookLog, 5, 'toolu_06', 'ghx pr status 12');
  await ghx(ghxLog, 5.3, ['pr', 'status', '12']);
  // Dev checkout: node bin/ghx.js counts as ghx.
  await toolUse(hookLog, 6, 'toolu_07', "node bin/ghx.js pr create --input '/tmp/a b.json'");
  await ghx(ghxLog, 6.2, ['pr', 'create', '--input', '/tmp/a b.json']);
  // Another session runs the same argv at the same moment: no cross-join.
  await toolUse(hookLog, 5, 'toolu_s2', 'ghx pr status 12', S2);
  await ghx(ghxLog, 5.3, ['pr', 'status', '12'], S2);

  const hooks = read<HookLogLine>(hookLog);
  assert.deepEqual(
    hooks.map((h) => [h.tool_use_id, h.decision, h.rule]),
    [
      ['toolu_01', 'deny', 'replaces'],
      ['toolu_02', 'allow', null],
      ['toolu_03', 'rewrite', 'ci-wait-background'],
      ['toolu_04', 'allow', null],
      ['toolu_05', 'deny', 'poll-loop'],
      ['toolu_06', 'allow', null],
      ['toolu_07', 'allow', null],
      ['toolu_s2', 'allow', null],
    ],
  );
  const joined = joinInvocations(hooks, read<InvocationLogLine>(ghxLog));
  assert.deepEqual(
    joined.map((j) => [j.invocation.session_id, j.invocation.argv.join(' '), j.tool_use_id, j.by]),
    [
      [S1, 'pr status 12', 'toolu_02', 'session_id'],
      [S1, 'ci wait 12', 'toolu_03', 'session_id'],
      [S1, 'pr status 12', 'toolu_04', 'session_id'],
      [S1, 'ci why 12 --brief', 'toolu_04', 'session_id'],
      [S1, 'pr status 12', 'toolu_06', 'session_id'],
      [S1, 'pr create --input /tmp/a b.json', 'toolu_07', 'session_id'],
      [S2, 'pr status 12', 'toolu_s2', 'session_id'],
    ],
  );
  assert.ok(joined.every((j) => j.invocation.calls.length === 1));
});

test('without CLAUDE_CODE_SESSION_ID the join falls back to cwd plus time', async () => {
  const hookLog = join(tmp, 'hook-cwd.ndjson');
  const ghxLog = join(tmp, 'ghx-cwd.ndjson');
  await toolUse(hookLog, 0, 'toolu_a', 'ghx ci why 7');
  await ghx(ghxLog, 0.5, ['ci', 'why', '7'], null);
  await ghx(ghxLog, 9, ['ci', 'why', '7'], null);
  const [first, second] = joinInvocations(read<HookLogLine>(hookLog), read<InvocationLogLine>(ghxLog));
  assert.deepEqual([first?.tool_use_id, first?.by], ['toolu_a', 'cwd']);
  assert.deepEqual([second?.tool_use_id, second?.by], [null, null], 'one tool_use, one ghx call: the slot is used');
});

test('unjoinable: a call before its hook line, and shell-expanded arguments', async () => {
  const hookLog = join(tmp, 'hook-un.ndjson');
  const ghxLog = join(tmp, 'ghx-un.ndjson');
  await ghx(ghxLog, 0, ['pr', 'status', '1']);
  await toolUse(hookLog, 1, 'toolu_x', 'ghx pr status 1');
  await toolUse(hookLog, 2, 'toolu_y', 'ghx pr status $PR');
  await ghx(ghxLog, 2.5, ['pr', 'status', '3']);
  const joined = joinInvocations(read<HookLogLine>(hookLog), read<InvocationLogLine>(ghxLog));
  assert.deepEqual(
    joined.map((j) => j.tool_use_id),
    [null, null],
  );
});

test('ghxCalls finds ghx behind wrappers, paths and the dev bin', () => {
  assert.deepEqual(ghxCalls('timeout 600 /usr/local/bin/ghx ci wait 3 && echo done'), [['ci', 'wait', '3']]);
  assert.deepEqual(ghxCalls('node ./bin/ghx.js pr status 1 | cat'), [['pr', 'status', '1']]);
  assert.deepEqual(ghxCalls('gh pr view 1'), []);
});
