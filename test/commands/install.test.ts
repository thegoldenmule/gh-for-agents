// ghx install (and uninstall), end to end in temp dirs. HOME and CLAUDE_CONFIG_DIR are injected
// through the harness env, so nothing here can reach the real ~/.claude.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BEGIN, END } from '../../src/install/claude-md.ts';
import { GHX_BIN } from '../../src/install/files.ts';
import { GHX_DENY_RULES } from '../../src/install/settings.ts';
import { EXIT } from '../contract/exit-table.ts';
import { fakeGit } from '../helpers/fake-git.ts';
import { runInProcess } from '../helpers/harness.ts';

const tmp = mkdtempSync(join(tmpdir(), 'ghx-install-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
/** A fresh fake home; returns it and its .claude paths. */
function home(files: Record<string, string> = {}) {
  const h = join(tmp, `home-${n++}`);
  const dir = join(h, '.claude');
  mkdirSync(dir, { recursive: true });
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  return { home: h, dir, settings: join(dir, 'settings.json'), claudeMd: join(dir, 'CLAUDE.md') };
}

const run = (argv: string[], env: Record<string, string>, o: { cwd?: string; git?: ReturnType<typeof fakeGit> } = {}) =>
  runInProcess(argv, { env, ...(o.cwd ? { cwd: o.cwd } : {}), ...(o.git ? { git: o.git } : {}) });

const read = (p: string) => readFileSync(p, 'utf8');
const json = (p: string) => JSON.parse(read(p));
const backups = (dir: string) => readdirSync(dir).filter((f) => f.includes('.bak-ghx-'));

/** A settings file as Claude Code writes it, with other hooks, permissions and env. */
const EXISTING = `${JSON.stringify(
  {
    env: { FOO: 'bar' },
    permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(rm -rf:*)'], defaultMode: 'auto' },
    model: 'opus',
    hooks: {
      PreToolUse: [],
      PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'pnpm fmt' }] }],
    },
  },
  null,
  2,
)}\n`;

test('fresh install: creates settings.json and CLAUDE.md with the deny rules, one hook and the block', async () => {
  const h = home();
  const r = await run(['install'], { HOME: h.home });
  assert.equal(r.exitCode, 0, r.stdout);
  assert.equal(r.json.scope, 'user');
  assert.equal(r.json.dryRun, false);
  assert.deepEqual(r.json.changed, [h.settings, h.claudeMd]);
  assert.deepEqual(
    r.json.files.map((f: { action: string; backup: string | null }) => [f.action, f.backup]),
    [
      ['created', null],
      ['created', null],
    ],
  );
  const s = json(h.settings);
  assert.deepEqual(s.permissions.deny, GHX_DENY_RULES);
  assert.deepEqual(s.hooks.PreToolUse, [
    { matcher: 'Bash|Monitor', hooks: [{ type: 'command', command: r.json.hookCommand, timeout: 5 }] },
  ]);
  assert.equal(s.env, undefined, 'GHX_HOOK_MODE is not set by default');
  assert.ok(r.json.hookCommand.includes(`'${process.execPath}'`));
  assert.ok(r.json.hookCommand.includes(`'${GHX_BIN}' hook claude-pretooluse`));
  const md = read(h.claudeMd);
  assert.ok(md.startsWith(`${BEGIN}\n## GitHub: use \`ghx\`, not \`gh\``));
  assert.ok(md.endsWith(`${END}\n`));
  assert.equal(r.json.binLink, null);
  assert.deepEqual(backups(h.dir), []);
});

test('CLAUDE_CONFIG_DIR wins over HOME for user scope', async () => {
  const h = home();
  const cfg = join(tmp, `cfg-${n++}`);
  const r = await run(['install', '--no-snippet'], { HOME: h.home, CLAUDE_CONFIG_DIR: cfg });
  assert.equal(r.exitCode, 0, r.stdout);
  assert.deepEqual(r.json.changed, [join(cfg, 'settings.json')]);
  assert.ok(!existsSync(h.settings));
});

test('without HOME or CLAUDE_CONFIG_DIR: INSTALL_HOME_UNKNOWN (exit 4), nothing written', async () => {
  const r = await run(['install'], {});
  assert.equal(r.exitCode, EXIT.ENV);
  assert.equal(r.json.error.code, 'INSTALL_HOME_UNKNOWN');
});

test('re-install with nothing changed: changed [] and no backups', async () => {
  const h = home({ 'settings.json': EXISTING, 'CLAUDE.md': '# Mine\n' });
  assert.equal((await run(['install'], { HOME: h.home })).exitCode, 0);
  const first = backups(h.dir);
  assert.equal(first.length, 2);
  const s1 = read(h.settings);
  const m1 = read(h.claudeMd);
  const r = await run(['install'], { HOME: h.home });
  assert.equal(r.exitCode, 0, r.stdout);
  assert.deepEqual(r.json.changed, []);
  assert.deepEqual(
    r.json.files.map((f: { action: string; backup: string | null }) => [f.action, f.backup]),
    [
      ['unchanged', null],
      ['unchanged', null],
    ],
  );
  assert.deepEqual(backups(h.dir), first);
  assert.equal(read(h.settings), s1);
  assert.equal(read(h.claudeMd), m1);
});

test('an existing settings file keeps its keys, order, other hooks, permissions and env; the original is backed up', async () => {
  const h = home({ 'settings.json': EXISTING });
  const r = await run(['install', '--no-snippet'], { HOME: h.home });
  assert.equal(r.exitCode, 0, r.stdout);
  const [file] = r.json.files;
  assert.equal(file.action, 'updated');
  assert.equal(read(file.backup), EXISTING);
  const s = json(h.settings);
  const orig = JSON.parse(EXISTING);
  assert.deepEqual(Object.keys(s), Object.keys(orig));
  assert.deepEqual(Object.keys(s.permissions), ['allow', 'deny', 'defaultMode']);
  assert.deepEqual(s.env, { FOO: 'bar' });
  assert.deepEqual(s.permissions.allow, orig.permissions.allow);
  assert.deepEqual(s.permissions.deny, ['Bash(rm -rf:*)', ...GHX_DENY_RULES]);
  assert.deepEqual(s.hooks.PostToolUse, orig.hooks.PostToolUse);
  assert.equal(s.hooks.PreToolUse.length, 1);
  assert.equal(s.model, 'opus');
  assert.ok(read(h.settings).endsWith('}\n'));
});

test('--hook-mode deny sets env.GHX_HOOK_MODE beside the existing env', async () => {
  const h = home({ 'settings.json': EXISTING });
  const r = await run(['install', '--no-snippet', '--hook-mode', 'deny'], { HOME: h.home });
  assert.equal(r.exitCode, 0, r.stdout);
  assert.deepEqual(json(h.settings).env, { FOO: 'bar', GHX_HOOK_MODE: 'deny' });
});

test('invalid JSON settings are refused untouched: INSTALL_SETTINGS_INVALID, no CLAUDE.md write, no backup', async () => {
  const bad = '{\n  "model": "opus",\n  // a comment\n}\n';
  const h = home({ 'settings.json': bad });
  const r = await run(['install'], { HOME: h.home });
  assert.equal(r.exitCode, EXIT.ENV);
  assert.equal(r.json.error.code, 'INSTALL_SETTINGS_INVALID');
  assert.equal(r.json.error.details.path, h.settings);
  assert.equal(read(h.settings), bad);
  assert.ok(!existsSync(h.claudeMd), 'nothing is written when any file is refused');
  assert.deepEqual(backups(h.dir), []);
});

test('an existing CLAUDE.md is preserved, and its ghx block is replaced in place on re-install', async () => {
  const h = home({ 'CLAUDE.md': '# Global rules\n\n- be brief\n' });
  assert.equal((await run(['install', '--no-deny', '--no-hook'], { HOME: h.home })).exitCode, 0);
  const md = read(h.claudeMd);
  assert.ok(md.startsWith(`# Global rules\n\n- be brief\n\n${BEGIN}\n`));
  // The user adds a section after the block, and the block goes stale.
  const stale = `${md.replace(/## GitHub: use `ghx`, not `gh`/, '## Old ghx text')}\n## Later\n`;
  writeFileSync(h.claudeMd, stale);
  const r = await run(['install', '--no-deny', '--no-hook'], { HOME: h.home });
  assert.equal(r.exitCode, 0, r.stdout);
  assert.equal(r.json.files[0].action, 'updated');
  assert.equal(read(h.claudeMd), `${md}\n## Later\n`);
  assert.equal(r.json.files.length, 1, '--no-deny --no-hook leaves settings.json alone');
  assert.ok(!existsSync(h.settings));
});

test('--dry-run writes nothing and returns unified diffs in wouldRun', async () => {
  const h = home({ 'settings.json': EXISTING, 'CLAUDE.md': '# Mine\n' });
  const r = await run(['install', '--dry-run'], { HOME: h.home });
  assert.equal(r.exitCode, 0, r.stdout);
  assert.equal(r.json.dryRun, true);
  assert.deepEqual(r.json.changed, [h.settings, h.claudeMd]);
  assert.deepEqual(
    r.json.wouldRun.map((w: { path: string; action: string }) => [w.path, w.action]),
    [
      [h.settings, 'updated'],
      [h.claudeMd, 'updated'],
    ],
  );
  const [sd, md] = r.json.wouldRun.map((w: { diff: string }) => w.diff);
  assert.match(sd, /^--- .*settings\.json\n\+\+\+ .*settings\.json\n@@ /);
  assert.match(sd, /^\+ {6}"Bash\(gh pr merge:\*\)",?$/m);
  assert.match(sd, /^\+ {12}"command": ".*hook claude-pretooluse",$/m);
  assert.match(md, /^\+<!-- ghx:begin -->$/m);
  assert.equal(read(h.settings), EXISTING);
  assert.equal(read(h.claudeMd), '# Mine\n');
  assert.deepEqual(backups(h.dir), []);
  // A fresh home under --dry-run does not even create ~/.claude.
  const fresh = join(tmp, `fresh-${n++}`);
  const f = await run(['install', '--dry-run'], { HOME: fresh });
  assert.equal(f.exitCode, 0, f.stdout);
  assert.ok(!existsSync(fresh));
});

test('--no-deny and --no-hook each leave their part out', async () => {
  const a = home();
  const r1 = await run(['install', '--no-deny', '--no-snippet'], { HOME: a.home });
  assert.equal(r1.exitCode, 0, r1.stdout);
  assert.deepEqual(r1.json.denyRules, []);
  assert.equal(json(a.settings).permissions, undefined);
  assert.equal(json(a.settings).hooks.PreToolUse.length, 1);
  const b = home();
  const r2 = await run(['install', '--no-hook', '--no-snippet'], { HOME: b.home });
  assert.equal(r2.exitCode, 0, r2.stdout);
  assert.equal(r2.json.hookCommand, null);
  assert.equal(json(b.settings).hooks, undefined);
  assert.deepEqual(json(b.settings).permissions.deny, GHX_DENY_RULES);
  assert.ok(!existsSync(b.claudeMd), '--no-snippet');
});

test('project scope: .claude/settings.json and CLAUDE.md at the git toplevel, with an absolute-path warning', async () => {
  const repo = join(tmp, `repo-${n++}`);
  mkdirSync(join(repo, 'sub'), { recursive: true });
  writeFileSync(join(repo, 'CLAUDE.md'), '# Repo\n');
  const h = home();
  const r = await run(['install', '--scope', 'project'], { HOME: h.home }, { git: fakeGit({ toplevel: repo }) });
  assert.equal(r.exitCode, 0, r.stdout);
  assert.equal(r.json.scope, 'project');
  assert.deepEqual(r.json.changed, [join(repo, '.claude', 'settings.json'), join(repo, 'CLAUDE.md')]);
  assert.deepEqual(json(join(repo, '.claude', 'settings.json')).permissions.deny, GHX_DENY_RULES);
  assert.ok(read(join(repo, 'CLAUDE.md')).startsWith(`# Repo\n\n${BEGIN}`));
  assert.ok(r.json.warnings.some((w: { code: string }) => w.code === 'INSTALL_PROJECT_ABSOLUTE_PATHS'));
  assert.ok(!existsSync(h.settings), 'user scope untouched');
  const outside = await run(['install', '--scope', 'project'], { HOME: h.home }, { git: fakeGit({}) });
  assert.equal(outside.json.error.code, 'REPO_NOT_FOUND');
});

test('--bin-dir links <dir>/ghx to bin/ghx.js, reports PATH, and is idempotent', async () => {
  const h = home();
  const bin = join(tmp, `bin-${n++}`);
  mkdirSync(bin);
  const r = await run(['install', '--no-snippet', '--bin-dir', bin], { HOME: h.home, PATH: `/usr/bin:${bin}` });
  assert.equal(r.exitCode, 0, r.stdout);
  assert.deepEqual(r.json.binLink, { path: join(bin, 'ghx'), target: GHX_BIN, action: 'created', onPath: true });
  assert.equal(readlinkSync(join(bin, 'ghx')), GHX_BIN);
  const again = await run(['install', '--no-snippet', '--bin-dir', bin], { HOME: h.home, PATH: '/usr/bin' });
  assert.equal(again.json.binLink.action, 'unchanged');
  assert.equal(again.json.binLink.onPath, false);
  assert.deepEqual(again.json.changed, []);
  assert.ok(again.json.next.some((s: string) => s.includes(`Add ${bin} to PATH`)));
});

test('a bin link that collides with a foreign file is refused: INSTALL_BIN_CONFLICT, nothing written', async () => {
  const h = home();
  const bin = join(tmp, `bin-${n++}`);
  mkdirSync(bin);
  writeFileSync(join(bin, 'ghx'), '#!/bin/sh\necho other\n');
  const r = await run(['install', '--bin-dir', bin], { HOME: h.home });
  assert.equal(r.exitCode, EXIT.ENV);
  assert.equal(r.json.error.code, 'INSTALL_BIN_CONFLICT');
  assert.equal(read(join(bin, 'ghx')), '#!/bin/sh\necho other\n');
  assert.ok(!existsSync(h.settings) && !existsSync(h.claudeMd));
  symlinkSync('/somewhere/else', join(bin, 'other'));
  const missing = await run(['install', '--bin-dir', join(bin, 'nope')], { HOME: h.home });
  assert.equal(missing.json.error.code, 'VALIDATION');
  assert.ok(lstatSync(join(bin, 'other')).isSymbolicLink());
});

test('the hook command it writes runs without PATH and denies a raw gh write', async () => {
  const h = home();
  const r = await run(['install', '--no-snippet'], { HOME: h.home });
  const command = json(h.settings).hooks.PreToolUse[0].hooks[0].command;
  assert.equal(command, r.json.hookCommand);
  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh -R o/r pr merge 12' } });
  const out = spawnSync('/bin/sh', ['-c', command], {
    input: payload,
    env: { PATH: '/nonexistent' },
    encoding: 'utf8',
  });
  assert.equal(out.status, 0, out.stderr);
  const reply = JSON.parse(out.stdout);
  assert.equal(reply.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(reply.hookSpecificOutput.permissionDecisionReason, /ghx pr merge 12/);
});

// ── ghx uninstall ───────────────────────────────────────────────────────────────

test('uninstall restores the original byte for byte when ghx was the only change, keeping its empty PreToolUse', async () => {
  const md = '# Global rules\n\n- be brief\n';
  const h = home({ 'settings.json': EXISTING, 'CLAUDE.md': md });
  const bin = join(tmp, `bin-${n++}`);
  mkdirSync(bin);
  const env = { HOME: h.home };
  assert.equal((await run(['install', '--hook-mode', 'deny', '--bin-dir', bin], env)).exitCode, 0);
  assert.notEqual(read(h.settings), EXISTING);
  const r = await run(['uninstall', '--bin-dir', bin], env);
  assert.equal(r.exitCode, 0, r.stdout);
  assert.equal(read(h.settings), EXISTING, 'EXISTING had "PreToolUse": [] and keeps it');
  assert.equal(read(h.claudeMd), md);
  assert.ok(!existsSync(join(bin, 'ghx')));
  assert.equal(r.json.binLink.action, 'removed');
  assert.deepEqual(r.json.denyRules, GHX_DENY_RULES);
  assert.match(r.json.hookCommand, /hook claude-pretooluse$/);
  assert.ok(r.json.files.every((f: { action: string; backup: string | null }) => f.action === 'updated' && f.backup));
  // Idempotent: a second uninstall changes nothing and makes no new backups.
  const count = backups(h.dir).length;
  const again = await run(['uninstall', '--bin-dir', bin], env);
  assert.deepEqual(again.json.changed, []);
  assert.equal(again.json.binLink.action, 'absent');
  assert.equal(backups(h.dir).length, count);
});

test('uninstall after a fresh install removes the files ghx created, and drops containers it created', async () => {
  const h = home();
  assert.equal((await run(['install'], { HOME: h.home })).exitCode, 0);
  const r = await run(['uninstall'], { HOME: h.home });
  assert.equal(r.exitCode, 0, r.stdout);
  assert.deepEqual(
    r.json.files.map((f: { action: string }) => f.action),
    ['removed', 'removed'],
  );
  assert.ok(!existsSync(h.settings) && !existsSync(h.claudeMd));
  // A settings file without the containers gets none back.
  const other = home({ 'settings.json': '{\n  "model": "opus"\n}\n' });
  await run(['install', '--no-snippet'], { HOME: other.home });
  await run(['uninstall'], { HOME: other.home });
  assert.equal(read(other.settings), '{\n  "model": "opus"\n}\n');
});

test('uninstall leaves user-added deny rules, hooks and env alone', async () => {
  const h = home({ 'settings.json': EXISTING });
  await run(['install', '--no-snippet'], { HOME: h.home });
  const s = json(h.settings);
  s.permissions.deny.push('Bash(git push:*)');
  s.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'audit' }] });
  s.env.EXTRA = '1';
  writeFileSync(h.settings, `${JSON.stringify(s, null, 2)}\n`);
  const r = await run(['uninstall'], { HOME: h.home });
  assert.equal(r.exitCode, 0, r.stdout);
  const out = json(h.settings);
  assert.deepEqual(out.permissions.deny, ['Bash(rm -rf:*)', 'Bash(git push:*)']);
  assert.deepEqual(out.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'audit' }] }]);
  assert.deepEqual(out.env, { FOO: 'bar', EXTRA: '1' });
  assert.deepEqual(out.hooks.PostToolUse, JSON.parse(EXISTING).hooks.PostToolUse);
});

test('uninstall --dry-run writes nothing; a foreign bin file is left alone with a warning', async () => {
  const h = home({ 'CLAUDE.md': '# Mine\n' });
  await run(['install'], { HOME: h.home });
  const s = read(h.settings);
  const m = read(h.claudeMd);
  const bin = join(tmp, `bin-${n++}`);
  mkdirSync(bin);
  writeFileSync(join(bin, 'ghx'), 'other');
  const r = await run(['uninstall', '--dry-run', '--bin-dir', bin], { HOME: h.home });
  assert.equal(r.exitCode, 0, r.stdout);
  assert.equal(r.json.dryRun, true);
  assert.deepEqual(
    r.json.wouldRun.map((w: { action: string }) => w.action),
    ['removed', 'updated'],
  );
  assert.match(r.json.wouldRun[1].diff, /^-<!-- ghx:begin -->$/m);
  assert.equal(read(h.settings), s);
  assert.equal(read(h.claudeMd), m);
  assert.equal(r.json.binLink.action, 'unchanged');
  assert.ok(r.json.warnings.some((w: { code: string }) => w.code === 'INSTALL_BIN_FOREIGN'));
  assert.equal(read(join(bin, 'ghx')), 'other');
});

test('uninstall refuses invalid settings JSON untouched', async () => {
  const h = home({ 'settings.json': '{,}' });
  const r = await run(['uninstall'], { HOME: h.home });
  assert.equal(r.json.error.code, 'INSTALL_SETTINGS_INVALID');
  assert.equal(read(h.settings), '{,}');
});

// ── ghx doctor's install check ─────────────────────────────────────────────────

test('doctor reports the install per scope, informationally, and flags a hook whose paths are gone', async () => {
  const h = home();
  const repo = join(tmp, `repo-${n++}`);
  mkdirSync(repo);
  const git = fakeGit({ toplevel: repo });
  const before = await run(['doctor'], { HOME: h.home }, { git });
  assert.notEqual(before.exitCode, 1, before.stdout);
  assert.deepEqual(before.json.install.user.hook, { installed: false, command: null, missingPaths: [] });
  assert.equal(before.json.install.user.status, 'missing');
  assert.equal(before.json.install.project.settings, join(repo, '.claude', 'settings.json'));
  assert.ok(!before.json.checks.some((c: { name: string }) => c.name.includes('install')), 'not a failing check');

  await run(['install'], { HOME: h.home });
  const after = await run(['doctor'], { HOME: h.home }, { git });
  assert.equal(after.exitCode, before.exitCode, 'the install never changes doctor’s exit code');
  const u = after.json.install.user;
  assert.equal(u.status, 'ok');
  assert.equal(u.hook.installed, true);
  assert.deepEqual(u.hook.missingPaths, []);
  assert.deepEqual(u.deny, { present: GHX_DENY_RULES.length, total: GHX_DENY_RULES.length, missing: [] });
  assert.equal(u.claudeMd.block, true);
  assert.equal(after.json.install.project.hook.installed, false);

  // A hook pointing at a node that has since been removed is reported, and doctor still does not fail on it.
  const s = json(h.settings);
  s.hooks.PreToolUse[0].hooks[0].command = `'/gone/node' '${GHX_BIN}' hook claude-pretooluse`;
  writeFileSync(h.settings, JSON.stringify(s));
  const stale = await run(['doctor'], { HOME: h.home }, { git });
  assert.deepEqual(stale.json.install.user.hook.missingPaths, ['/gone/node']);
  assert.ok(stale.json.warnings.some((w: { code: string }) => w.code === 'INSTALL_HOOK_STALE'));
  assert.equal(stale.exitCode, before.exitCode);

  const none = await run(['doctor'], {});
  assert.deepEqual(none.json.install, { user: null, project: null });
});
