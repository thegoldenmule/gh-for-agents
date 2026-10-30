// Which repo a raw gh invocation targets, for the hook's enforcement scope (04 "enforcement scope"). The
// hook enforces where the event's cwd has .github/ghx.json, but `gh pr view 1 -R nodejs/node` run from
// that checkout is about another repo, which never adopted ghx. An invocation that names a repo
// explicitly (-R/--repo, a github URL argument, or a literal `gh api repos/<o>/<r>/…` path) is judged by
// that repo: when it is not one of the checkout's own remotes it is foreign, and the hook lets it through
// (ghx cannot know a remote repo's config). Filesystem only: the remotes come from the checkout's git
// config file, never a git spawn. Any doubt (unreadable config, no remotes) makes a named repo foreign.
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { takeRepoFlag } from '../passthrough/policy.ts';
import { repoRoot } from './repo.ts';
import type { Invocation } from './shell.ts';

const read = (p: string): string | undefined => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
};

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** `owner/name`, lowercased, from a remote URL or a -R value (`o/r`, `host/o/r`, a URL); undefined if none. */
export function repoSlugOf(value: string): string | undefined {
  let v = value.trim();
  if (v === '') return undefined;
  // scp-like ssh: git@github.com:o/r.git
  const scp = /^[\w.-]+@[\w.-]+:(.+)$/.exec(v);
  if (scp && !v.includes('://')) v = scp[1] as string;
  else {
    const url = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i.exec(v);
    if (url) v = url[1] as string;
  }
  const segs = v
    .replace(/[?#].*$/, '')
    .split('/')
    .filter((s) => s !== '');
  if (segs.length < 2) return undefined;
  // A URL into a repo (…/o/r/pull/1) keeps its first two path segments; `host/o/r` its last two.
  const pair = /^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim()) || scp ? segs.slice(0, 2) : segs.slice(-2);
  const [owner, name] = pair as [string, string];
  const repo = name.replace(/\.git$/i, '');
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return undefined;
  return `${owner}/${repo}`.toLowerCase();
}

/** The git config file of the checkout at `root`: `.git/config`, or a worktree's common dir's config. */
function configPath(root: string): string | undefined {
  const dotGit = join(root, '.git');
  if (isDir(dotGit)) return join(dotGit, 'config');
  const m = /^gitdir:\s*(.+)$/m.exec(read(dotGit) ?? '');
  if (!m) return undefined;
  const raw = (m[1] as string).trim();
  const gitdir = isAbsolute(raw) ? raw : resolve(root, raw);
  const common = read(join(gitdir, 'commondir'))?.trim();
  return join(common ? (isAbsolute(common) ? common : resolve(gitdir, common)) : gitdir, 'config');
}

/** Remote URLs from a git config file's `[remote "x"]` sections. */
export function remoteUrls(config: string): string[] {
  const urls: string[] = [];
  let inRemote = false;
  for (const line of config.split('\n')) {
    const t = line.trim();
    if (t.startsWith('[')) {
      inRemote = /^\[remote\s+"[^"]*"\]$/.test(t);
      continue;
    }
    const m = inRemote ? /^url\s*=\s*(.+)$/.exec(t) : null;
    if (m) urls.push((m[1] as string).trim());
  }
  return urls;
}

/** The `owner/name` slugs of the checkout's remotes above `cwd` (lowercase); empty when unknown. */
export function localRepoSlugs(cwd: unknown): Set<string> {
  const out = new Set<string>();
  if (typeof cwd !== 'string' || cwd === '') return out;
  const root = repoRoot(cwd);
  const path = root === null ? undefined : configPath(root);
  const text = path === undefined ? undefined : read(path);
  for (const url of remoteUrls(text ?? '')) {
    const slug = repoSlugOf(url);
    if (slug) out.add(slug);
  }
  return out;
}

/** gh api flags whose value is the next word (so it is not the endpoint). */
const API_VALUE_FLAGS = new Set([
  '-X',
  '--method',
  '-H',
  '--header',
  '-f',
  '--raw-field',
  '-F',
  '--field',
  '--input',
  '-q',
  '--jq',
  '-t',
  '--template',
  '-p',
  '--preview',
  '--hostname',
  '--cache',
]);

/** The endpoint of a `gh api` argv (after `api`): its first positional. */
function apiEndpoint(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (!a.startsWith('-')) return a;
    if (!a.includes('=') && API_VALUE_FLAGS.has(a)) i++;
  }
  return undefined;
}

/** A placeholder path segment (`{owner}`, `:owner`, `<o>`) names the current repo, not another one. */
const PLACEHOLDER = /^[{:<]/;

/** The repo a gh invocation names explicitly (lowercase `owner/name`), or undefined when it names none. */
export function namedRepo(inv: Invocation): string | undefined {
  const { rest, repo } = takeRepoFlag(inv.argv.slice(1));
  if (repo !== undefined) return repoSlugOf(repo);
  if (rest[0] === 'api') {
    const path = apiEndpoint(rest.slice(1));
    const m = path === undefined ? null : /^\/?repos\/([^/]+)\/([^/?]+)/.exec(path);
    if (m && !PLACEHOLDER.test(m[1] as string) && !PLACEHOLDER.test(m[2] as string)) {
      return repoSlugOf(`${m[1]}/${m[2]}`);
    }
    return undefined;
  }
  for (const a of rest) {
    if (/^https?:\/\/[^/]+\/[^/]+\/[^/]+/i.test(a)) return repoSlugOf(a);
  }
  return undefined;
}

/**
 * True when the invocation names a repo that is not this checkout's (`sameRepo` answers for a slug).
 * An invocation that names no repo is about the cwd's repo, so never foreign.
 */
export function isForeign(inv: Invocation, sameRepo: (slug: string) => boolean): boolean {
  const slug = namedRepo(inv);
  return slug !== undefined && !sameRepo(slug);
}
