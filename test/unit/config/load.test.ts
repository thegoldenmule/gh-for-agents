import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { loadConfig } from '../../../src/config/load.ts';
import { isGhxError } from '../../../src/core/errors.ts';
import { seededRandom } from '../../../src/core/random.ts';
import { createGh } from '../../../src/gh/index.ts';
import { resolveRepo } from '../../../src/gh/repo.ts';
import { FakeClock } from '../../helpers/fake-clock.ts';
import { gitCheckout } from '../../helpers/fake-git.ts';
import { FakeProc } from '../../helpers/fake-proc.ts';

const tmp = mkdtempSync(join(tmpdir(), 'ghx-cfg-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function checkout(name: string, config?: string) {
  const dir = join(tmp, name);
  mkdirSync(join(dir, '.github'), { recursive: true });
  if (config !== undefined) writeFileSync(join(dir, '.github', 'ghx.json'), config);
  return gitCheckout(`o/${name}`, { toplevel: dir });
}

function gh(fake: FakeProc) {
  return createGh({
    proc: fake.runner(),
    clock: new FakeClock(),
    signal: new AbortController().signal,
    mode: 'read',
    random: seededRandom(1),
  });
}

const VALID = '{"version":1,"components":{"local":{}}}';
const remoteBody = (cfg: string) =>
  `HTTP/2.0 200 OK\n\n${JSON.stringify({ content: Buffer.from(cfg).toString('base64'), encoding: 'base64', url: 'https://api.github.com/repos/o/other/contents/.github/ghx.json?ref=main' })}`;

test('cwd checkout is the target: the local working copy is read (no gh calls)', async () => {
  const git = checkout('same', VALID);
  const fake = new FakeProc();
  const target = await resolveRepo({ env: {}, git, need: 'inferred' });
  const r = await loadConfig({ target, git, gh: gh(fake), need: 'required' });
  assert.equal(r.source.kind, 'local');
  assert.deepEqual(Object.keys(r.config.components), ['local']);
  assert.equal(fake.calls.length, 0);
});

test('target differs from the cwd: the remote default-branch file is fetched (sektar case)', async () => {
  const git = checkout('cwd', VALID);
  const fake = new FakeProc().on({ cmd: 'gh' }, { stdout: remoteBody('{"version":1,"components":{"remote":{}}}') });
  const target = await resolveRepo({ flag: 'o/other', env: {}, git, need: 'inferred' });
  const r = await loadConfig({ target, git, gh: gh(fake), need: 'required' });
  assert.deepEqual(r.source, {
    kind: 'remote',
    repo: { host: 'github.com', owner: 'o', name: 'other' },
    ref: 'main',
    path: '.github/ghx.json',
  });
  assert.deepEqual(Object.keys(r.config.components), ['remote']);
  assert.deepEqual(fake.calls[0]?.args, ['api', '--include', '-X', 'GET', 'repos/o/other/contents/.github/ghx.json']);
});

test('absent + required → CONFIG_MISSING with the ghx init hint; absent + optional → defaults', async () => {
  const git = checkout('empty');
  const target = await resolveRepo({ env: {}, git, need: 'inferred' });
  await assert.rejects(loadConfig({ target, git, gh: gh(new FakeProc()), need: 'required' }), (e) => {
    assert.ok(isGhxError(e, 'CONFIG_MISSING'));
    assert.match(e.hint ?? '', /ghx init/);
    assert.equal(e.exitCode, 3);
    return true;
  });
  const d = await loadConfig({ target, git, gh: gh(new FakeProc()), need: 'optional' });
  assert.equal(d.source.kind, 'default');
  const remoteMissing = new FakeProc().on(
    { cmd: 'gh' },
    { exitCode: 1, stderr: 'gh: Not Found (HTTP 404)', stdout: 'HTTP/2.0 404 Not Found\n\n{"message":"Not Found"}' },
  );
  const other = await resolveRepo({ flag: 'o/zzz', env: {}, git, need: 'inferred' });
  assert.equal(
    (await loadConfig({ target: other, git, gh: gh(remoteMissing), need: 'optional' })).source.kind,
    'default',
  );
});

test('invalid is always an error, even when the need is optional', async () => {
  const git = checkout('broken', '{"version":1,"components":{"x":{}},"merge":{"method":"squash"}}');
  const target = await resolveRepo({ env: {}, git, need: 'inferred' });
  await assert.rejects(loadConfig({ target, git, gh: gh(new FakeProc()), need: 'optional' }), (e) =>
    isGhxError(e, 'CONFIG_INVALID'),
  );
});

test('no target (repo need none): local file only', async () => {
  const git = checkout('norepo', VALID);
  const r = await loadConfig({ target: undefined, git, gh: gh(new FakeProc()), need: 'required' });
  assert.equal(r.source.kind, 'local');
});
