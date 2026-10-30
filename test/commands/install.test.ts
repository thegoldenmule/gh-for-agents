// ghx install (and uninstall), end to end in temp dirs. HOME and CLAUDE_CONFIG_DIR are injected
// through the harness env, so nothing here can reach the real ~/.claude.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
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
import { VERSION } from '../../src/version.ts';
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
/** Every ghx backup under dir, at any depth (today's live in <config>/ghx-install/<target>/backups). */
const backups = (dir: string) =>
  (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.includes('.bak-ghx-')).sort();

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

test('fresh install: creates settings.json and CLAUDE.md with one hook and the block, and no deny rules at user scope', async () => {
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
  assert.equal(s.permissions, undefined, 'user scope adds no deny rules');
  assert.deepEqual(r.json.denyRules, []);
  assert.deepEqual(s.hooks.PreToolUse, [
    { matcher: 'Bash|Monitor', hooks: [{ type: 'command', command: r.json.hookCommand, timeout: 5 }] },
  ]);
  assert.equal(s.env, undefined, 'GHX_HOOK_MODE is not set by default');
  assert.ok(r.json.hookCommand.includes(`'${process.execPath}'`));
  assert.ok(r.json.hookCommand.includes(`'${GHX_BIN}' hook claude-pretooluse`));
  const md = read(h.claudeMd);
  assert.ok(md.startsWith(`${BEGIN}\n## GitHub: use \`ghx\` in repos that have \`.github/ghx.json\``));
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
  assert.deepEqual(s.permissions, orig.permissions);
  assert.deepEqual(s.hooks.PostToolUse, orig.hooks.PostToolUse);
  assert.equal(s.hooks.PreToolUse.length, 1);
  assert.equal(s.model, 'opus');
  assert.ok(read(h.settings).endsWith('}\n'));
});

test('--hook-mode ask sets env.GHX_HOOK_MODE beside the existing env', async () => {
  const h = home({ 'settings.json': EXISTING });
  const r = await run(['install', '--no-snippet', '--hook-mode', 'ask'], { HOME: h.home });
  assert.equal(r.exitCode, 0, r.stdout);
  assert.deepEqual(json(h.settings).env, { FOO: 'bar', GHX_HOOK_MODE: 'ask' });
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

const asRoot = process.getuid?.() === 0;

test('a read-only settings file or config dir is refused before anything is written: INSTALL_NOT_WRITABLE', {
  skip: asRoot,
}, async () => {
  const h = home({ 'settings.json': EXISTING });
  chmodSync(h.settings, 0o444);
  const r = await run(['install'], { HOME: h.home });
  assert.equal(r.exitCode, EXIT.ENV, r.stdout);
  assert.equal(r.json.error.code, 'INSTALL_NOT_WRITABLE');
  assert.equal(r.json.error.details.path, h.settings);
  assert.equal(read(h.settings), EXISTING, 'r1: refused, not overwritten');
  assert.ok(!existsSync(h.claudeMd), 'no other file was written either');
  assert.deepEqual(backups(h.dir), []);
  const dry = await run(['install', '--dry-run'], { HOME: h.home });
  assert.equal(dry.json.error.code, 'INSTALL_NOT_WRITABLE', 'the preview fails the way the real run would');
  chmodSync(h.settings, 0o644);

  // A directory that won't take the new CLAUDE.md: the settings file isn't touched first.
  const d = home({ 'settings.json': EXISTING });
  chmodSync(d.dir, 0o555);
  try {
    const r2 = await run(['install'], { HOME: d.home });
    assert.equal(r2.exitCode, EXIT.ENV, r2.stdout);
    assert.equal(r2.json.error.code, 'INSTALL_NOT_WRITABLE');
    assert.match(r2.json.error.hint, /writable/);
    assert.equal(read(d.settings), EXISTING);
    assert.ok(!existsSync(d.claudeMd));
  } finally {
    chmodSync(d.dir, 0o755);
  }
  assert.deepEqual(backups(d.dir), []);
});

test('an existing CLAUDE.md is preserved, and its ghx block is replaced in place on re-install', async () => {
  const h = home({ 'CLAUDE.md': '# Global rules\n\n- be brief\n' });
  assert.equal((await run(['install', '--no-deny', '--no-hook'], { HOME: h.home })).exitCode, 0);
  const md = read(h.claudeMd);
  assert.ok(md.startsWith(`# Global rules\n\n- be brief\n\n${BEGIN}\n`));
  // The user adds a section after the block, and the block goes stale.
  const stale = `${md.replace(/## GitHub: use `ghx` in repos that have `.github\/ghx.json`/, '## Old ghx text')}\n## Later\n`;
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
  assert.doesNotMatch(sd, /Bash\(gh pr merge/);
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

test('--no-deny and --no-hook each leave their part out; --deny is refused at user scope', async () => {
  const repo = join(tmp, `repo-${n++}`);
  mkdirSync(repo);
  const local = join(repo, '.claude', 'settings.local.json');
  const a = home();
  const git = fakeGit({ toplevel: repo, ignored: [local] });
  const r1 = await run(['install', '--scope', 'project', '--no-deny', '--no-snippet'], { HOME: a.home }, { git });
  assert.equal(r1.exitCode, 0, r1.stdout);
  assert.deepEqual(r1.json.denyRules, []);
  assert.equal(json(local).permissions, undefined);
  assert.equal(json(local).hooks.PreToolUse.length, 1);
  rmSync(join(repo, '.claude'), { recursive: true });
  const r2 = await run(['install', '--scope', 'project', '--no-hook', '--no-snippet'], { HOME: a.home }, { git });
  assert.equal(r2.exitCode, 0, r2.stdout);
  assert.equal(r2.json.hookCommand, null);
  assert.equal(json(local).hooks, undefined);
  assert.deepEqual(json(local).permissions.deny, GHX_DENY_RULES);
  assert.ok(!existsSync(join(repo, 'CLAUDE.md')), '--no-snippet');
  // User scope: --no-hook alone has nothing to put in settings; --deny is refused before anything is read.
  const b = home();
  const r3 = await run(['install', '--no-hook', '--no-snippet'], { HOME: b.home });
  assert.equal(r3.exitCode, 0, r3.stdout);
  assert.ok(!existsSync(b.settings));
  const r4 = await run(['install', '--deny'], { HOME: b.home });
  assert.equal(r4.exitCode, EXIT.USAGE);
  assert.equal(r4.json.error.code, 'VALIDATION');
  assert.match(r4.json.error.hint, /--scope project/);
  assert.ok(!existsSync(b.claudeMd));
});

test('a user-scope re-install removes the deny rules an earlier ghx install added, and only those', async () => {
  // The legacy state: a user rule identical to a ghx one, then a pre-manifest ghx install (backup sibling).
  const mine = { permissions: { deny: ['Bash(gh pr merge:*)', 'Bash(rm:*)'] } };
  const pre = `${JSON.stringify(mine, null, 2)}\n`;
  const old = {
    permissions: { deny: [...mine.permissions.deny, ...GHX_DENY_RULES.filter((r) => r !== 'Bash(gh pr merge:*)')] },
    hooks: {
      PreToolUse: [
        { matcher: 'Bash|Monitor', hooks: [{ type: 'command', command: "'/n' '/g' hook claude-pretooluse" }] },
      ],
    },
  };
  const h = home({
    'settings.json': `${JSON.stringify(old, null, 2)}\n`,
    'settings.json.bak-ghx-20261001T000000Z': pre,
  });
  const r = await run(['install', '--no-snippet'], { HOME: h.home });
  assert.equal(r.exitCode, 0, r.stdout);
  assert.deepEqual(json(h.settings).permissions.deny, ['Bash(gh pr merge:*)', 'Bash(rm:*)']);
  assert.ok(r.json.warnings.some((w: { code: string }) => w.code === 'INSTALL_DENY_REMOVED'));
  assert.deepEqual(r.json.denyRules, []);
  // Hand-written ghx-identical rules with no ghx install behind them are not ghx's to remove.
  const hand = home({
    'settings.json': `${JSON.stringify({ permissions: { deny: [...GHX_DENY_RULES] } }, null, 2)}\n`,
  });
  const r2 = await run(['install', '--no-snippet'], { HOME: hand.home });
  assert.equal(r2.exitCode, 0, r2.stdout);
  assert.deepEqual(json(hand.settings).permissions.deny, GHX_DENY_RULES);
  assert.ok(!(r2.json.warnings ?? []).some((w: { code: string }) => w.code === 'INSTALL_DENY_REMOVED'));
});

test('project scope: .claude/settings.local.json and CLAUDE.md at the git toplevel; warns unless git ignores it', async () => {
  const repo = join(tmp, `repo-${n++}`);
  mkdirSync(join(repo, 'sub'), { recursive: true });
  writeFileSync(join(repo, 'CLAUDE.md'), '# Repo\n');
  const local = join(repo, '.claude', 'settings.local.json');
  const h = home();
  const r = await run(['install', '--scope', 'project'], { HOME: h.home }, { git: fakeGit({ toplevel: repo }) });
  assert.equal(r.exitCode, 0, r.stdout);
  assert.equal(r.json.scope, 'project');
  assert.deepEqual(r.json.changed, [local, join(repo, 'CLAUDE.md')]);
  assert.deepEqual(json(local).permissions.deny, GHX_DENY_RULES);
  assert.ok(!existsSync(join(repo, '.claude', 'settings.json')), 'the shared settings.json is never written');
  assert.ok(read(join(repo, 'CLAUDE.md')).startsWith(`# Repo\n\n${BEGIN}`));
  assert.ok(r.json.warnings.some((w: { code: string }) => w.code === 'SETTINGS_LOCAL_NOT_IGNORED'));
  assert.ok(!existsSync(h.settings), 'user scope untouched');

  const ignored = fakeGit({ toplevel: repo, ignored: [local] });
  const again = await run(['install', '--scope', 'project'], { HOME: h.home }, { git: ignored });
  assert.deepEqual(again.json.changed, []);
  assert.ok(!(again.json.warnings ?? []).some((w: { code: string }) => w.code === 'SETTINGS_LOCAL_NOT_IGNORED'));

  const un = await run(['uninstall', '--scope', 'project'], { HOME: h.home }, { git: ignored });
  assert.equal(un.exitCode, 0, un.stdout);
  assert.ok(!existsSync(local), 'uninstall removes the settings.local.json it emptied');
  assert.equal(read(join(repo, 'CLAUDE.md')), '# Repo\n');

  const outside = await run(['install', '--scope', 'project'], { HOME: h.home }, { git: fakeGit({}) });
  assert.equal(outside.json.error.code, 'REPO_NOT_FOUND');
});

test('project-scope backups go to the user config dir, never into the git tree, and are reported', async () => {
  const repo = join(tmp, `repo-${n++}`);
  const local = join(repo, '.claude', 'settings.local.json');
  mkdirSync(join(repo, '.claude'), { recursive: true });
  writeFileSync(local, '{\n  "model": "opus"\n}\n');
  writeFileSync(join(repo, 'CLAUDE.md'), '# Repo\n');
  const h = home();
  const git = fakeGit({ toplevel: repo, ignored: [local] });
  const r = await run(['install', '--scope', 'project'], { HOME: h.home }, { git });
  assert.equal(r.exitCode, 0, r.stdout);
  assert.deepEqual(backups(repo), [], 'nothing backed up inside the repository');
  const paths = r.json.files.map((f: { backup: string }) => f.backup);
  for (const p of paths) {
    assert.ok(p.startsWith(join(h.dir, 'ghx-install', 'project-')), p);
    assert.match(p, /\/backups\/(settings\.local\.json|CLAUDE\.md)\.bak-ghx-\d{8}T\d{6}Z$/);
  }
  assert.equal(read(paths[0]), '{\n  "model": "opus"\n}\n');
  assert.equal(read(paths[1]), '# Repo\n');
  const u = await run(['uninstall', '--scope', 'project'], { HOME: h.home }, { git });
  assert.equal(u.exitCode, 0, u.stdout);
  assert.deepEqual(backups(repo), []);
  assert.equal(read(local), '{\n  "model": "opus"\n}\n');
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

test('the hook command it writes runs without PATH, denies a raw gh write in a configured repo, and is silent elsewhere', async () => {
  const h = home();
  const r = await run(['install', '--no-snippet'], { HOME: h.home });
  const command = json(h.settings).hooks.PreToolUse[0].hooks[0].command;
  assert.equal(command, r.json.hookCommand);
  const repo = join(tmp, `repo-${n++}`);
  mkdirSync(join(repo, '.git'), { recursive: true });
  // -R o/r names this checkout's own remote, so the hook judges it as this repo (src/hook/foreign.ts).
  writeFileSync(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:o/r.git\n');
  const send = (cwd: string) =>
    spawnSync('/bin/sh', ['-c', command], {
      input: JSON.stringify({ cwd, tool_name: 'Bash', tool_input: { command: 'gh -R o/r pr merge 12' } }),
      env: { PATH: '/nonexistent' },
      encoding: 'utf8',
    });
  const quiet = send(repo);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout, '', 'no .github/ghx.json: no enforcement');
  mkdirSync(join(repo, '.github'));
  writeFileSync(join(repo, '.github', 'ghx.json'), '{}\n');
  const out = send(repo);
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
  assert.equal((await run(['install', '--hook-mode', 'ask', '--bin-dir', bin], env)).exitCode, 0);
  assert.notEqual(read(h.settings), EXISTING);
  const r = await run(['uninstall', '--bin-dir', bin], env);
  assert.equal(r.exitCode, 0, r.stdout);
  assert.equal(read(h.settings), EXISTING, 'EXISTING had "PreToolUse": [] and keeps it');
  assert.equal(read(h.claudeMd), md);
  assert.ok(!existsSync(join(bin, 'ghx')));
  assert.equal(r.json.binLink.action, 'removed');
  assert.deepEqual(r.json.denyRules, []);
  assert.match(r.json.hookCommand, /hook claude-pretooluse$/);
  assert.ok(r.json.files.every((f: { action: string; backup: string | null }) => f.action === 'updated' && f.backup));
  // Idempotent: a second uninstall changes nothing and makes no new backups.
  const count = backups(h.dir).length;
  const again = await run(['uninstall', '--bin-dir', bin], env);
  assert.deepEqual(again.json.changed, []);
  assert.equal(again.json.binLink.action, 'absent');
  assert.equal(backups(h.dir).length, count);
});

test('the install record keeps the bin link: uninstall removes it without --bin-dir, and a re-install keeps it', async () => {
  const h = home();
  const bin = join(tmp, `bin-${n++}`);
  mkdirSync(bin);
  const env = { HOME: h.home };
  assert.equal((await run(['install', '--bin-dir', bin], env)).exitCode, 0);
  const state = join(h.dir, 'ghx-install');
  const [dir] = readdirSync(state);
  const manifest = () => json(join(state, dir as string, 'manifest.json'));
  assert.deepEqual(manifest().binLink, { path: join(bin, 'ghx'), target: GHX_BIN });
  // A re-install without --bin-dir keeps the record (and changes nothing).
  const again = await run(['install'], env);
  assert.deepEqual(again.json.changed, []);
  assert.deepEqual(manifest().binLink, { path: join(bin, 'ghx'), target: GHX_BIN });
  const r = await run(['uninstall'], env);
  assert.equal(r.exitCode, 0, r.stdout);
  assert.equal(r.json.binLink.action, 'removed');
  assert.ok(r.json.changed.includes(join(bin, 'ghx')));
  assert.ok(!existsSync(join(bin, 'ghx')));
  assert.ok(!existsSync(join(state, dir as string, 'manifest.json')));
});

test('a --bin-dir-only re-install records the link, and uninstall leaves a link it did not make', async () => {
  const h = home();
  const bin = join(tmp, `bin-${n++}`);
  mkdirSync(bin);
  const env = { HOME: h.home };
  assert.equal((await run(['install'], env)).exitCode, 0);
  const r = await run(['install', '--bin-dir', bin], env);
  assert.deepEqual(r.json.changed, [join(bin, 'ghx')]);
  const [dir] = readdirSync(join(h.dir, 'ghx-install'));
  assert.equal(json(join(h.dir, 'ghx-install', dir as string, 'manifest.json')).binLink.path, join(bin, 'ghx'));
  // Someone replaces the link with their own file: uninstall leaves it and says so.
  rmSync(join(bin, 'ghx'));
  writeFileSync(join(bin, 'ghx'), 'mine');
  const u = await run(['uninstall'], env);
  assert.equal(u.json.binLink.action, 'unchanged');
  assert.ok(u.json.warnings.some((w: { code: string }) => w.code === 'INSTALL_BIN_FOREIGN'));
  assert.equal(read(join(bin, 'ghx')), 'mine');
});

test('doctor warns when the hook runs another ghx version or another node than the running ghx', async () => {
  const h = home();
  await run(['install', '--no-snippet'], { HOME: h.home });
  const fresh = await run(['doctor'], { HOME: h.home });
  const u = fresh.json.install.user.hook;
  assert.equal(u.node, process.execPath);
  assert.equal(u.version, VERSION);
  assert.ok(!fresh.json.warnings?.some((w: { code: string }) => w.code.endsWith('_MISMATCH')), fresh.stdout);

  // An older global install: its package.json says another version.
  const old = join(tmp, `old-ghx-${n++}`);
  mkdirSync(join(old, 'bin'), { recursive: true });
  writeFileSync(join(old, 'bin', 'ghx.js'), '');
  writeFileSync(join(old, 'package.json'), '{"name":"@thegoldenmule/ghx","version":"0.0.1"}\n');
  const otherNode = join(old, 'node');
  writeFileSync(otherNode, '');
  const set = (command: string) => {
    const s = json(h.settings);
    s.hooks.PreToolUse[0].hooks[0].command = command;
    writeFileSync(h.settings, JSON.stringify(s));
  };
  const codes = async () =>
    ((await run(['doctor'], { HOME: h.home })).json.warnings ?? []).map((w: { code: string }) => w.code);
  set(`'${process.execPath}' '${join(old, 'bin', 'ghx.js')}' hook claude-pretooluse`);
  assert.deepEqual(await codes(), ['INSTALL_HOOK_VERSION_MISMATCH']);
  set(`'${otherNode}' '${GHX_BIN}' hook claude-pretooluse`);
  assert.deepEqual(await codes(), ['INSTALL_HOOK_NODE_MISMATCH']);
  const r = await run(['doctor'], { HOME: h.home });
  assert.match(r.json.warnings[0].message, /Re-run ghx install/);
});

/** The shape of a real user settings file (fake values): permissions without deny, an empty PreToolUse, env, statusLine. */
const REAL_SHAPE = {
  env: { FAKE_FLAG: '1', OTHER: 'x' },
  permissions: { allow: ['Bash(ls:*)', 'Read(/tmp/**)'], defaultMode: 'auto' },
  model: 'fake-model',
  hooks: {
    PreToolUse: [],
    PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: '/fake/post.sh' }] }],
    Stop: [{ hooks: [{ type: 'command', command: '/fake/stop.sh' }] }],
  },
  statusLine: { type: 'command', command: '/fake/status.sh' },
};

test('install then uninstall restores a real-shaped settings file byte for byte, at both scopes, whatever its formatting', async () => {
  const standard = `${JSON.stringify(REAL_SHAPE, null, 2)}\n`;
  // Hand formatting JSON.stringify can't reproduce: inline arrays and objects.
  const inline = `{
  "env": { "FAKE_FLAG": "1", "OTHER": "x" },
  "permissions": { "allow": ["Bash(ls:*)", "Read(/tmp/**)"], "defaultMode": "auto" },
  "model": "fake-model",
  "hooks": {
    "PreToolUse": [],
    "PostToolUse": [{ "matcher": "Edit", "hooks": [{ "type": "command", "command": "/fake/post.sh" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "/fake/stop.sh" }] }]
  },
  "statusLine": { "type": "command", "command": "/fake/status.sh" }
}
`;
  assert.deepEqual(JSON.parse(inline), REAL_SHAPE);
  for (const original of [standard, inline]) {
    // User scope (hook and mode, no deny rules).
    const h = home({ 'settings.json': original, 'CLAUDE.md': '# Mine\n' });
    assert.equal((await run(['install', '--hook-mode', 'ask'], { HOME: h.home })).exitCode, 0);
    assert.notEqual(read(h.settings), original);
    assert.equal((await run(['uninstall'], { HOME: h.home })).exitCode, 0);
    assert.equal(read(h.settings), original, 'user scope');
    assert.equal(read(h.claudeMd), '# Mine\n');
    // Project scope (deny rules too, so permissions.deny is created and must go again).
    const repo = join(tmp, `repo-${n++}`);
    const local = join(repo, '.claude', 'settings.local.json');
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(local, original);
    const git = fakeGit({ toplevel: repo, ignored: [local] });
    assert.equal((await run(['install', '--scope', 'project', '--no-snippet'], { HOME: h.home }, { git })).exitCode, 0);
    assert.ok(json(local).permissions.deny);
    // A second install with nothing new, then uninstall: still the original bytes.
    assert.equal((await run(['install', '--scope', 'project', '--no-snippet'], { HOME: h.home }, { git })).exitCode, 0);
    assert.equal((await run(['uninstall', '--scope', 'project'], { HOME: h.home }, { git })).exitCode, 0);
    assert.equal(read(local), original, 'project scope');
  }
});

test('after a hand edit, uninstall falls back to removing what ghx added and keeps the edit', async () => {
  const h = home({ 'settings.json': `${JSON.stringify(REAL_SHAPE, null, 2)}\n` });
  await run(['install', '--no-snippet'], { HOME: h.home });
  const s = json(h.settings);
  s.model = 'edited';
  writeFileSync(h.settings, `${JSON.stringify(s, null, 2)}\n`);
  assert.equal((await run(['uninstall'], { HOME: h.home })).exitCode, 0);
  assert.deepEqual(json(h.settings), { ...REAL_SHAPE, model: 'edited' });
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

test("uninstall removes only what install added: the user's identical deny rule and GHX_HOOK_MODE survive", async () => {
  const repo = join(tmp, `repo-${n++}`);
  const local = join(repo, '.claude', 'settings.local.json');
  mkdirSync(join(repo, '.claude'), { recursive: true });
  const mine = `${JSON.stringify({ permissions: { deny: ['Bash(gh pr merge:*)'] }, env: { GHX_HOOK_MODE: 'ask' } }, null, 2)}\n`;
  writeFileSync(local, mine);
  const h = home();
  const git = fakeGit({ toplevel: repo, ignored: [local] });
  const i = await run(
    ['install', '--scope', 'project', '--hook-mode', 'ask', '--no-snippet'],
    { HOME: h.home },
    { git },
  );
  assert.equal(i.exitCode, 0, i.stdout);
  assert.deepEqual(json(local).permissions.deny, [
    'Bash(gh pr merge:*)',
    ...GHX_DENY_RULES.filter((r) => r !== 'Bash(gh pr merge:*)'),
  ]);
  // The record lives in the user config dir, not in the repository.
  const state = join(h.dir, 'ghx-install');
  const [dir] = readdirSync(state);
  const manifest = JSON.parse(read(join(state, dir as string, 'manifest.json')));
  assert.equal(manifest.settings.path, local);
  assert.ok(!manifest.settings.deny.includes('Bash(gh pr merge:*)'));
  assert.equal(manifest.settings.hookMode, null, 'GHX_HOOK_MODE was already ask: not ghx');
  assert.deepEqual(
    readdirSync(join(repo, '.claude')).filter((f) => !f.includes('.bak-ghx-')),
    ['settings.local.json'],
  );
  const u = await run(['uninstall', '--scope', 'project'], { HOME: h.home }, { git });
  assert.equal(u.exitCode, 0, u.stdout);
  assert.deepEqual(json(local), JSON.parse(mine));
  assert.ok(!existsSync(join(state, dir as string, 'manifest.json')), 'uninstall drops the record');
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

// ── lows: symlinks, --no-snippet, BOM/CRLF ─────────────────────────────────────

test('a dangling settings symlink is refused, not replaced with a regular file', async () => {
  const h = home();
  symlinkSync(join(h.home, 'dotfiles', 'settings.json'), h.settings);
  const r = await run(['install'], { HOME: h.home });
  assert.equal(r.exitCode, EXIT.ENV, r.stdout);
  assert.equal(r.json.error.code, 'INSTALL_NOT_WRITABLE');
  assert.equal(r.json.error.details.code, 'DANGLING_SYMLINK');
  assert.ok(lstatSync(h.settings).isSymbolicLink(), 'still a link');
  assert.ok(!existsSync(join(h.home, 'dotfiles')) && !existsSync(h.claudeMd), 'nothing written');
  // A live link is written through, and stays a link.
  mkdirSync(join(h.home, 'dotfiles'));
  writeFileSync(join(h.home, 'dotfiles', 'settings.json'), '{}\n');
  assert.equal((await run(['install', '--no-snippet'], { HOME: h.home })).exitCode, 0);
  assert.ok(lstatSync(h.settings).isSymbolicLink());
  assert.ok(json(join(h.home, 'dotfiles', 'settings.json')).hooks);
});

test('uninstall --no-snippet leaves the CLAUDE.md block, and a later uninstall still removes it', async () => {
  const h = home({ 'CLAUDE.md': '# Mine\n' });
  await run(['install'], { HOME: h.home });
  const r = await run(['uninstall', '--no-snippet'], { HOME: h.home });
  assert.equal(r.exitCode, 0, r.stdout);
  assert.deepEqual(r.json.changed, [h.settings]);
  assert.ok(!existsSync(h.settings));
  assert.ok(read(h.claudeMd).includes(BEGIN));
  const again = await run(['uninstall'], { HOME: h.home });
  assert.deepEqual(again.json.changed, [h.claudeMd]);
  assert.equal(read(h.claudeMd), '# Mine\n');
});

test('a BOM and CRLF line endings are kept; formatting ghx cannot keep warns INSTALL_REFORMATTED', async () => {
  const crlf = (t: string) => `\uFEFF${t.replaceAll('\n', '\r\n')}`;
  const settings = crlf('{\n  "model": "opus"\n}\n');
  const md = crlf('# Mine\n');
  const h = home({ 'settings.json': settings, 'CLAUDE.md': md });
  const r = await run(['install'], { HOME: h.home });
  assert.equal(r.exitCode, 0, r.stdout);
  for (const p of [h.settings, h.claudeMd]) {
    const t = read(p);
    assert.ok(t.startsWith('\uFEFF'), `${p} keeps its BOM`);
    assert.ok(!/[^\r]\n/.test(t), `${p} is all CRLF`);
  }
  assert.ok(!(r.json.warnings ?? []).some((w: { code: string }) => w.code === 'INSTALL_REFORMATTED'));
  assert.equal((await run(['uninstall'], { HOME: h.home })).exitCode, 0);
  assert.equal(read(h.settings), settings);
  assert.equal(read(h.claudeMd), md);
  const inline = home({ 'settings.json': '{ "model": "opus", "permissions": { "allow": ["Read"] } }\n' });
  const w = await run(['install', '--no-snippet'], { HOME: inline.home });
  assert.equal(w.exitCode, 0, w.stdout);
  assert.ok(
    w.json.warnings.some(
      (x: { code: string; message: string }) => x.code === 'INSTALL_REFORMATTED' && x.message.includes(inline.settings),
    ),
  );
});

// ── ghx doctor's install check ─────────────────────────────────────────────────

test('doctor expects deny rules only at project scope, and warns about ones an earlier user install left', async () => {
  const repo = join(tmp, `repo-${n++}`);
  mkdirSync(repo);
  const git = fakeGit({ toplevel: repo });
  const warned = (r: { json: { warnings?: { code: string }[] } }) =>
    (r.json.warnings ?? []).some((w) => w.code === 'INSTALL_DENY_LEGACY');

  // A user-scope install adds no deny rules, so none are missing.
  const h = home();
  await run(['install'], { HOME: h.home });
  const fresh = await run(['doctor'], { HOME: h.home }, { git });
  assert.deepEqual(fresh.json.install.user.deny, { expected: false, present: [], ghxAdded: [] });
  assert.ok(!warned(fresh));

  // A pre-manifest ghx install that added deny rules at user scope: those, not the user's own, are flagged.
  const mine = { permissions: { deny: ['Bash(gh pr merge:*)', 'Bash(rm:*)'] } };
  const old = {
    permissions: { deny: [...mine.permissions.deny, ...GHX_DENY_RULES.filter((r) => r !== 'Bash(gh pr merge:*)')] },
    hooks: {
      PreToolUse: [
        { matcher: 'Bash|Monitor', hooks: [{ type: 'command', command: "'/n' '/g' hook claude-pretooluse" }] },
      ],
    },
  };
  const legacy = home({
    'settings.json': `${JSON.stringify(old, null, 2)}\n`,
    'settings.json.bak-ghx-20261001T000000Z': `${JSON.stringify(mine, null, 2)}\n`,
  });
  const l = await run(['doctor'], { HOME: legacy.home }, { git });
  const ld = l.json.install.user.deny;
  assert.equal(ld.expected, false);
  assert.ok(!('missing' in ld));
  assert.deepEqual(ld.present, GHX_DENY_RULES);
  assert.deepEqual(
    ld.ghxAdded,
    GHX_DENY_RULES.filter((r) => r !== 'Bash(gh pr merge:*)'),
  );
  assert.ok(warned(l), JSON.stringify(l.json.warnings));

  // Hand-written ghx-identical rules with no ghx install behind them are the user's: no warning.
  const hand = home({ 'settings.json': JSON.stringify({ permissions: { deny: [...GHX_DENY_RULES] } }) });
  const hd = await run(['doctor'], { HOME: hand.home }, { git });
  assert.deepEqual(hd.json.install.user.deny.ghxAdded, []);
  assert.ok(!warned(hd));

  // Project scope still expects them and reports any missing.
  const before = await run(['doctor'], { HOME: h.home }, { git });
  assert.deepEqual(before.json.install.project.deny, { expected: true, present: [], missing: GHX_DENY_RULES });
  await run(['install', '--scope', 'project'], { HOME: h.home }, { git });
  const p = await run(['doctor'], { HOME: h.home }, { git });
  assert.deepEqual(p.json.install.project.deny, { expected: true, present: GHX_DENY_RULES, missing: [] });
  assert.ok(!warned(p));
});

test('doctor reports the install per scope, informationally, and flags a hook whose paths are gone', async () => {
  const h = home();
  const repo = join(tmp, `repo-${n++}`);
  mkdirSync(repo);
  const git = fakeGit({ toplevel: repo });
  const before = await run(['doctor'], { HOME: h.home }, { git });
  assert.notEqual(before.exitCode, 1, before.stdout);
  assert.deepEqual(before.json.install.user.hook, {
    installed: false,
    command: null,
    missingPaths: [],
    node: null,
    version: null,
  });
  assert.equal(before.json.install.user.status, 'missing');
  assert.equal(before.json.install.project.settings, join(repo, '.claude', 'settings.local.json'));
  assert.equal(before.json.install.project.shared.settings, join(repo, '.claude', 'settings.json'));
  assert.equal(before.json.install.project.shared.status, 'missing');
  assert.ok(!before.json.checks.some((c: { name: string }) => c.name.includes('install')), 'not a failing check');

  await run(['install'], { HOME: h.home });
  const after = await run(['doctor'], { HOME: h.home }, { git });
  assert.equal(after.exitCode, before.exitCode, 'the install never changes doctor’s exit code');
  const u = after.json.install.user;
  assert.equal(u.status, 'ok');
  assert.equal(u.hook.installed, true);
  assert.deepEqual(u.hook.missingPaths, []);
  assert.deepEqual(u.deny, { expected: false, present: [], ghxAdded: [] }, 'user scope has no deny rules');
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
  assert.ok(!stale.json.warnings.some((w: { code: string }) => w.code.endsWith('_MISMATCH')), 'stale covers it');

  // A hand install in the repo's shared .claude/settings.json is read too, with its own remedy.
  mkdirSync(join(repo, '.claude'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify(s));
  const hand = await run(['doctor'], { HOME: h.home }, { git });
  const shared = hand.json.install.project.shared;
  assert.equal(shared.status, 'ok');
  assert.equal(shared.hook.installed, true);
  assert.deepEqual(shared.hook.missingPaths, ['/gone/node']);
  assert.deepEqual(shared.deny.present, []);
  assert.equal(hand.json.install.project.hook.installed, false, 'settings.local.json is reported separately');
  assert.ok(
    hand.json.warnings.some(
      (w: { code: string; message: string }) =>
        w.code === 'INSTALL_HOOK_STALE' && w.message.includes(join(repo, '.claude', 'settings.json')),
    ),
  );

  // Broken settings and stray markers are warnings, still not failures.
  writeFileSync(h.settings, '{ "model": ');
  writeFileSync(h.claudeMd, `${BEGIN}\nno end marker\n`);
  const broken = await run(['doctor'], { HOME: h.home }, { git });
  assert.equal(broken.exitCode, before.exitCode);
  assert.equal(broken.json.install.user.status, 'invalid');
  assert.match(broken.json.install.user.problem, /not valid JSON/);
  assert.match(broken.json.install.user.claudeMd.problem, /ghx:begin/);
  const codes = broken.json.warnings.map((w: { code: string }) => w.code);
  assert.ok(codes.includes('INSTALL_SETTINGS_INVALID') && codes.includes('INSTALL_CLAUDE_MD_INVALID'), codes.join());

  const none = await run(['doctor'], {});
  assert.deepEqual(none.json.install, { user: null, project: null });
});
