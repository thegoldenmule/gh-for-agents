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
import type { Git } from '../../../src/git/index.ts';
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
// origin/main whose working-tree ci.expected still named a retired job that origin/main had since renamed.
const OLD_BLOB = 'b'.repeat(40);
const NEW_BLOB = 'c'.repeat(40);
const HEAD_SHA = 'fb84c4ee691c913bddf916389e62f8e18c4713a3';
const BASE_SHA = '781edff0000000000000000000000000000000aa';
const FORK_SHA = '9475673000000000000000000000000000000bb';

/**
 * A checkout of o/<name>: the working tree and HEAD hold OLD_BLOB, origin/main holds NEW_BLOB and HEAD
 * forked at FORK_SHA, which also held OLD_BLOB (origin/main changed the file after the fork).
 */
function provenance(
  name: string,
  extra: FakeGitState = {},
  objects: Record<string, string | undefined> = {},
  work = OLD_BLOB,
) {
  const dir = join(tmp, name);
  mkdirSync(join(dir, '.github'), { recursive: true });
  writeFileSync(join(dir, '.github', 'ghx.json'), VALID);
  const file = join(dir, '.github', 'ghx.json');
  const all: Record<string, string | undefined> = {
    'HEAD:.github/ghx.json': OLD_BLOB,
    'origin/main': BASE_SHA,
    'origin/main:.github/ghx.json': NEW_BLOB,
    [`${FORK_SHA}:.github/ghx.json`]: OLD_BLOB,
    ...objects,
  };
  return {
    file,
    git: gitCheckout(`o/${name}`, {
      toplevel: dir,
      refs: { HEAD: HEAD_SHA },
      files: { [file]: work },
      objects: Object.fromEntries(Object.entries(all).filter((e): e is [string, string] => e[1] !== undefined)),
      mergeBases: { 'HEAD...origin/main': FORK_SHA },
      remoteHeads: { origin: 'origin/main' },
      counts: { 'HEAD...origin/main': { ahead: 0, behind: 39 } },
      ...extra,
    }),
  };
}

async function load(git: Git, flag?: string) {
  const target = await resolveRepo({ ...(flag ? { flag } : {}), env: {}, git, need: 'inferred' });
  const local = flag ? ({ ...target, cwdRepo: target?.repo } as NonNullable<typeof target>) : target;
  return loadConfig({ target: local, git, gh: gh(new FakeProc()), need: 'required' });
}

test('local: the source records HEAD and whether the file differs from it', async () => {
  const { git, file } = provenance('prov-clean', {}, { 'origin/main:.github/ghx.json': OLD_BLOB });
  const r = await load(git);
  assert.deepEqual(r.source, { kind: 'local', path: file, commit: HEAD_SHA, dirty: false });
  assert.equal(sourceLabel(r.source), 'the working tree at fb84c4e');
  assert.deepEqual(r.warnings, [], 'the base has the same file: no drift');
  const edited = provenance('prov-dirty', {}, { 'HEAD:.github/ghx.json': 'd'.repeat(40) });
  assert.equal(sourceLabel((await load(edited.git)).source), 'the working tree at fb84c4e (dirty)');
});

test('CONFIG_DRIFT: origin/main changed the file since HEAD forked, and HEAD is behind it', async () => {
  const { git, file } = provenance('drift');
  const r = await load(git);
  assert.equal(r.warnings.length, 1);
  const w = r.warnings[0];
  assert.equal(w?.code, 'CONFIG_DRIFT');
  assert.match(
    w?.message ?? '',
    /changed on origin\/main \(781edff\) since HEAD \(fb84c4e\) forked from it, and HEAD is 39 commits behind\./,
  );
  assert.match(w?.message ?? '', /pull or merge origin\/main/);
  assert.match(w?.message ?? '', /as of the last fetch/);
  assert.deepEqual(w?.details, {
    path: file,
    base: 'origin/main',
    baseCommit: BASE_SHA,
    forkCommit: FORK_SHA,
    head: HEAD_SHA,
    ahead: 0,
    behind: 39,
  });
  const diverged = provenance('drift-diverged', { counts: { 'HEAD...origin/main': { ahead: 2, behind: 1 } } });
  assert.match((await load(diverged.git)).warnings[0]?.message ?? '', /HEAD is 1 commit behind \(2 ahead\)/);
  const added = provenance('drift-added', {}, { [`${FORK_SHA}:.github/ghx.json`]: undefined });
  assert.equal((await load(added.git)).warnings[0]?.code, 'CONFIG_DRIFT', 'the base added the file after the fork');
});

test('no CONFIG_DRIFT for a PR branch that edits the file while the base left it alone (review 4a)', async () => {
  // The branch changed ghx.json and is behind main, but main's copy is still the one it forked from.
  const { git } = provenance(
    'branch-edit',
    {},
    { 'origin/main:.github/ghx.json': OLD_BLOB, 'HEAD:.github/ghx.json': NEW_BLOB },
    NEW_BLOB,
  );
  assert.deepEqual((await load(git)).warnings, []);
});

test('no CONFIG_DRIFT on a shallow clone, or when the counts cannot be read (review 4b, 4c)', async () => {
  assert.deepEqual((await load(provenance('shallow', { shallow: true }).git)).warnings, []);
  assert.deepEqual((await load(provenance('no-counts', { counts: {} }).git)).warnings, []);
  assert.deepEqual((await load(provenance('no-fork', { mergeBases: {} }).git)).warnings, []);
});

test('no CONFIG_DRIFT for a branch on top of the base, the same file, or a missing base ref', async () => {
  const cases: [FakeGitState, Record<string, string | undefined>][] = [
    [{ counts: { 'HEAD...origin/main': { ahead: 3, behind: 0 } } }, {}],
    [{}, { 'origin/main:.github/ghx.json': OLD_BLOB }],
    [{ remoteHeads: {} }, { 'origin/main': undefined }],
    [{ remotes: [{ name: 'origin', url: 'git@github.com:someone/fork.git' }] }, {}],
  ];
  for (const [i, [extra, objects]] of cases.entries()) {
    const r = await load(provenance(`nodrift-${i}`, extra, objects).git, `o/nodrift-${i}`);
    assert.equal(r.source.kind, 'local', `case ${i}`);
    assert.deepEqual(r.warnings, [], `case ${i}`);
  }
});

test('a stale or unset <remote>/HEAD falls back to <remote>/main', async () => {
  const unset = provenance('drift-unset', { remoteHeads: {} });
  assert.equal((await load(unset.git)).warnings[0]?.details?.base, 'origin/main');
  // origin/HEAD names a branch that is gone locally: the next candidate that exists is used.
  const stale = provenance('drift-stale', { remoteHeads: { origin: 'origin/trunk' } });
  assert.equal((await load(stale.git)).warnings[0]?.details?.base, 'origin/main');
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
