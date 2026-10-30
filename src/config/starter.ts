// Starter config for `ghx init` (01 §5): components from --component flags, else from the workspace
// (package.json#workspaces, pnpm-workspace.yaml `packages:`), else from top-level directories, plus the
// merge method and an empty ci section to fill in. With git history, components take the names the
// commit log already uses as scopes (namesFromHistory); without it, the basename rules stand.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import type { GitCommit } from '../git/index.ts';
import { matchesGlob } from '../util/glob.ts';
import { CONFIG_VERSION, ConfigSchema, type GhxConfigInput } from './schema.ts';

export type InferredFrom = 'flags' | 'workspaces' | 'directories';

export interface Starter {
  config: GhxConfigInput;
  inferredFrom: InferredFrom;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'out', 'target', 'vendor', 'tmp']);

/** A ComponentName token from a directory or package name. */
export function componentToken(s: string): string {
  const t = s
    .toLowerCase()
    .replace(/^@[^/]+\//, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '');
  return t || 'root';
}

/** `packages:` entries of pnpm-workspace.yaml, line-parsed (no YAML dependency). */
export function parsePnpmWorkspace(text: string): string[] {
  const out: string[] = [];
  let inPackages = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (/^\S/.test(line)) break;
    const m = /^\s*-\s*(['"]?)(.+?)\1\s*$/.exec(line);
    if (m?.[2]) out.push(m[2]);
  }
  return out;
}

export function workspacePatterns(toplevel: string): string[] {
  const patterns: string[] = [];
  const pkgPath = join(toplevel, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { workspaces?: string[] | { packages?: string[] } };
      const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? []);
      patterns.push(...ws.filter((w) => typeof w === 'string'));
    } catch {
      // an unparsable package.json contributes nothing
    }
  }
  const pnpm = join(toplevel, 'pnpm-workspace.yaml');
  if (existsSync(pnpm)) patterns.push(...parsePnpmWorkspace(readFileSync(pnpm, 'utf8')));
  return patterns;
}

async function expandWorkspaces(toplevel: string, patterns: readonly string[]): Promise<string[]> {
  const include = patterns.filter((p) => !p.startsWith('!'));
  const exclude = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  const dirs = new Set<string>();
  for (const pattern of include) {
    for await (const m of glob(pattern.replace(/\/+$/, ''), {
      cwd: toplevel,
      exclude: (f) => SKIP_DIRS.has(basename(String(f))),
    })) {
      const rel = String(m).split(sep).join('/');
      const abs = join(toplevel, rel);
      if (!statSync(abs, { throwIfNoEntry: false })?.isDirectory()) continue;
      if (!existsSync(join(abs, 'package.json'))) continue;
      if (exclude.some((x) => matchesGlob(rel, x))) continue;
      dirs.add(rel);
    }
  }
  return [...dirs].sort();
}

function topLevelDirs(toplevel: string): string[] {
  return readdirSync(toplevel, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
    .map((e) => e.name)
    .sort();
}

type StarterComponent = { paths: string[]; aliases?: string[] };

/** The scope tokens of a `type(scope):` or `type(a,b)!:` subject. */
function subjectScopes(subject: string): string[] {
  const m = /^[a-z]+\(([^()]+)\)!?:/i.exec(subject);
  if (!m?.[1]) return [];
  return m[1]
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => /^[a-z0-9][a-z0-9-]*$/.test(t));
}

/** How many commits use each scope token. */
export function scopeCounts(commits: readonly GitCommit[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of commits) for (const t of subjectScopes(c.subject)) out.set(t, (out.get(t) ?? 0) + 1);
  return out;
}

/** How many commits change a file under each dir. */
function dirUsage(commits: readonly GitCommit[], dirs: readonly string[]): Map<string, number> {
  const out = new Map<string, number>(dirs.map((d) => [d, 0]));
  for (const c of commits) {
    for (const d of dirs) if (c.files.some((f) => f.startsWith(`${d}/`))) out.set(d, (out.get(d) ?? 0) + 1);
  }
  return out;
}

/** The names a dir may go by: its basename and its package.json name, as tokens. */
function candidates(toplevel: string, dir: string): string[] {
  const out = [componentToken(basename(dir))];
  const pkg = join(toplevel, dir, 'package.json');
  if (existsSync(pkg)) {
    try {
      const name = (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: unknown }).name;
      if (typeof name === 'string' && name !== '') out.push(componentToken(name));
    } catch {
      // an unparsable package.json names nothing
    }
  }
  return [...new Set(out)];
}

/**
 * Components named the way the commit log names them. Each dir takes the candidate (basename or package
 * name) used most as a scope, else its basename. Dirs that end up with the same name share it by use:
 * the dir most commits change gets the bare name, the rest are path-prefixed (a tie prefixes all). A
 * package nested in another workspace package is part of it unless the log scopes it on its own. Other
 * candidates the log uses become aliases. Deterministic: ties fall back to path order.
 */
export function namesFromHistory(
  toplevel: string,
  dirs: readonly string[],
  commits: readonly GitCommit[],
): Record<string, StarterComponent> {
  const scopes = scopeCounts(commits);
  const used = (t: string) => scopes.get(t) ?? 0;
  const cands = new Map(dirs.map((d) => [d, candidates(toplevel, d)]));
  const kept = dirs.filter((d) => {
    const parent = dirs.some((p) => p !== d && d.startsWith(`${p}/`));
    return !parent || (cands.get(d) ?? []).some((t) => used(t) > 0);
  });
  // Scope uses credited to a dir: commits with that scope that change a file under it.
  const credit = new Map<string, number>();
  for (const c of commits) {
    const ts = subjectScopes(c.subject);
    for (const d of kept) {
      if (!c.files.some((f) => f.startsWith(`${d}/`))) continue;
      for (const t of ts) credit.set(`${d}\0${t}`, (credit.get(`${d}\0${t}`) ?? 0) + 1);
    }
  }
  const owners = (t: string) => kept.filter((d) => (cands.get(d) ?? []).includes(t)).length;
  const chosen = new Map<string, string>();
  for (const d of kept) {
    const cs = cands.get(d) ?? [];
    // Most used on this dir's own commits, then anywhere, then a name no other dir could take.
    const score = (t: string): [number, number, number] => [
      credit.get(`${d}\0${t}`) ?? 0,
      used(t),
      owners(t) === 1 ? 1 : 0,
    ];
    const best = [...cs].sort((a, b) => {
      const [x, y] = [score(a), score(b)];
      return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
    })[0];
    chosen.set(d, best !== undefined && used(best) > 0 ? best : (cs[0] ?? componentToken(basename(d))));
  }
  const usage = dirUsage(commits, kept);
  const byName = new Map<string, string[]>();
  for (const d of kept) {
    const n = chosen.get(d) ?? '';
    byName.set(n, [...(byName.get(n) ?? []), d]);
  }
  const named: [string, string][] = [];
  for (const [name, ds] of byName) {
    if (ds.length === 1) {
      named.push([ds[0] ?? '', name]);
      continue;
    }
    const top = Math.max(...ds.map((d) => usage.get(d) ?? 0));
    const winners = ds.filter((d) => (usage.get(d) ?? 0) === top);
    for (const d of ds) {
      named.push([
        d,
        winners.length === 1 && winners[0] === d && top > 0 ? name : componentToken(d.replaceAll('/', '-')),
      ]);
    }
  }
  named.sort((a, b) => a[0].localeCompare(b[0]));
  const names = new Set(named.map(([, n]) => n));
  const taken = new Set<string>();
  const out: Record<string, StarterComponent> = {};
  for (const [d, name] of named) {
    const aliases = (cands.get(d) ?? []).filter((t) => t !== name && used(t) > 0 && !names.has(t) && !taken.has(t));
    for (const a of aliases) taken.add(a);
    out[name] = { paths: [`${d}/**`], ...(aliases.length > 0 ? { aliases } : {}) };
  }
  return out;
}

function componentsFromDirs(dirs: readonly string[]): Record<string, { paths: string[] }> {
  const out: Record<string, { paths: string[] }> = {};
  const byToken = new Map<string, string[]>();
  for (const d of dirs) {
    const t = componentToken(basename(d));
    byToken.set(t, [...(byToken.get(t) ?? []), d]);
  }
  for (const [token, ds] of byToken) {
    for (const d of ds) {
      const name = ds.length === 1 ? token : componentToken(d.replaceAll('/', '-'));
      out[name] = { paths: [`${d}/**`] };
    }
  }
  return out;
}

/**
 * `history`: recent commits (git log), so components take the scopes the log already uses; empty or
 * absent keeps the basename rules.
 */
export async function buildStarter(
  toplevel: string,
  flagComponents: readonly string[] = [],
  history: readonly GitCommit[] = [],
): Promise<Starter> {
  let components: Record<string, { paths?: string[]; aliases?: string[] }>;
  const fromDirs = (dirs: readonly string[]) =>
    history.length > 0 ? namesFromHistory(toplevel, dirs, history) : componentsFromDirs(dirs);
  let inferredFrom: InferredFrom;
  if (flagComponents.length > 0) {
    components = Object.fromEntries(flagComponents.map((c) => [c, {}]));
    inferredFrom = 'flags';
  } else {
    const ws = await expandWorkspaces(toplevel, workspacePatterns(toplevel));
    if (ws.length > 0) {
      components = fromDirs(ws);
      inferredFrom = 'workspaces';
    } else {
      const dirs = topLevelDirs(toplevel);
      components = dirs.length > 0 ? fromDirs(dirs) : { root: { paths: ['**'] } };
      inferredFrom = 'directories';
    }
  }
  // merge and ci spell out the keys an adopter edits first (strict JSON has no comments): merge commits
  // (the default, 02 §4.3) and empty CI lists, which cost nothing until filled.
  const config: GhxConfigInput = {
    version: CONFIG_VERSION,
    components,
    merge: { method: 'merge' },
    ci: { expected: [], keySteps: [], ignore: [] },
  };
  // Valid by construction: a starter that does not parse is a bug, surfaced here rather than on next use.
  ConfigSchema.parse(config);
  return { config, inferredFrom };
}
