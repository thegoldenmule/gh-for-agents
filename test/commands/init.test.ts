import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { loadConfig } from '../../src/config/load.ts';
import { componentToken, parsePnpmWorkspace } from '../../src/config/starter.ts';
import { seededRandom } from '../../src/core/random.ts';
import { createGh } from '../../src/gh/index.ts';
import { EXIT } from '../contract/exit-table.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { fakeGit } from '../helpers/fake-git.ts';
import { FakeProc } from '../helpers/fake-proc.ts';
import { runInProcess } from '../helpers/harness.ts';

const tmp = mkdtempSync(join(tmpdir(), 'ghx-init-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function repo(name: string, files: Record<string, string>): string {
  const dir = join(tmp, name);
  for (const [f, content] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), content);
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

const pnpmRepo = () =>
  repo(`pnpm-${Math.random().toString(36).slice(2)}`, {
    'package.json': '{"name":"root","private":true}',
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - \"apps/*\"   # apps\n  - '!packages/ignored'\nother: x\n",
    'packages/reactor/package.json': '{"name":"@ph/reactor"}',
    'packages/codegen/package.json': '{}',
    'packages/ignored/package.json': '{}',
    'packages/no-manifest/README.md': 'x',
    'apps/web/package.json': '{}',
    'docs/index.md': '# docs',
  });

test('pnpm workspace inference: one component per package dir, valid by construction, written', async () => {
  const dir = pnpmRepo();
  const r = await runInProcess(['init'], { git: fakeGit({ toplevel: dir }) });
  assert.equal(r.exitCode, 0, r.stdout);
  assert.equal(r.json.inferredFrom, 'workspaces');
  assert.equal(r.json.written, true);
  assert.deepEqual(r.json.config, {
    version: 1,
    components: {
      web: { paths: ['apps/web/**'] },
      codegen: { paths: ['packages/codegen/**'] },
      reactor: { paths: ['packages/reactor/**'] },
    },
  });
  const path = join(dir, '.github', 'ghx.json');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), r.json.config);
  const loaded = await loadConfig({
    target: undefined,
    git: fakeGit({ toplevel: dir }),
    gh: createGh({
      proc: new FakeProc().runner(),
      clock: new FakeClock(),
      signal: new AbortController().signal,
      mode: 'read',
      random: seededRandom(1),
    }),
    need: 'required',
  });
  assert.equal(loaded.source.kind, 'local');
});

test('refuses to overwrite without --force; --force overwrites', async () => {
  const dir = pnpmRepo();
  const git = fakeGit({ toplevel: dir });
  assert.equal((await runInProcess(['init'], { git })).exitCode, 0);
  const again = await runInProcess(['init', '--component', 'x'], { git });
  assert.equal(again.exitCode, EXIT.CONFIG);
  assert.equal(again.json.error.code, 'CONFIG_EXISTS');
  const forced = await runInProcess(['init', '--component', 'x', '--force'], { git });
  assert.equal(forced.exitCode, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.github', 'ghx.json'), 'utf8')).components, { x: {} });
});

test('--dry-run returns the config without writing', async () => {
  const dir = pnpmRepo();
  const r = await runInProcess(['init', '--dry-run'], { git: fakeGit({ toplevel: dir }) });
  assert.equal(r.exitCode, 0);
  assert.equal(r.json.written, false);
  assert.ok(Object.keys(r.json.config.components).length === 3);
  assert.equal(existsSync(join(dir, '.github', 'ghx.json')), false);
});

test('--component flags win; invalid names are VALIDATION', async () => {
  const dir = pnpmRepo();
  const r = await runInProcess(['init', '--component', 'reactor', '--component', 'docs', '--dry-run'], {
    git: fakeGit({ toplevel: dir }),
  });
  assert.equal(r.json.inferredFrom, 'flags');
  assert.deepEqual(r.json.config.components, { reactor: {}, docs: {} });
  const bad = await runInProcess(['init', '--component', 'Bad Name', '--dry-run'], { git: fakeGit({ toplevel: dir }) });
  assert.equal(bad.json.error.code, 'VALIDATION');
});

test('package.json workspaces, then the top-level-directory fallback, then a root component', async () => {
  const npm = repo('npm', {
    'package.json': '{"workspaces":{"packages":["libs/*"]}}',
    'libs/core/package.json': '{}',
    'apps/core/package.json': '{}',
  });
  const a = await runInProcess(['init', '--dry-run'], { git: fakeGit({ toplevel: npm }) });
  assert.deepEqual(a.json.config.components, { core: { paths: ['libs/core/**'] } });
  const plain = repo('plain', { 'src/a.ts': '', 'docs/x.md': '', 'node_modules/z/index.js': '', '.hidden/x': '' });
  const b = await runInProcess(['init', '--dry-run'], { git: fakeGit({ toplevel: plain }) });
  assert.equal(b.json.inferredFrom, 'directories');
  assert.deepEqual(b.json.config.components, { docs: { paths: ['docs/**'] }, src: { paths: ['src/**'] } });
  const empty = repo('empty', { 'README.md': '' });
  const c = await runInProcess(['init', '--dry-run'], { git: fakeGit({ toplevel: empty }) });
  assert.deepEqual(c.json.config.components, { root: { paths: ['**'] } });
});

test('colliding package basenames are disambiguated by path', async () => {
  const dir = repo('collide', {
    'pnpm-workspace.yaml': 'packages:\n  - "packages/*/core"\n',
    'packages/a/core/package.json': '{}',
    'packages/b/core/package.json': '{}',
  });
  const r = await runInProcess(['init', '--dry-run'], { git: fakeGit({ toplevel: dir }) });
  assert.deepEqual(Object.keys(r.json.config.components).sort(), ['packages-a-core', 'packages-b-core']);
});

test('outside a git checkout: REPO_NOT_FOUND', async () => {
  const r = await runInProcess(['init'], { git: fakeGit({}) });
  assert.equal(r.json.error.code, 'REPO_NOT_FOUND');
});

test('helpers: pnpm yaml line parse and component tokens', () => {
  assert.deepEqual(parsePnpmWorkspace('packages:\n  - a/*\n  - "b/*" # c\nx: 1\n  - nope\n'), ['a/*', 'b/*']);
  assert.equal(componentToken('@scope/My_Pkg'), 'my_pkg');
  assert.equal(componentToken('--'), 'root');
});
