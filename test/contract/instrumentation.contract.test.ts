// GHX_LOG and GHX_HOOK_LOG through the real bin (07 M5): off by default, stdout byte-identical with them
// on, the nested gh call recorded, a bad path harmless, and the hook process kept out of GHX_LOG.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { HookLogLine } from '../../src/hook/log.ts';
import type { InvocationLogLine } from '../../src/proc/invocation-log.ts';
import { spawnGhx } from '../helpers/spawn.ts';

const tmp = mkdtempSync(join(tmpdir(), 'ghx-instr-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
function dir(): { dir: string; env: Record<string, string> } {
  const d = join(tmp, String(++seq));
  mkdirSync(d, { recursive: true });
  return {
    dir: d,
    env: { GHX_FAKE_SCENARIO: 'passthrough', GHX_FAKE_LOG: join(d, 'fake.ndjson'), GHX_FAKE_STATE: d },
  };
}
const readLog = <T>(p: string): T[] =>
  readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as T);

const ARGV = ['pr', 'list', '--json', 'number,title', '-R', 'octo/demo'];

test('GHX_LOG: off by default, one line with the gh call when set, stdout unchanged', async () => {
  const off = dir();
  const plain = await spawnGhx(ARGV, { fakeGh: true, env: off.env, cwd: off.dir });
  assert.equal(plain.exitCode, 0, plain.stdout);
  assert.deepEqual(readdirSync(off.dir).sort(), ['fake-gh-counts.json', 'fake.ndjson'], 'only the fake gh wrote');

  const on = dir();
  const log = join(on.dir, 'ghx.ndjson');
  const r = await spawnGhx(ARGV, {
    fakeGh: true,
    env: { ...on.env, GHX_LOG: log, CLAUDE_CODE_SESSION_ID: 'sess-contract' },
  });
  assert.equal(r.exitCode, plain.exitCode);
  assert.equal(r.stdout, plain.stdout);
  assert.equal(r.stderr, plain.stderr);
  const [line, ...rest] = readLog<InvocationLogLine>(log);
  assert.deepEqual(rest, []);
  assert.equal(line?.session_id, 'sess-contract');
  assert.deepEqual(line?.argv, ARGV);
  assert.equal(line?.exitCode, 0);
  assert.equal(line?.stdoutBytes, Buffer.byteLength(r.stdout));
  assert.equal(line?.stderrBytes, 0);
  assert.equal(typeof line?.durationMs, 'number');
  const gh = line?.calls.filter((c) => c.cmd === 'gh') ?? [];
  assert.deepEqual(
    gh.map((c) => c.argv),
    [['pr', 'list', '--json', 'number,title', '-R', 'github.com/octo/demo']],
  );
  assert.equal(gh[0]?.exitCode, 0);
  assert.ok((gh[0]?.stdoutBytes ?? 0) > 0);
});

test('GHX_LOG: an unwritable path changes neither stdout nor the exit code', async () => {
  const a = dir();
  const plain = await spawnGhx(ARGV, { fakeGh: true, env: a.env });
  for (const bad of [join(tmp, 'missing', 'x.ndjson'), tmp]) {
    const b = dir();
    const r = await spawnGhx(ARGV, { fakeGh: true, env: { ...b.env, GHX_LOG: bad } });
    assert.equal(r.exitCode, plain.exitCode);
    assert.equal(r.stdout, plain.stdout);
    assert.equal(r.stderr, plain.stderr);
  }
  const err = await spawnGhx(['pr', 'nope'], { env: { GHX_LOG: tmp } });
  const errPlain = await spawnGhx(['pr', 'nope']);
  assert.equal(err.exitCode, errPlain.exitCode);
  assert.equal(err.stdout, errPlain.stdout);
});

test('the hook writes GHX_HOOK_LOG and stays out of GHX_LOG', async () => {
  const d = dir();
  const ghxLog = join(d.dir, 'ghx.ndjson');
  const hookLog = join(d.dir, 'hook.ndjson');
  const event = {
    session_id: 'sess-contract',
    tool_use_id: 'toolu_contract_1',
    cwd: d.dir,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'ghx ci wait 12' },
  };
  const r = await spawnGhx(['hook', 'claude-pretooluse'], {
    stdin: JSON.stringify(event),
    env: { GHX_LOG: ghxLog, GHX_HOOK_LOG: hookLog },
  });
  assert.equal(r.exitCode, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.updatedInput.run_in_background, true);
  assert.equal(existsSync(ghxLog), false);
  const [line] = readLog<HookLogLine>(hookLog);
  assert.equal(line?.tool_use_id, 'toolu_contract_1');
  assert.equal(line?.decision, 'rewrite');
  assert.equal(line?.enforce, false);
});
