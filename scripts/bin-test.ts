#!/usr/bin/env node
// pnpm bin:test [--bin <path>]: drive a standalone binary (default: dist-bin/ghx-<this os>-<arch>, from
// pnpm build:bin) the way a user would, in a temp HOME with a PATH holding no node: version, doctor,
// install --bin-dir (hook and link name the binary itself), the hook denying a gh write, doctor, uninstall.
// The pack:test of the binary; one line per step, exit 1 on the first failure. GHX_BIN_KEEP=1 keeps the temp dir.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
const args = process.argv.slice(2);
const at = args.indexOf('--bin');
const given = at >= 0 ? args[at + 1] : args.find((a) => a.startsWith('--bin='))?.slice('--bin='.length);
const BIN = realpathSync(resolve(given ?? join(ROOT, 'dist-bin', `ghx-${process.platform}-${process.arch}`)));
const TMP = mkdtempSync(join(realpathSync(tmpdir()), 'ghx-bin-'));
const KEEP = process.env.GHX_BIN_KEEP === '1';

type Env = Record<string, string>;
interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** No node on PATH: the binary must not need one. */
const env = (home: string): Env => ({ PATH: '/usr/bin:/bin', HOME: home });

function run(cmd: string, argv: string[], o: { env: Env; cwd?: string; input?: string }): Ran {
  const r = spawnSync(cmd, argv, { env: o.env, cwd: o.cwd ?? TMP, input: o.input ?? '', encoding: 'utf8' });
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

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

let failed = false;
function step(name: string, fn: () => string | undefined): void {
  if (failed) return;
  const t = Date.now();
  try {
    const note = fn();
    say(`ok   ${name} (${Date.now() - t} ms)${note ? `: ${note}` : ''}`);
  } catch (e) {
    failed = true;
    say(`FAIL ${name}`);
    say(e instanceof Error ? (e.stack ?? e.message) : String(e));
  }
}

const read = (p: string): string => readFileSync(p, 'utf8');
const hookCommands = (settingsPath: string): string[] =>
  (JSON.parse(read(settingsPath)).hooks?.PreToolUse ?? []).flatMap((e: { hooks?: { command?: string }[] }) =>
    (e.hooks ?? []).map((h) => h.command ?? ''),
  );

const home = join(TMP, 'home');
const work = join(TMP, 'work');
const repo = join(TMP, 'repo');
const binDir = join(TMP, 'bin');
for (const d of [home, work, binDir, join(repo, '.git'), join(repo, '.github')]) mkdirSync(d, { recursive: true });
writeFileSync(join(repo, '.github', 'ghx.json'), '{"version":1}\n');
const settings = join(home, '.claude', 'settings.json');
const claudeMd = join(home, '.claude', 'CLAUDE.md');
const expected = `'${BIN}' hook claude-pretooluse`;
say(`binary ${BIN}`);

step('ghx --version', () => {
  const v = json(ok(run(BIN, ['--version'], { env: env(home) }), 'ghx --version'), 'ghx --version');
  assert.equal(v.version, PKG.version);
  assert.equal(v.runtime?.name, 'bun');
  assert.equal(v.runtime?.standalone, true);
  assert.equal(v.node, null);
  return `${v.version} on bun ${v.runtime.version} (${v.platform})`;
});

step('ghx doctor (no install yet)', () => {
  const r = run(BIN, ['doctor'], { env: env(home), cwd: work });
  const d = json(r, 'ghx doctor');
  assert.equal(d.error, undefined, r.stdout);
  assert.equal(d.install.user.hook.installed, false);
  return `exit ${r.status} (gh/auth state depends on the machine)`;
});

step('ghx install --dry-run', () => {
  const d = json(ok(run(BIN, ['install', '--dry-run'], { env: env(home), cwd: work }), 'install --dry-run'), 'dry');
  assert.equal(d.dryRun, true);
  assert.equal(d.hookCommand, expected);
  assert.equal(d.handoff, undefined, 'the binary never hands off to npm');
  assert.ok(!existsSync(settings), 'dry run wrote settings.json');
  return `${d.wouldRun.length} planned changes`;
});

step('ghx install --bin-dir', () => {
  const d = json(ok(run(BIN, ['install', '--bin-dir', binDir], { env: env(home), cwd: work }), 'install'), 'install');
  assert.deepEqual(hookCommands(settings), [expected]);
  assert.ok(read(claudeMd).includes('ghx'), 'CLAUDE.md has no ghx block');
  assert.equal(readlinkSync(join(binDir, 'ghx')), BIN);
  return `${d.changed.length} files; hook ${expected}`;
});

step('the installed hook denies a gh write in a ghx repo', () => {
  const [command] = hookCommands(settings);
  assert.ok(command);
  const payload = {
    session_id: 'bin-test',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'gh pr merge 1 --squash' },
    cwd: repo,
  };
  const r = ok(run('/bin/sh', ['-c', command], { env: env(home), cwd: repo, input: JSON.stringify(payload) }), 'hook');
  const out = json(r, 'hook');
  assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny', r.stdout);
  return out.hookSpecificOutput.permissionDecisionReason.slice(0, 60);
});

step('ghx doctor sees the install, with no hook warnings', () => {
  const d = json(run(BIN, ['doctor'], { env: env(home), cwd: work }), 'ghx doctor');
  const hook = d.install.user.hook;
  assert.equal(hook.installed, true);
  assert.deepEqual(hook.missingPaths, []);
  assert.equal(hook.binary, BIN);
  assert.equal(hook.node, null);
  assert.equal(hook.version, PKG.version);
  const hookWarnings = (d.warnings ?? []).filter((w: { code: string }) => w.code.startsWith('INSTALL_HOOK_'));
  assert.deepEqual(hookWarnings, []);
  return undefined;
});

step('ghx uninstall', () => {
  ok(run(BIN, ['uninstall'], { env: env(home), cwd: work }), 'uninstall');
  assert.ok(!existsSync(settings), 'settings.json (created by install) is still there');
  assert.ok(!existsSync(claudeMd), 'CLAUDE.md (created by install) is still there');
  assert.ok(!existsSync(join(binDir, 'ghx')), 'the --bin-dir link is still there');
  return undefined;
});

if (KEEP) say(`kept ${TMP}`);
else rmSync(TMP, { recursive: true, force: true });
if (failed) process.exitCode = 1;
