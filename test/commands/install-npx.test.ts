// ghx install run from npx (04 "distribution"): it installs this version globally with npm and hands
// the install to that copy. npm and the global copy are faked through the process seam; HOME and the
// npm prefix are temp dirs. pnpm pack:test runs the real thing from a real _npx cache.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { handoffArgs, npmCommand, runsFromNpx } from '../../src/install/npx.ts';
import type { ProcRequest } from '../../src/proc/runner.ts';
import { PACKAGE_NAME, VERSION } from '../../src/version.ts';
import { EXIT } from '../contract/exit-table.ts';
import { fakeGit } from '../helpers/fake-git.ts';
import { FakeProc, type ProcReply } from '../helpers/fake-proc.ts';
import { runInProcess } from '../helpers/harness.ts';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ghx-npx-')));
after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
/** A temp HOME and a temp global npm prefix whose bin/ghx exists (as after npm i -g). */
function setup() {
  const root = join(tmp, `t-${n++}`);
  const home = join(root, 'home');
  const prefix = join(root, 'prefix');
  const pkg = join(prefix, 'lib', 'node_modules', ...PACKAGE_NAME.split('/'));
  mkdirSync(home, { recursive: true });
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(join(pkg, 'bin', 'ghx.js'), '');
  mkdirSync(join(prefix, 'bin'));
  writeFileSync(join(prefix, 'bin', 'ghx'), '');
  return { root, home, prefix, pkg, bin: join(prefix, 'bin', 'ghx') };
}

const NPX_ENV = { npm_command: 'exec', npm_lifecycle_event: 'npx' };
const isNpm = (sub: string) => (r: ProcRequest) => r.cmd === 'npm' && r.args[0] === sub;
const isChild = (r: ProcRequest) => r.cmd === process.execPath;

function proc(t: ReturnType<typeof setup>, o: { install?: ProcReply; child?: ProcReply; prefix?: ProcReply } = {}) {
  return new FakeProc()
    .on(isNpm('prefix'), o.prefix ?? { stdout: `${t.prefix}\n` })
    .on(isNpm('i'), o.install ?? { stdout: 'added 2 packages\n' })
    .on(isChild, o.child ?? { stdout: '{}' });
}

const run = (argv: string[], t: ReturnType<typeof setup>, p: FakeProc, env: Record<string, string> = NPX_ENV) =>
  runInProcess(argv, { env: { HOME: t.home, ...env }, proc: p.runner(), git: fakeGit({}), cwd: t.root });

test('runsFromNpx: an _npx cache path, or the npx/npm exec env markers, unless already handed off', () => {
  assert.equal(runsFromNpx('/home/u/.npm/_npx/63e3247980e663cc/node_modules/@thegoldenmule/ghx', {}), true);
  assert.equal(runsFromNpx('/usr/local/lib/node_modules/@thegoldenmule/ghx', {}), false);
  assert.equal(runsFromNpx('/src/gh-for-agents', {}), false);
  assert.equal(runsFromNpx('/src/my_npx_tools/ghx', {}), false);
  assert.equal(runsFromNpx('/src/gh-for-agents', { npm_command: 'exec' }), true);
  assert.equal(runsFromNpx('/src/gh-for-agents', { npm_lifecycle_event: 'npx' }), true);
  assert.equal(runsFromNpx('/x/_npx/1/node_modules/@thegoldenmule/ghx', { GHX_NPX_HANDOFF: '1' }), false);
});

test('npmCommand: the npm that ran npx, on this node; else npm on PATH (never pnpm)', () => {
  const cli = '/opt/node/lib/node_modules/npm/bin/npm-cli.js';
  assert.deepEqual(npmCommand({ npm_execpath: cli }), { cmd: process.execPath, args: [cli] });
  assert.deepEqual(npmCommand({ npm_execpath: '/opt/pnpm/bin/pnpm.cjs' }), { cmd: 'npm', args: [] });
  assert.deepEqual(npmCommand({}), { cmd: 'npm', args: [] });
});

test('handoffArgs: the same install flags, with an absolute --bin-dir and no --dry-run or --no-global', () => {
  assert.deepEqual(
    handoffArgs(
      { scope: 'project', deny: false, hook: true, snippet: false, binDir: 'b', hookMode: 'deny', global: true },
      '/w',
    ),
    ['install', '--scope', 'project', '--no-deny', '--no-snippet', '--bin-dir', '/w/b', '--hook-mode', 'deny'],
  );
  assert.deepEqual(handoffArgs({ scope: 'user', hook: false, snippet: true, global: true }, '/w'), [
    'install',
    '--scope',
    'user',
    '--no-hook',
  ]);
});

test('--dry-run from npx reports the plan with the global install command, and runs only npm prefix -g', async () => {
  const t = setup();
  const p = proc(t);
  const r = await run(['install', '--dry-run'], t, p);
  assert.equal(r.exitCode, 0, r.stdout);
  assert.equal(r.json.dryRun, true);
  assert.deepEqual(r.json.handoff.install, ['npm', 'i', '-g', `${PACKAGE_NAME}@${VERSION}`]);
  assert.equal(r.json.handoff.prefix, t.prefix);
  assert.equal(r.json.handoff.bin, t.bin);
  assert.deepEqual(r.json.handoff.args, ['install', '--scope', 'user']);
  assert.ok(r.json.hookCommand.includes(join(t.pkg, 'bin', 'ghx.js')), r.json.hookCommand);
  assert.deepEqual(r.json.changed, []);
  assert.match(r.json.next[0], /npm i -g @thegoldenmule\/ghx@/);
  assert.deepEqual(
    p.calls.map((c) => c.args.join(' ')),
    ['prefix -g'],
  );
  assert.ok(!existsSync(join(t.home, '.claude')), 'nothing written');
});

test('from npx: npm i -g this version, then the global copy runs install with the same flags; its output comes back', async () => {
  const t = setup();
  const child = {
    scope: 'user',
    dryRun: false,
    changed: [join(t.home, '.claude', 'settings.json')],
    files: [],
    hookCommand: `'${process.execPath}' '${join(t.pkg, 'bin', 'ghx.js')}' hook claude-pretooluse`,
    denyRules: [],
    binLink: null,
    next: ['Start a new Claude Code session so it loads the settings.'],
    warnings: [{ code: 'INSTALL_REFORMATTED', message: 'reformatted' }],
  };
  const p = proc(t, { child: { stdout: `${JSON.stringify(child)}\n` } });
  const r = await run(['install', '--no-snippet', '--bin-dir', 'bin'], t, p);
  assert.equal(r.exitCode, 0, r.stdout);
  assert.equal(r.json.hookCommand, child.hookCommand);
  assert.deepEqual(r.json.changed, child.changed);
  assert.equal(r.json.handoff.bin, t.bin);
  assert.match(r.json.next[0], /installed globally/);
  assert.deepEqual(r.json.warnings, child.warnings);
  const [prefix, install, run2] = p.calls;
  assert.deepEqual(prefix?.args, ['prefix', '-g']);
  assert.deepEqual(install?.args, ['i', '-g', `${PACKAGE_NAME}@${VERSION}`]);
  assert.deepEqual(run2?.args, [
    realpathSync(t.bin),
    'install',
    '--scope',
    'user',
    '--no-snippet',
    '--bin-dir',
    join(t.root, 'bin'),
  ]);
  assert.equal(run2?.env.GHX_NPX_HANDOFF, '1');
  assert.equal(run2?.env.npm_command, undefined);
  assert.equal(run2?.env.npm_lifecycle_event, undefined);
  assert.equal(run2?.env.HOME, t.home);
});

test('GHX_TEST_GLOBAL_SPEC replaces the package spec (pnpm pack:test installs the tarball)', async () => {
  const t = setup();
  const p = proc(t);
  const r = await run(['install', '--dry-run'], t, p, { ...NPX_ENV, GHX_TEST_GLOBAL_SPEC: '/tmp/ghx.tgz' });
  assert.deepEqual(r.json.handoff.install, ['npm', 'i', '-g', '/tmp/ghx.tgz']);
});

test('EACCES from npm i -g is INSTALL_NOT_WRITABLE with the nvm/fnm hint', async () => {
  const t = setup();
  const p = proc(t, {
    install: { exitCode: 243, stderr: 'npm error code EACCES\nnpm error syscall mkdir\nnpm error path /usr/lib/x\n' },
  });
  const r = await run(['install'], t, p);
  assert.equal(r.exitCode, EXIT.ENV);
  assert.equal(r.json.error.code, 'INSTALL_NOT_WRITABLE');
  assert.match(r.json.error.hint, /nvm or fnm/);
  assert.match(r.json.error.hint, /npm i -g @thegoldenmule\/ghx yourself/);
  assert.equal(r.json.error.details.prefix, t.prefix);
  assert.equal(p.calls.filter(isChild).length, 0);
});

test('npm missing is ENV_NPM_MISSING; any other npm failure is INSTALL_GLOBAL_FAILED with its stderr', async () => {
  const t = setup();
  const missing = await run(['install'], t, proc(t, { prefix: { spawnError: 'ENOENT' } }));
  assert.equal(missing.exitCode, EXIT.ENV);
  assert.equal(missing.json.error.code, 'ENV_NPM_MISSING');
  const failed = await run(['install'], t, proc(t, { install: { exitCode: 1, stderr: 'npm error 404 Not Found' } }));
  assert.equal(failed.exitCode, EXIT.ENV);
  assert.equal(failed.json.error.code, 'INSTALL_GLOBAL_FAILED');
  assert.match(failed.json.error.details.stderr, /404/);
});

test('an error from the global copy comes back as that error, with the handoff in details', async () => {
  const t = setup();
  const error = {
    code: 'INSTALL_SETTINGS_INVALID',
    message: 'settings.json is not JSON',
    hint: 'Fix it.',
    details: null,
  };
  const p = proc(t, { child: { exitCode: 4, stdout: `${JSON.stringify({ error })}\n` } });
  const r = await run(['install'], t, p);
  assert.equal(r.exitCode, EXIT.ENV);
  assert.equal(r.json.error.code, 'INSTALL_SETTINGS_INVALID');
  assert.match(r.json.error.message, /settings\.json is not JSON/);
  assert.equal(r.json.error.details.handoff.bin, t.bin);
});

test('--no-global from npx is refused with the reason, before npm runs', async () => {
  const t = setup();
  const p = proc(t);
  const r = await run(['install', '--no-global'], t, p);
  assert.equal(r.exitCode, EXIT.USAGE);
  assert.equal(r.json.error.code, 'VALIDATION');
  assert.match(r.json.error.message, /npx cache/);
  assert.deepEqual(p.calls, []);
});

test('outside npx, or once handed off, install runs here and never calls npm', async () => {
  const t = setup();
  const p = proc(t);
  const r = await run(['install', '--no-snippet'], t, p, { GHX_NPX_HANDOFF: '1', npm_command: 'exec' });
  assert.equal(r.exitCode, 0, r.stdout);
  assert.equal(r.json.handoff, undefined);
  assert.deepEqual(p.calls, []);
  assert.ok(existsSync(join(t.home, '.claude', 'settings.json')));
  const plain = await run(['install', '--no-snippet', '--no-global'], setup(), p, {});
  assert.equal(plain.exitCode, 0, '--no-global outside npx is a no-op');
});

test('npx resolving to the global install itself installs here, without a second npm i -g', async () => {
  const t = setup();
  // npm prefix -g answers a prefix whose package dir is this checkout: the "npx" copy is the global one.
  const root = join(import.meta.dirname, '..', '..');
  const fake = join(tmp, `self-${n++}`);
  mkdirSync(join(fake, 'lib', 'node_modules', '@thegoldenmule'), { recursive: true });
  symlinkSync(root, join(fake, 'lib', 'node_modules', '@thegoldenmule', 'ghx'));
  const p = proc(t, { prefix: { stdout: `${fake}\n` } });
  const r = await run(['install', '--no-snippet'], t, p);
  assert.equal(r.exitCode, 0, r.stdout);
  assert.equal(r.json.handoff, undefined);
  assert.deepEqual(
    p.calls.map((c) => c.args.join(' ')),
    ['prefix -g'],
  );
});
