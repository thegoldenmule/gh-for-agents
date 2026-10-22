// Repo resolution (01 §4.5): --repo, then the ref's repo, then GH_REPO, then the cwd remote (local,
// no network, mirroring gh's gh-resolved rules). Mismatch rules 1–5 live here.
import { GhxError } from '../core/errors.ts';
import type { Git, GitRemote } from '../git/index.ts';
import { parseRepo, tryParseRepo } from './refs.ts';
import { DEFAULT_HOST, type RepoRef, repoSlug, sameRepo } from './types.ts';

export type RepoNeed = 'none' | 'optional' | 'inferred' | 'explicit';
export type RepoSource = 'flag' | 'url' | 'env' | 'cwd';

export interface ResolvedRepo {
  repo: RepoRef;
  source: RepoSource;
  /** The repo the cwd resolves to, when it does (for CWD_REPO_MISMATCH warnings, rule 5). */
  cwdRepo?: RepoRef;
  cwdToplevel?: string;
}

export interface CwdRepo {
  repo?: RepoRef;
  toplevel?: string;
  /** Distinct GitHub repos among the remotes when none is gh-resolved (rule 3). */
  ambiguous?: { remote: string; repo: RepoRef }[];
}

const REMOTE_ORDER = ['upstream', 'github', 'origin'];

function remoteRank(name: string): number {
  const i = REMOTE_ORDER.indexOf(name);
  return i === -1 ? REMOTE_ORDER.length : i;
}

/** Resolve the cwd's repo from local git remotes only. Non-GitHub hosts are ignored unless they match GH_HOST. */
export async function resolveCwdRepo(git: Git, env: Readonly<Record<string, string | undefined>>): Promise<CwdRepo> {
  const toplevel = await git.toplevel();
  if (!toplevel) return {};
  const ghHost = env.GH_HOST?.toLowerCase();
  const hosts = new Set([DEFAULT_HOST, ...(ghHost ? [ghHost] : [])]);
  const candidates: { remote: GitRemote; repo: RepoRef }[] = [];
  for (const remote of await git.remotes()) {
    const repo = tryParseRepo(remote.url);
    if (repo && hosts.has(repo.host)) candidates.push({ remote, repo });
  }
  candidates.sort(
    (a, b) => remoteRank(a.remote.name) - remoteRank(b.remote.name) || a.remote.name.localeCompare(b.remote.name),
  );
  if (candidates.length === 0) return { toplevel };
  const resolved = candidates.find((c) => c.remote.ghResolved === 'base');
  if (resolved) return { toplevel, repo: resolved.repo };
  const distinct: { remote: string; repo: RepoRef }[] = [];
  for (const c of candidates) {
    if (!distinct.some((d) => sameRepo(d.repo, c.repo))) distinct.push({ remote: c.remote.name, repo: c.repo });
  }
  if (distinct.length === 1) return { toplevel, repo: distinct[0]?.repo as RepoRef };
  return { toplevel, ambiguous: distinct };
}

export interface ResolveRepoOptions {
  /** --repo */
  flag?: string | undefined;
  /** The repo embedded in the target ref (o/r#123 or a URL), if any. */
  ref?: RepoRef | undefined;
  env: Readonly<Record<string, string | undefined>>;
  git: Git;
  need: RepoNeed;
}

/**
 * Resolve the target repo. Returns undefined only for need 'optional' (or 'none') when nothing
 * resolves; otherwise throws REPO_NOT_FOUND, USAGE_REPO_MISMATCH, USAGE_REPO_REQUIRED or REPO_AMBIGUOUS.
 */
export async function resolveRepo(o: ResolveRepoOptions): Promise<ResolvedRepo | undefined> {
  if (o.need === 'none') return undefined;
  const defaultHost = o.env.GH_HOST?.toLowerCase() || DEFAULT_HOST;
  const flag = o.flag !== undefined ? parseRepo(o.flag, defaultHost) : undefined;

  // Rule 1: --repo and the ref's repo disagree.
  if (flag && o.ref && !sameRepo(flag, o.ref)) {
    throw new GhxError(
      'USAGE_REPO_MISMATCH',
      `--repo ${repoSlug(flag)} disagrees with the selector's repo ${repoSlug(o.ref)}.`,
      {
        hint: 'Pass one of them, or make them agree.',
        details: { flag: repoSlug(flag), selector: repoSlug(o.ref) },
      },
    );
  }

  const cwd = await resolveCwdRepo(o.git, o.env);
  const withCwd = (r: ResolvedRepo): ResolvedRepo => {
    if (cwd.repo) r.cwdRepo = cwd.repo;
    if (cwd.toplevel) r.cwdToplevel = cwd.toplevel;
    return r;
  };

  if (flag) return withCwd({ repo: flag, source: 'flag' });
  if (o.ref) return withCwd({ repo: o.ref, source: 'url' });
  const envRepo = o.env.GH_REPO ? tryParseRepo(o.env.GH_REPO, defaultHost) : undefined;
  if (envRepo) return withCwd({ repo: envRepo, source: 'env' });

  // Rule 3: several GitHub remotes, different repos, none gh-resolved.
  if (cwd.ambiguous) {
    if (o.need === 'optional') return undefined;
    const list = cwd.ambiguous.map((a) => `${a.remote} → ${repoSlug(a.repo)}`).join(', ');
    throw new GhxError('REPO_AMBIGUOUS', `The cwd has several GitHub remotes and none is the gh default: ${list}.`, {
      details: { remotes: cwd.ambiguous.map((a) => ({ remote: a.remote, repo: repoSlug(a.repo) })) },
    });
  }
  if (!cwd.repo) {
    if (o.need === 'optional') return undefined;
    throw new GhxError(
      'REPO_NOT_FOUND',
      cwd.toplevel
        ? 'Could not determine a repo: the cwd has no GitHub remote.'
        : 'Could not determine a repo: cwd is not a git checkout.',
    );
  }
  // Rule 2: this command refuses cwd inference.
  if (o.need === 'explicit') {
    throw new GhxError('USAGE_REPO_REQUIRED', 'This command needs an explicit repo.', {
      hint: `Pass --repo owner/name (cwd resolves to ${repoSlug(cwd.repo)}).`,
      details: { cwdRepo: repoSlug(cwd.repo) },
    });
  }
  return withCwd({ repo: cwd.repo, source: 'cwd' });
}

/**
 * Rule 4 (the sektar #3258 case): a not-found for a repo inferred from the cwd gets the repo, its
 * source and the toplevel in details, and a hint to pass --repo or the PR URL.
 */
export function enrichNotFound(e: unknown, resolved: ResolvedRepo | undefined, what: string): unknown {
  if (resolved?.source !== 'cwd') return e;
  if (!(e instanceof GhxError) || !['PR_NOT_FOUND', 'RUN_NOT_FOUND', 'REF_NOT_FOUND'].includes(e.code)) return e;
  const slug = repoSlug(resolved.repo);
  const details: Record<string, unknown> = { ...(e.details ?? {}), repo: slug, repoSource: 'cwd' };
  if (resolved.cwdToplevel) details.cwdToplevel = resolved.cwdToplevel;
  return new GhxError(e.code, `${what} not found in ${slug} (repo resolved from cwd).`, {
    hint: `${what} not found in ${slug} (inferred from cwd). Pass --repo owner/name or the PR URL.`,
    details,
    cause: e,
  });
}
