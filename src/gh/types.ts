// Shared gh-layer types. RepoRef is defined here so every gh module can use it without a cycle.

export interface RepoRef {
  host: string;
  owner: string;
  name: string;
}

export const DEFAULT_HOST = 'github.com';

/** The `-R` value: always host/owner/name, so gh never infers the repo from the cwd (01 §4.3). */
export function repoArg(r: RepoRef): string {
  return `${r.host}/${r.owner}/${r.name}`;
}

/** owner/name, the human form used in refs and messages. */
export function repoSlug(r: RepoRef): string {
  return `${r.owner}/${r.name}`;
}

export function sameRepo(a: RepoRef, b: RepoRef): boolean {
  return (
    a.host.toLowerCase() === b.host.toLowerCase() &&
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.name.toLowerCase() === b.name.toLowerCase()
  );
}
