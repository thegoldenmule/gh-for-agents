// A small in-memory Git (03 §4.2) so cwd/repo cases need no real repository.
import type { Git, GitRemote } from '../../src/git/index.ts';

export interface FakeGitState {
  available?: boolean;
  toplevel?: string;
  remotes?: GitRemote[];
  branch?: string;
  refs?: Record<string, string>;
  /** `git diff --name-only` results keyed `<from>...<to>`; absent keys answer undefined. */
  diffs?: Record<string, string[]>;
}

export function fakeGit(s: FakeGitState = {}): Git {
  return {
    available: async () => s.available ?? true,
    toplevel: async () => s.toplevel,
    remotes: async () => s.remotes ?? [],
    currentBranch: async () => s.branch,
    revParse: async (ref) => s.refs?.[ref],
    diffNames: async (from, to) => s.diffs?.[`${from}...${to}`],
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
