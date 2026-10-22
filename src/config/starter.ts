// Starter config for `ghx init` (01 §5): components from --component flags, else from the workspace
// (package.json#workspaces, pnpm-workspace.yaml `packages:`), else from top-level directories.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
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

export async function buildStarter(toplevel: string, flagComponents: readonly string[] = []): Promise<Starter> {
  let components: Record<string, { paths?: string[] }>;
  let inferredFrom: InferredFrom;
  if (flagComponents.length > 0) {
    components = Object.fromEntries(flagComponents.map((c) => [c, {}]));
    inferredFrom = 'flags';
  } else {
    const ws = await expandWorkspaces(toplevel, workspacePatterns(toplevel));
    if (ws.length > 0) {
      components = componentsFromDirs(ws);
      inferredFrom = 'workspaces';
    } else {
      const dirs = topLevelDirs(toplevel);
      components = dirs.length > 0 ? componentsFromDirs(dirs) : { root: { paths: ['**'] } };
      inferredFrom = 'directories';
    }
  }
  const config: GhxConfigInput = { version: CONFIG_VERSION, components };
  // Valid by construction: a starter that does not parse is a bug, surfaced here rather than on next use.
  ConfigSchema.parse(config);
  return { config, inferredFrom };
}
