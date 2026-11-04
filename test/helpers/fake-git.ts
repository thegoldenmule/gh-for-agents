// A small in-memory Git (03 §4.2) so cwd/repo cases need no real repository.
import type { Git, GitCommit, GitRemote } from '../../src/git/index.ts';

export interface FakeGitState {
  available?: boolean;
  toplevel?: string;
  remotes?: GitRemote[];
  branch?: string;
  refs?: Record<string, string>;
  /** `git diff --name-only` results keyed `<from>...<to>`; absent keys answer undefined. */
  diffs?: Record<string, string[]>;
  /** Paths `isIgnored` reports as ignored; every other path is not ignored. */
  ignored?: string[];
  /** `history` answers these, newest first (at most `limit`); absent answers undefined. */
  history?: GitCommit[];
  /** `blobAt` answers, keyed `<ref>:<path>`; absent keys answer undefined. */
  blobs?: Record<string, string>;
  /** `hashFile` answers, keyed by file path. */
  files?: Record<string, string>;
  /** `aheadBehind` answers, keyed `<a>...<b>`. */
  counts?: Record<string, { ahead: number; behind: number }>;
  /** `remoteHead` answers, keyed by remote name (e.g. origin → origin/main). */
  remoteHeads?: Record<string, string>;
}

export function fakeGit(s: FakeGitState = {}): Git {
  return {
    available: async () => s.available ?? true,
    toplevel: async () => s.toplevel,
    remotes: async () => s.remotes ?? [],
    currentBranch: async () => s.branch,
    revParse: async (ref) => s.refs?.[ref],
    diffNames: async (from, to) => s.diffs?.[`${from}...${to}`],
    isIgnored: async (path) => s.ignored?.includes(path) ?? false,
    history: async (limit) => s.history?.slice(0, limit),
    blobAt: async (ref, path) => s.blobs?.[`${ref}:${path}`],
    hashFile: async (file) => s.files?.[file],
    aheadBehind: async (a, b) => s.counts?.[`${a}...${b}`],
    remoteHead: async (remote) => s.remoteHeads?.[remote],
  };
}

/** A checkout of owner/name at /work/<name> with one `origin` remote. */
export function gitCheckout(slug: string, extra: FakeGitState = {}): Git {
  const name = slug.split('/')[1] ?? slug;
  return fakeGit({
    toplevel: `/work/${name}`,
    remotes: [{ name: 'origin', url: `git@github.com:${slug}.git` }],
    branch: 'main',
    ...extra,
  });
}
