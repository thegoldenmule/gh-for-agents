import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { describeSource, loadConfig, sourceLabel } from '../../../src/config/load.ts';
import { isGhxError } from '../../../src/core/errors.ts';
import { seededRandom } from '../../../src/core/random.ts';
import { createGh } from '../../../src/gh/index.ts';
import { resolveRepo } from '../../../src/gh/repo.ts';
import { FakeClock } from '../../helpers/fake-clock.ts';
import { type FakeGitState, gitCheckout } from '../../helpers/fake-git.ts';
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
  assert.deepEqual(fake.calls[0]?.args, [
    'api',
    '--include',
    '-X',
    'GET',
    '--hostname',
    'github.com',
    'repos/o/other/contents/.github/ghx.json',
  ]);
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

// Provenance and CONFIG_DRIFT (git only, no network): the tally#27 case, a main checkout 39 commits behind
// origin/main whose working-tree ci.expected still named a retired job.
const FILE_BLOB = 'b'.repeat(40);
const BASE_BLOB = 'c'.repeat(40);
const HEAD_SHA = 'fb84c4ee691c913bddf916389e62f8e18c4713a3';
const BASE_SHA = '781edff0000000000000000000000000000000aa';

function provenance(name: string, extra: FakeGitState = {}) {
  const dir = join(tmp, name);
  mkdirSync(join(dir, '.github'), { recursive: true });
  writeFileSync(join(dir, '.github', 'ghx.json'), VALID);
  const file = join(dir, '.github', 'ghx.json');
  return {
    file,
    git: gitCheckout(`o/${name}`, {
      toplevel: dir,
      refs: { HEAD: HEAD_SHA, 'origin/main': BASE_SHA },
      files: { [file]: FILE_BLOB },
      blobs: { 'HEAD:.github/ghx.json': FILE_BLOB, 'origin/main:.github/ghx.json': BASE_BLOB },
      remoteHeads: { origin: 'origin/main' },
      ...extra,
    }),
  };
}

test('local: the source records HEAD and whether the file differs from it', async () => {
  const { git, file } = provenance('prov-clean', { blobs: { 'HEAD:.github/ghx.json': FILE_BLOB } });
  const target = await resolveRepo({ env: {}, git, need: 'inferred' });
  const r = await loadConfig({ target, git, gh: gh(new FakeProc()), need: 'required' });
  assert.deepEqual(r.source, { kind: 'local', path: file, commit: HEAD_SHA, dirty: false });
  assert.equal(sourceLabel(r.source), 'the working tree at fb84c4e');
  assert.deepEqual(r.warnings, [], 'no base copy: no drift is claimed');
  const edited = provenance('prov-dirty', { blobs: { 'HEAD:.github/ghx.json': 'd'.repeat(40) } });
  const t2 = await resolveRepo({ env: {}, git: edited.git, need: 'inferred' });
  const r2 = await loadConfig({ target: t2, git: edited.git, gh: gh(new FakeProc()), need: 'required' });
  assert.equal(sourceLabel(r2.source), 'the working tree at fb84c4e (dirty)');
});

test('CONFIG_DRIFT: the file differs from origin/main and HEAD is behind it', async () => {
  const { git, file } = provenance('drift', { counts: { 'HEAD...origin/main': { ahead: 0, behind: 39 } } });
  const target = await resolveRepo({ env: {}, git, need: 'inferred' });
  const r = await loadConfig({ target, git, gh: gh(new FakeProc()), need: 'required' });
  assert.equal(r.warnings.length, 1);
  const w = r.warnings[0];
  assert.equal(w?.code, 'CONFIG_DRIFT');
  assert.match(
    w?.message ?? '',
    /differs from origin\/main's \(781edff\), and HEAD \(fb84c4e\) is 39 commits behind origin\/main\./,
  );
  assert.match(w?.message ?? '', /pull, or run ghx from an up-to-date checkout/);
  assert.deepEqual(w?.details, {
    path: file,
    base: 'origin/main',
    baseCommit: BASE_SHA,
    head: HEAD_SHA,
    ahead: 0,
    behind: 39,
  });
  const diverged = provenance('drift-diverged', { counts: { 'HEAD...origin/main': { ahead: 2, behind: 1 } } });
  const t2 = await resolveRepo({ env: {}, git: diverged.git, need: 'inferred' });
  const r2 = await loadConfig({ target: t2, git: diverged.git, gh: gh(new FakeProc()), need: 'required' });
  assert.match(r2.warnings[0]?.message ?? '', /is 1 commit behind origin\/main and 2 ahead/);
});

test('no CONFIG_DRIFT for a branch on top of the base, the same file, or a missing base ref', async () => {
  const cases: FakeGitState[] = [
    { counts: { 'HEAD...origin/main': { ahead: 3, behind: 0 } } },
    { blobs: { 'HEAD:.github/ghx.json': FILE_BLOB, 'origin/main:.github/ghx.json': FILE_BLOB } },
    { remoteHeads: {}, refs: { HEAD: HEAD_SHA } },
    { remotes: [{ name: 'origin', url: 'git@github.com:someone/fork.git' }] },
  ];
  for (const [i, extra] of cases.entries()) {
    const { git } = provenance(`nodrift-${i}`, extra);
    const target = await resolveRepo({ flag: `o/nodrift-${i}`, env: {}, git, need: 'inferred' });
    const local = { ...target, cwdRepo: target?.repo } as NonNullable<typeof target>;
    const r = await loadConfig({ target: local, git, gh: gh(new FakeProc()), need: 'required' });
    assert.equal(r.source.kind, 'local', `case ${i}`);
    assert.deepEqual(r.warnings, [], `case ${i}`);
  }
});

test('without a remote HEAD, <remote>/main is the base', async () => {
  const { git } = provenance('drift-main', {
    remoteHeads: {},
    counts: { 'HEAD...origin/main': { ahead: 0, behind: 2 } },
  });
  const target = await resolveRepo({ env: {}, git, need: 'inferred' });
  const r = await loadConfig({ target, git, gh: gh(new FakeProc()), need: 'required' });
  assert.equal(r.warnings[0]?.code, 'CONFIG_DRIFT');
  assert.equal(r.warnings[0]?.details?.base, 'origin/main');
});

test('the remote and default sources carry no provenance and no warnings', async () => {
  assert.equal(sourceLabel({ kind: 'default' }), 'the defaults');
  assert.equal(
    sourceLabel({
      kind: 'remote',
      repo: { host: 'github.com', owner: 'o', name: 'r' },
      ref: 'main',
      path: '.github/ghx.json',
    }),
    'o/r@main',
  );
  assert.deepEqual(describeSource({ kind: 'local', path: '/p', commit: HEAD_SHA, dirty: true }), {
    kind: 'local',
    path: '/p',
    commit: HEAD_SHA,
    dirty: true,
  });
});
