// GHX_LOG (07 M5): withInvocationLog records the gh and git calls behind one ghx invocation, the bytes it
// printed and its exit code, as one NDJSON line at finish; stdout passes through untouched; a failed
// write is swallowed; the hook protocol is not logged. The real-bin wiring is in
// test/contract/instrumentation.contract.test.ts.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createMemorySink } from '../../../src/core/output.ts';
import { type InvocationLogLine, withInvocationLog } from '../../../src/proc/invocation-log.ts';
import { FakeClock } from '../../helpers/fake-clock.ts';
import { FakeProc } from '../../helpers/fake-proc.ts';

const tmp = mkdtempSync(join(tmpdir(), 'ghx-invlog-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
const logPath = (): string => join(tmp, `inv-${++seq}.ndjson`);
const readLog = (p: string): InvocationLogLine[] =>
  readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

function setup(argv: string[], env: Record<string, string> = {}, path = logPath()) {
  const clock = new FakeClock();
  const fake = new FakeProc()
    .on({ cmd: 'gh', args: ['api'] }, { stdout: '{"ok":true}', stderr: 'warn\n' })
    .on({ cmd: 'gh', args: ['run'] }, { stdout: '' })
    .on({ cmd: 'git' }, { stdout: 'main\n' })
    .on({ cmd: 'gh', args: ['missing'] }, { spawnError: 'ENOENT' });
  const sink = createMemorySink();
  const stderr: string[] = [];
  const log = withInvocationLog(
    { proc: fake.runner(), stdout: sink, stderrLine: (l: string) => stderr.push(l) },
    { path, argv, cwd: '/work/repo', env, clock, version: '9.9.9' },
  );
  return { clock, sink, stderr, log, path };
}

test('one line per invocation with the nested gh and git calls, bytes and exit code', async () => {
  const s = setup(['ci', 'why', '12'], { CLAUDE_CODE_SESSION_ID: 'sess-1' });
  const signal = new AbortController().signal;
  const job = join(tmp, 'job.log');
  writeFileSync(job, 'x'.repeat(1234));
  await s.log.deps.proc({ cmd: '/opt/bin/gh', args: ['api', 'repos/o/r/pulls/12'], env: {}, signal });
  await s.log.deps.proc({ cmd: 'gh', args: ['run', 'view', '--log'], env: {}, signal, stdoutFile: job });
  await s.log.deps.proc({ cmd: 'git', args: ['rev-parse', 'HEAD'], env: {}, signal });
  await s.log.deps.proc({ cmd: 'gh', args: ['missing'], env: {}, signal });
  await s.log.deps.stdout.writeLine('{"é":1}');
  s.log.deps.stderrLine?.('verbose');
  await s.clock.advance(250);
  assert.equal(existsSync(s.path), false, 'nothing is written before finish');
  s.log.finish(10);
  s.log.finish(10);
  assert.deepEqual(s.sink.lines, ['{"é":1}'], 'stdout passes through unchanged');
  assert.deepEqual(s.stderr, ['verbose']);
  const lines = readLog(s.path);
  assert.equal(lines.length, 1, 'finish writes once');
  assert.deepEqual(lines[0], {
    v: 1,
    ts: '2026-10-22T12:00:00.000Z',
    session_id: 'sess-1',
    cwd: '/work/repo',
    argv: ['ci', 'why', '12'],
    exitCode: 10,
    durationMs: 250,
    stdoutBytes: 9,
    stderrBytes: 8,
    version: '9.9.9',
    calls: [
      {
        cmd: 'gh',
        argv: ['api', 'repos/o/r/pulls/12'],
        exitCode: 0,
        durationMs: 0,
        stdoutBytes: 11,
        stderrBytes: 5,
      },
      {
        cmd: 'gh',
        argv: ['run', 'view', '--log'],
        exitCode: 0,
        durationMs: 0,
        stdoutBytes: 1234,
        stderrBytes: 0,
        stdoutFile: true,
      },
      { cmd: 'git', argv: ['rev-parse', 'HEAD'], exitCode: 0, durationMs: 0, stdoutBytes: 5, stderrBytes: 0 },
      {
        cmd: 'gh',
        argv: ['missing'],
        exitCode: null,
        durationMs: 0,
        stdoutBytes: 0,
        stderrBytes: 0,
        spawnError: 'ENOENT',
      },
    ],
  });
});

test('outside Claude Code session_id is null; lines append', async () => {
  const path = logPath();
  for (const argv of [['pr', 'status', '1'], ['version']]) {
    const s = setup(argv, {}, path);
    s.log.finish(0);
  }
  assert.deepEqual(
    readLog(path).map((l) => [l.session_id, l.argv]),
    [
      [null, ['pr', 'status', '1']],
      [null, ['version']],
    ],
  );
});

test('the hook protocol is not logged; its --help is', async () => {
  const hook = setup(['hook', 'claude-pretooluse']);
  hook.log.finish(0);
  assert.equal(existsSync(hook.path), false);
  const help = setup(['hook', 'claude-pretooluse', '--help']);
  help.log.finish(0);
  assert.equal(readLog(help.path).length, 1);
});

test('a failed write is swallowed and changes nothing', async () => {
  for (const bad of [join(tmp, 'missing', 'dir', 'x.ndjson'), tmp]) {
    const s = setup(['version'], {}, bad);
    await s.log.deps.stdout.writeLine('{}');
    assert.doesNotThrow(() => s.log.finish(0));
    assert.deepEqual(s.sink.lines, ['{}']);
  }
});
