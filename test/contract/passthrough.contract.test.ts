// Passthrough through the real bin (02 §10, 03 §4.3): the envelope shape, -R injection and the gh child
// env as the fake gh logs them, stderr capped at 2 KB, wrapped and write refusals that never spawn gh,
// edit-distance suggestions, and global help still under 4 KB.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { spawnGhx } from '../helpers/spawn.ts';
import { EXIT } from './exit-table.ts';

const tmp = mkdtempSync(join(tmpdir(), 'ghx-passthrough-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
function fake(): { log: string; env: Record<string, string> } {
  const dir = join(tmp, String(++seq));
  mkdirSync(dir, { recursive: true });
  const log = join(dir, 'calls.ndjson');
  return { log, env: { GHX_FAKE_SCENARIO: 'passthrough', GHX_FAKE_LOG: log, GHX_FAKE_STATE: dir } };
}

const calls = (log: string): { argv: string[]; env: Record<string, string> }[] =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    : [];

test('an allowlisted read returns the envelope; -R is injected as host/owner/name', async () => {
  const f = fake();
  const r = await spawnGhx(['pr', 'list', '--json', 'number,title', '-R', 'octo/demo'], { fakeGh: true, env: f.env });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const doc = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(doc), ['passthrough']);
  assert.deepEqual(doc.passthrough.argv, ['gh', 'pr', 'list', '--json', 'number,title', '-R', 'github.com/octo/demo']);
  assert.equal(doc.passthrough.exitCode, 0);
  assert.equal(doc.passthrough.json[0].number, 7);
  assert.equal(typeof doc.passthrough.stdoutBytes, 'number');
  const [call] = calls(f.log);
  assert.deepEqual(call?.argv, ['pr', 'list', '--json', 'number,title', '-R', 'github.com/octo/demo']);
  assert.equal(call?.env.GH_PROMPT_DISABLED, '1');
  assert.equal(call?.env.NO_COLOR, '1');
  assert.equal(call?.env.GH_NO_UPDATE_NOTIFIER, '1');
  assert.equal(call?.env.PAGER, 'cat');
});

test('a failing read is GH_FAILED (7), the envelope in details, stderr capped at 2 KB', async () => {
  const f = fake();
  const r = await spawnGhx(['issue', 'view', '9', '-R', 'octo/demo'], { fakeGh: true, env: f.env });
  assert.equal(r.exitCode, EXIT.GH_FAILED, r.stdout);
  const e = JSON.parse(r.stdout).error;
  assert.equal(e.code, 'GH_FAILED');
  assert.equal(e.details.passthrough.exitCode, 1);
  assert.ok(Buffer.byteLength(e.details.passthrough.stderr) <= 2048);
  assert.match(e.details.passthrough.stderr, /Could not resolve to an issue/);
});

test('wrapped commands are refused with details.suggestion and gh is never spawned', async () => {
  const f = fake();
  const r = await spawnGhx(['pr', 'checks', '3198', '--watch', '-R', 'powerhouse-inc/powerhouse'], {
    fakeGh: true,
    env: f.env,
  });
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  const e = JSON.parse(r.stdout).error;
  assert.equal(e.code, 'USAGE_UNKNOWN_COMMAND');
  assert.deepEqual(e.details.suggestion, ['ghx', 'ci', 'wait', '3198', '-R', 'powerhouse-inc/powerhouse']);
  assert.match(e.hint, /run_in_background/);
  assert.equal(existsSync(f.log), false);
});

test('writes, including gh api -f, are refused with PASSTHROUGH_WRITE_REFUSED (6) and never spawn gh', async () => {
  const f = fake();
  for (const argv of [
    ['api', 'repos/octo/demo/issues', '-f', 'title=x'],
    ['api', '-XPOST', 'repos/octo/demo/issues'],
    ['api', 'graphql', '-f', 'query={ viewer { login } }'],
    ['issue', 'create', '--title', 'x'],
  ]) {
    const r = await spawnGhx(argv, { fakeGh: true, env: f.env });
    assert.equal(r.exitCode, EXIT.POLICY, `${argv.join(' ')}: ${r.stdout}`);
    assert.equal(JSON.parse(r.stdout).error.code, 'PASSTHROUGH_WRITE_REFUSED');
  }
  assert.equal(existsSync(f.log), false);
});

test('unknown commands get edit-distance suggestions', async () => {
  const r = await spawnGhx(['pr', 'dif', '1']);
  assert.equal(r.exitCode, EXIT.USAGE);
  const e = JSON.parse(r.stdout).error;
  assert.equal(e.code, 'USAGE_UNKNOWN_COMMAND');
  assert.equal(e.details.suggestions[0], 'pr diff');
  assert.match(e.hint, /^Did you mean: ghx pr diff/);
});

test('ghx --help stays under 4 KB', async () => {
  const r = await spawnGhx(['--help']);
  assert.equal(r.exitCode, 0);
  assert.ok(Buffer.byteLength(r.stdout) < 4096);
});
