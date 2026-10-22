import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { slugFor, withRecording } from '../../../src/proc/recording.ts';
import { FakeClock } from '../../helpers/fake-clock.ts';
import { FakeProc } from '../../helpers/fake-proc.ts';

const tmp = mkdtempSync(join(tmpdir(), 'ghx-rec-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('slugFor drops flags and sanitizes', () => {
  assert.equal(slugFor(['api', '-i', 'repos/cli/cli/actions/jobs/1/logs']), 'api-repos-cli-cli-actions-jobs-1-logs');
  assert.equal(slugFor(['--version']), 'call');
});

test('records gh calls as numbered GhFixture files, with stdin and log bodies', async () => {
  const dir = join(tmp, 'rec');
  const fake = new FakeProc()
    .on({ cmd: 'gh', args: ['--version'] }, { stdout: 'gh version 2.86.0 (2026-01-21)\n' })
    .on({ cmd: 'gh', args: ['api'] }, { stdout: '{"ok":true}', exitCode: 0 })
    .on({ cmd: 'git' }, { stdout: 'main\n' });
  const run = withRecording(fake.runner(), { dir, source: 'live:public', clock: new FakeClock() });
  const signal = new AbortController().signal;
  const log = join(tmp, 'job.log');
  writeFileSync(log, 'LOG BODY');
  await run({ cmd: '/usr/bin/gh', args: ['api', 'repos/o/r/pulls'], env: {}, signal, stdin: '{"title":"x"}' });
  await run({ cmd: 'gh', args: ['api', 'repos/o/r/actions/jobs/1/logs'], env: {}, signal, stdoutFile: log });
  await run({ cmd: 'git', args: ['branch'], env: {}, signal });
  const files = readdirSync(dir).sort();
  assert.deepEqual(files, [
    '001-api-repos-o-r-pulls.json',
    '002-api-repos-o-r-actions-jobs-1-logs.json',
    '002-api-repos-o-r-actions-jobs-1-logs.log',
  ]);
  const f1 = JSON.parse(readFileSync(join(dir, files[0] as string), 'utf8'));
  assert.deepEqual(f1.argv, ['api', 'repos/o/r/pulls']);
  assert.deepEqual(f1.stdin, { json: { title: 'x' } });
  assert.equal(f1.meta.source, 'live:public');
  assert.equal(f1.meta.ghVersion, '2.86.0');
  assert.equal(f1.meta.recordedAt, '2026-10-22T12:00:00.000Z');
  const f2 = JSON.parse(readFileSync(join(dir, files[1] as string), 'utf8'));
  assert.equal(f2.stdoutFile, '002-api-repos-o-r-actions-jobs-1-logs.log');
  assert.equal(readFileSync(join(dir, files[2] as string), 'utf8'), 'LOG BODY');
});
