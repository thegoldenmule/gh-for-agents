// The fake gh binary itself (03 §2 M1.15): replay, cross-process counters, call log, hang.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { FAKE_BIN_DIR, nodeBinDir, readyPath, waitForFile } from '../helpers/spawn.ts';

const tmp = mkdtempSync(join(tmpdir(), 'ghx-fakebin-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const GH = join(FAKE_BIN_DIR, 'gh');

function runGh(
  args: string[],
  env: Record<string, string>,
  o: { stdin?: string; onSpawn?: (c: import('node:child_process').ChildProcess) => void } = {},
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(GH, args, {
      env: { PATH: `${nodeBinDir()}:/usr/bin:/bin`, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.stdin.end(o.stdin ?? '');
    o.onSpawn?.(child);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function fakeEnv() {
  const state = mkdtempSync(join(tmp, 'state-'));
  return {
    GHX_FAKE_SCENARIO: 'fake-gh-selftest',
    GHX_FAKE_STATE: state,
    GHX_FAKE_LOG: join(state, 'calls.ndjson'),
    GH_PROMPT_DISABLED: '1',
    GH_PAGER: '',
  };
}

test('replays a scenario with a sequence counter kept across processes', async () => {
  const env = fakeEnv();
  const args = ['pr', 'view', '1', '--json', 'number', '-R', 'o/r'];
  const outs = [];
  for (let i = 0; i < 3; i++) outs.push((await runGh(args, env)).stdout.trim());
  assert.deepEqual(outs, ['{"number":1}', '{"number":1,"second":true}', '{"number":1,"second":true}']);
});

test('logs argv, stdin hash and the env keys ghx sets; matches stdin for writes', async () => {
  const env = fakeEnv();
  const r = await runGh(['api', '--include', '-X', 'POST', 'repos/o/r/issues', '--input', '-'], env, {
    stdin: '{"body":"b","title":"t"}',
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /"number":7/);
  const [entry] = readFileSync(env.GHX_FAKE_LOG, 'utf8')
    .trimEnd()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(entry.fake, true);
  assert.deepEqual(entry.argv, ['api', '--include', '-X', 'POST', 'repos/o/r/issues', '--input', '-']);
  assert.match(entry.stdinSha256, /^[0-9a-f]{64}$/);
  assert.equal(entry.env.GH_PROMPT_DISABLED, '1');
  assert.equal(entry.env.GH_PAGER, '');
});

test('exit codes and stderr replay; an unmatched call exits 99 naming the nearest fixture', async () => {
  const env = fakeEnv();
  const nf = await runGh(['pr', 'view', '404', '-R', 'o/r'], env);
  assert.equal(nf.code, 1);
  assert.match(nf.stderr, /Could not resolve to a PullRequest/);
  const un = await runGh(['pr', 'view', '2', '--json', 'number', '-R', 'o/r'], env);
  assert.equal(un.code, 99);
  assert.match(un.stderr, /Nearest: 'gh pr view 1 --json number -R github.com\/o\/r'/);
});

test('a hang reply blocks until SIGTERM', async () => {
  let child: import('node:child_process').ChildProcess | undefined;
  const ready = readyPath();
  const p = runGh(
    ['pr', 'checks', '9', '-R', 'o/r'],
    { ...fakeEnv(), GHX_FAKE_READY: ready },
    { onSpawn: (c) => (child = c) },
  );
  await waitForFile(ready);
  assert.equal(child?.exitCode, null);
  child?.kill('SIGTERM');
  assert.equal((await p).code, 143);
});
