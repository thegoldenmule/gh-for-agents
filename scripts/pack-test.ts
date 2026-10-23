#!/usr/bin/env node
// pnpm pack:test: build, `npm pack`, install the tarball globally into a temp prefix, and drive the
// installed ghx the way a user would. Everything (npm prefix, npm cache, HOME) lives under one temp
// dir, so nothing touches the real ~/.claude, ~/.npm or the global npm prefix. Needs the network for
// zod. Prints one line per step and exits 1 on the first failure. GHX_PACK_KEEP=1 keeps the temp dir.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { name: string; version: string };
const TMP = mkdtempSync(join(realpathSync(tmpdir()), 'ghx-pack-'));
const KEEP = process.env.GHX_PACK_KEEP === '1';

type Env = Record<string, string>;

/** npm's environment: the caller's PATH (to find npm), and a temp HOME, cache and prefix. */
function npmEnv(prefix: string, home: string): Env {
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    npm_config_cache: join(TMP, 'npm-cache'),
    npm_config_prefix: prefix,
    npm_config_userconfig: join(TMP, 'npmrc'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_loglevel: 'error',
    ...(process.env.npm_config_registry ? { npm_config_registry: process.env.npm_config_registry } : {}),
  };
}

/** ghx's environment: a minimal PATH holding this node, and a temp HOME. Nothing else is inherited. */
function ghxEnv(home: string, extra: Env = {}): Env {
  return { PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter), HOME: home, ...extra };
}

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], o: { env: Env; cwd?: string; input?: string }): Ran {
  const r = spawnSync(cmd, args, {
    env: o.env,
    cwd: o.cwd ?? TMP,
    input: o.input ?? '',
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function ok(r: Ran, what: string): Ran {
  assert.equal(r.status, 0, `${what} exited ${r.status}\n${r.stdout.slice(-2000)}\n${r.stderr.slice(-2000)}`);
  return r;
}

function json(r: Ran, what: string): any {
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`${what} did not print one JSON document (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
  }
}

let failed = false;
function step(name: string, fn: () => string | undefined): void {
  if (failed) return;
  const t = Date.now();
  try {
    const note = fn();
    console.log(`ok   ${name} (${Date.now() - t} ms)${note ? `: ${note}` : ''}`);
  } catch (e) {
    failed = true;
    console.log(`FAIL ${name}`);
    console.log(e instanceof Error ? (e.stack ?? e.message) : String(e));
  }
}

const read = (p: string): string => readFileSync(p, 'utf8');
const hookCommands = (settingsPath: string): string[] =>
  (JSON.parse(read(settingsPath)).hooks?.PreToolUse ?? []).flatMap((e: { hooks?: { command?: string }[] }) =>
    (e.hooks ?? []).map((h) => h.command ?? ''),
  );

let tarball = '';
const prefix = join(TMP, 'prefix');
const pkgRoot = join(prefix, 'lib', 'node_modules', ...PKG.name.split('/'));
const ghx = join(prefix, 'bin', 'ghx');
const home = join(TMP, 'home');
const work = join(TMP, 'work');
const repo = join(TMP, 'repo');
for (const d of [home, work, join(repo, '.git'), join(repo, '.github')]) mkdirSync(d, { recursive: true });
writeFileSync(join(repo, '.github', 'ghx.json'), '{"version":1}\n');
writeFileSync(join(TMP, 'npmrc'), '');

step('build (rm -rf dist && tsc -p tsconfig.build.json)', () => {
  rmSync(join(ROOT, 'dist'), { recursive: true, force: true });
  ok(
    run(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'], {
      env: { PATH: process.env.PATH ?? '' },
      cwd: ROOT,
    }),
    'tsc',
  );
  assert.ok(existsSync(join(ROOT, 'dist', 'main.js')), 'dist/main.js was not built');
  return undefined;
});

step('npm pack', () => {
  const r = ok(
    run('npm', ['pack', '--json', '--pack-destination', TMP], { env: npmEnv(prefix, home), cwd: ROOT }),
    'npm pack',
  );
  const [info] = JSON.parse(r.stdout) as { filename: string; files: { path: string }[] }[];
  assert.ok(info);
  tarball = join(TMP, info.filename);
  const files = info.files.map((f) => f.path);
  for (const want of [
    'bin/ghx.js',
    'dist/main.js',
    'dist/hook/replaces.generated.json',
    'docs/agents/claude-md-snippet.md',
    'LICENSE',
    'README.md',
    'package.json',
  ]) {
    assert.ok(files.includes(want), `${want} is missing from the tarball`);
  }
  const stray = files.filter((f) => /^(src|test|scripts)\//.test(f) || f.endsWith('.map') || f.endsWith('.ts'));
  assert.deepEqual(stray, [], 'unexpected files in the tarball');
  return `${info.filename}, ${files.length} files`;
});

step('npm i -g --prefix <tmp> <tarball>', () => {
  ok(run('npm', ['i', '-g', '--prefix', prefix, tarball], { env: npmEnv(prefix, home) }), 'npm i -g');
  assert.ok(existsSync(ghx), `${ghx} was not linked`);
  assert.ok(!existsSync(join(pkgRoot, 'src')), 'the installed package has src/');
  return pkgRoot;
});

step('ghx --version', () => {
  const v = json(ok(run(ghx, ['--version'], { env: ghxEnv(home) }), 'ghx --version'), 'ghx --version');
  assert.equal(v.version, PKG.version);
  return v.version;
});

step('ghx doctor (no install yet)', () => {
  const r = run(ghx, ['doctor'], { env: ghxEnv(home), cwd: work });
  const d = json(r, 'ghx doctor');
  assert.equal(d.error, undefined, r.stdout);
  assert.ok(Array.isArray(d.checks));
  assert.equal(d.install.user.hook.installed, false);
  return `exit ${r.status} (gh/auth state depends on the machine)`;
});

const settings = join(home, '.claude', 'settings.json');
const claudeMd = join(home, '.claude', 'CLAUDE.md');
const binJs = join(realpathSync(pkgRoot), 'bin', 'ghx.js');

step('ghx install --dry-run', () => {
  const d = json(
    ok(run(ghx, ['install', '--dry-run'], { env: ghxEnv(home), cwd: work }), 'install --dry-run'),
    'install --dry-run',
  );
  assert.equal(d.dryRun, true);
  assert.ok(d.hookCommand.includes(binJs), `hook command ${d.hookCommand} does not run ${binJs}`);
  assert.ok(!existsSync(settings), 'dry run wrote settings.json');
  return `${d.wouldRun.length} planned changes`;
});

step('ghx install', () => {
  const d = json(ok(run(ghx, ['install'], { env: ghxEnv(home), cwd: work }), 'install'), 'install');
  const [command, ...more] = hookCommands(settings);
  assert.equal(more.length, 0);
  assert.ok(command?.includes(binJs), `hook command ${command} does not point into the temp global prefix`);
  assert.ok(command?.includes(realpathSync(prefix)), command);
  assert.ok(!command?.includes('_npx'), command);
  assert.ok(read(claudeMd).includes('ghx'));
  return `${d.changed.length} files; hook ${command}`;
});

step('the installed hook denies a gh write in a ghx repo', () => {
  const [command] = hookCommands(settings);
  assert.ok(command);
  const payload = {
    session_id: 'pack-test',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'gh pr merge 1 --squash' },
    cwd: repo,
  };
  const r = ok(
    run('/bin/sh', ['-c', command], { env: ghxEnv(home), cwd: repo, input: JSON.stringify(payload) }),
    'hook',
  );
  const out = json(r, 'hook');
  assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny', r.stdout);
  return out.hookSpecificOutput.permissionDecisionReason.slice(0, 60);
});

step('ghx doctor sees the install, with no hook warnings', () => {
  const d = json(run(ghx, ['doctor'], { env: ghxEnv(home), cwd: work }), 'ghx doctor');
  assert.equal(d.install.user.hook.installed, true);
  assert.deepEqual(d.install.user.hook.missingPaths, []);
  const hookWarnings = (d.warnings ?? []).filter((w: { code: string }) => w.code.startsWith('INSTALL_HOOK_'));
  assert.deepEqual(hookWarnings, []);
  return undefined;
});

step('ghx uninstall', () => {
  ok(run(ghx, ['uninstall'], { env: ghxEnv(home), cwd: work }), 'uninstall');
  assert.ok(!existsSync(settings), 'settings.json (created by install) is still there');
  assert.ok(!existsSync(claudeMd), 'CLAUDE.md (created by install) is still there');
  return undefined;
});

if (KEEP) console.log(`kept ${TMP}`);
else rmSync(TMP, { recursive: true, force: true });
console.log(failed ? 'pack:test FAILED' : 'pack:test passed');
process.exitCode = failed ? 1 : 0;
