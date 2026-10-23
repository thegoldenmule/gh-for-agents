// Where `ghx install` writes and how: target resolution (user or project scope), the absolute hook
// command, the optional bin link, and backed-up atomic writes. Nothing here reads os.homedir() or
// process.env: HOME and CLAUDE_CONFIG_DIR come from the command's env, so tests point them at temp dirs.
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Clock } from '../core/clock.ts';
import { GhxError } from '../core/errors.ts';
import type { Git } from '../git/index.ts';
import { unifiedDiff } from './diff.ts';

type Env = Readonly<Record<string, string | undefined>>;

/** This checkout: the hook runs bin/ghx.js from here, and the snippet is read from here. */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
export const GHX_BIN = join(REPO_ROOT, 'bin', 'ghx.js');
export const SNIPPET_PATH = join(REPO_ROOT, 'docs', 'agents', 'claude-md-snippet.md');

export type Scope = 'user' | 'project';

export interface Targets {
  scope: Scope;
  settings: string;
  claudeMd: string;
}

export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Absolute node and bin/ghx.js, so the hook runs whatever PATH Claude Code gives hooks. */
export function hookCommand(node: string = process.execPath, bin: string = GHX_BIN): string {
  return `${shellQuote(node)} ${shellQuote(bin)} hook claude-pretooluse`;
}

/** The user-scope Claude config dir: $CLAUDE_CONFIG_DIR, else $HOME/.claude. Null when neither is set. */
export function userConfigDir(env: Env): string | null {
  if (env.CLAUDE_CONFIG_DIR) return resolve(env.CLAUDE_CONFIG_DIR);
  if (env.HOME) return join(env.HOME, '.claude');
  return null;
}

export async function resolveTargets(scope: Scope, env: Env, git: Git): Promise<Targets> {
  if (scope === 'user') {
    const dir = userConfigDir(env);
    if (!dir) {
      throw new GhxError('INSTALL_HOME_UNKNOWN', 'Neither CLAUDE_CONFIG_DIR nor HOME is set.', {
        hint: 'Set HOME (or CLAUDE_CONFIG_DIR to your Claude Code config directory), or use --scope project.',
      });
    }
    return { scope, settings: join(dir, 'settings.json'), claudeMd: join(dir, 'CLAUDE.md') };
  }
  if (!(await git.available())) {
    throw new GhxError('ENV_GIT_MISSING', '--scope project needs git to find the repository root.');
  }
  const top = await git.toplevel();
  if (!top) {
    throw new GhxError('REPO_NOT_FOUND', '--scope project must run inside a git checkout.', {
      hint: 'cd into the repository first, or use --scope user.',
    });
  }
  return { scope, settings: join(top, '.claude', 'settings.json'), claudeMd: join(top, 'CLAUDE.md') };
}

export function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** One file's planned content. `after: null` deletes it. */
export interface FileChange {
  path: string;
  kind: 'settings' | 'claude-md';
  before: string | null;
  after: string | null;
}

export type FileAction = 'created' | 'updated' | 'unchanged' | 'removed';

export interface FileResult {
  path: string;
  kind: FileChange['kind'];
  action: FileAction;
  backup: string | null;
}

export function actionOf(c: FileChange): FileAction {
  if (c.before === c.after) return 'unchanged';
  if (c.before === null) return 'created';
  return c.after === null ? 'removed' : 'updated';
}

export function diffOf(c: FileChange): string {
  return unifiedDiff(c.path, c.before, c.after);
}

/** UTC compact timestamp for backup names: 20261023T141500Z. */
function stamp(clock: Clock): string {
  return new Date(clock.now())
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

function backupPath(path: string, ts: string): string {
  let p = `${path}.bak-ghx-${ts}`;
  for (let n = 1; existsSync(p); n++) p = `${path}.bak-ghx-${ts}-${n}`;
  return p;
}

/** Every backup ghx made of `path`, by name. */
export function backupsOf(path: string): string[] {
  const dir = dirname(path);
  const prefix = `${basename(path)}.bak-ghx-`;
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith(prefix))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/** Write via a temp file and rename. A symlinked file is written through to its target. */
function atomicWrite(path: string, content: string): void {
  const target = existsSync(path) ? realpathSync(path) : path;
  mkdirSync(dirname(target), { recursive: true });
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o644;
  const tmp = `${target}.ghx-tmp-${process.pid}`;
  try {
    writeFileSync(tmp, content, { mode });
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Apply the changes: back up each changed file that exists, then write or delete it. Callers plan and
 * validate every file before calling this, so a refusal never leaves a half-applied install.
 */
export function commitChanges(changes: readonly FileChange[], clock: Clock): FileResult[] {
  const ts = stamp(clock);
  return changes.map((c) => {
    const action = actionOf(c);
    if (action === 'unchanged') return { path: c.path, kind: c.kind, action, backup: null };
    let backup: string | null = null;
    if (c.before !== null) {
      backup = backupPath(c.path, ts);
      copyFileSync(c.path, backup);
    }
    if (c.after === null) {
      // A symlinked file is emptied rather than unlinked, so a dotfiles link survives.
      if (lstatSync(c.path).isSymbolicLink()) atomicWrite(c.path, '');
      else unlinkSync(c.path);
    } else {
      atomicWrite(c.path, c.after);
    }
    return { path: c.path, kind: c.kind, action, backup };
  });
}

export interface BinLink {
  path: string;
  target: string;
  action: 'created' | 'unchanged' | 'removed' | 'absent';
  onPath: boolean;
}

function onPath(dir: string, env: Env): boolean {
  const want = resolve(dir);
  return (env.PATH ?? '').split(delimiter).some((d) => d !== '' && resolve(d) === want);
}

/** Whether `link` is a symlink that resolves to bin/ghx.js. */
function pointsAtGhx(link: string): boolean {
  try {
    if (!lstatSync(link).isSymbolicLink()) return false;
    if (resolve(dirname(link), readlinkSync(link)) === GHX_BIN) return true;
    return realpathSync(link) === realpathSync(GHX_BIN);
  } catch {
    return false;
  }
}

export function planBinLink(dir: string, env: Env): BinLink {
  const abs = resolve(dir);
  const path = join(abs, 'ghx');
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new GhxError('VALIDATION', `--bin-dir ${abs} is not a directory.`, {
      hint: 'Create it first, or pass a directory that is on your PATH (e.g. ~/.local/bin).',
      details: { issues: [{ path: 'binDir', code: 'not_a_directory', message: `${abs} is not a directory` }] },
    });
  }
  const base = { path, target: GHX_BIN, onPath: onPath(abs, env) };
  if (pointsAtGhx(path)) return { ...base, action: 'unchanged' };
  let exists = false;
  try {
    lstatSync(path);
    exists = true;
  } catch {
    // absent: ghx creates it
  }
  if (exists) {
    throw new GhxError('INSTALL_BIN_CONFLICT', `${path} already exists and is not a link to ${GHX_BIN}.`, {
      hint: 'Remove or rename it yourself, or pass a different --bin-dir. ghx changed nothing.',
      details: { path },
    });
  }
  return { ...base, action: 'created' };
}

/** 'removed' only for a link into this checkout; anything else at the path is left alone ('unchanged'). */
export function planBinUnlink(dir: string, env: Env): BinLink {
  const abs = resolve(dir);
  const path = join(abs, 'ghx');
  const base = { path, target: GHX_BIN, onPath: onPath(abs, env) };
  if (pointsAtGhx(path)) return { ...base, action: 'removed' };
  try {
    lstatSync(path);
    return { ...base, action: 'unchanged' };
  } catch {
    return { ...base, action: 'absent' };
  }
}

export function commitBinLink(link: BinLink): void {
  if (link.action === 'created') symlinkSync(link.target, link.path);
  else if (link.action === 'removed') unlinkSync(link.path);
}
