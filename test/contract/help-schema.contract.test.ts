// Discovery (01 §7, 03 §4.3): `ghx --help` is JSON under 4 KB; --schema makes no gh calls.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { spawnGhx } from '../helpers/spawn.ts';

const tmp = mkdtempSync(join(tmpdir(), 'ghx-help-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('ghx --help is one JSON document under 4 KB', async () => {
  const r = await spawnGhx(['--help']);
  assert.equal(r.exitCode, 0);
  assert.ok(Buffer.byteLength(r.stdout) < 4096);
  assert.equal(JSON.parse(r.stdout).name, 'ghx');
});

test('the global --timeout line names every command that takes no --timeout (help timeout:null)', async () => {
  const global = JSON.parse((await spawnGhx(['--help'])).stdout) as {
    globalFlags: string[];
    commands: Record<string, string>;
  };
  const line = global.globalFlags.find((f) => f.startsWith('--timeout')) ?? '';
  const none: string[] = [];
  for (const name of Object.keys(global.commands)) {
    if (name === 'help' || name === 'schema') continue;
    const help = JSON.parse((await spawnGhx([...name.split(' '), '--help'])).stdout) as { timeout: unknown };
    if (help.timeout === null) none.push(name);
  }
  assert.ok(none.includes('ci wait'), `ci wait has no deadline: ${none}`);
  for (const name of none) assert.ok(line.includes(name), `${line} should name ${name}`);
  const r = await spawnGhx(['ci', 'wait', 'o/r#1', '--timeout', '1m']);
  assert.equal(JSON.parse(r.stdout).error.code, 'USAGE_UNKNOWN_FLAG', 'the note matches the parser');
});

test('<cmd> --schema and ghx schema make no gh calls (the fake gh log stays empty)', async () => {
  const log = join(tmp, 'calls.ndjson');
  const env = { GHX_FAKE_SCENARIO: 'doctor-ok', GHX_FAKE_LOG: log };
  for (const argv of [
    ['doctor', '--schema'],
    ['schema', 'doctor'],
    ['schema'],
    ['schema', 'config'],
    ['doctor', '--help'],
  ]) {
    const r = await spawnGhx(argv, { fakeGh: true, env });
    assert.equal(r.exitCode, 0, `${argv.join(' ')}: ${r.stdout}`);
    JSON.parse(r.stdout);
  }
  assert.equal(existsSync(log), false);
});
