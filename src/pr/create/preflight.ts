// The `pr create` reads (02 §2.6 steps 3–5): one GraphQL query, the compare with its 300-file fallback,
// and the open-PR re-check used after a transient POST failure. Pure builders plus thin gh wrappers, so
// `pr edit` (02 §3) can reuse the ref lookup and the compare.
import { z } from 'zod';
import { GhxError } from '../../core/errors.ts';
import type { Gh } from '../../gh/index.ts';
import { type RepoRef, repoSlug } from '../../gh/types.ts';
import type { Git } from '../../git/index.ts';

/** GitHub's compare and PR-files endpoints stop listing files at 300 [G-300]. */
export const COMPARE_FILE_CAP = 300;

/** Permissions that can push the head branch; anything less is GH_FORBIDDEN (02 §6.2). */
export const PUSH_PERMISSIONS = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);

/** A ref as written in the input, split into its repo (null = the target repo) and number. */
export interface RefLookup {
  /** As written: `#12` or `owner/repo#12`. */
  ref: string;
  owner: string | null;
  name: string | null;
  number: number;
}

/** Parse `#N` / `owner/repo#N`. A ref naming the target repo is looked up as a same-repo ref. */
export function toLookup(ref: string, repo: RepoRef): RefLookup {
  const hash = ref.lastIndexOf('#');
  const number = Number(ref.slice(hash + 1));
  const slug = ref.slice(0, hash);
  if (slug === '' || slug.toLowerCase() === repoSlug(repo).toLowerCase()) {
    return { ref, owner: null, name: null, number };
  }
  const [owner = '', name = ''] = slug.split('/');
  return { ref, owner, name, number };
}

const PR_FIELDS = 'number state url headRepository{nameWithOwner}';

/**
 * The preflight query: viewer, default branch, permission, base and head refs, PRs on the head (any
 * state) and on the base (open; the stack parent), plus one alias per referenced PR or issue. Ref
 * owners and names match `[\w.-]+` (PrRef), so they are inlined as JSON strings; numbers are digits.
 */
export function buildPreflightQuery(lookups: readonly RefLookup[]): string {
  const local = lookups
    .map((l, i) => (l.owner === null ? `r${i}:issueOrPullRequest(number:${l.number}){__typename}` : ''))
    .filter((s) => s !== '');
  const remote = lookups
    .map((l, i) =>
      l.owner === null
        ? ''
        : `x${i}:repository(owner:${JSON.stringify(l.owner)},name:${JSON.stringify(l.name)}){issueOrPullRequest(number:${l.number}){__typename}}`,
    )
    .filter((s) => s !== '');
  return [
    'query($owner:String!,$name:String!,$base:String!,$head:String!,$baseRef:String!,$headRef:String!){',
    'viewer{login}',
    'repository(owner:$owner,name:$name){',
    'nameWithOwner viewerPermission defaultBranchRef{name}',
    'baseRef:ref(qualifiedName:$baseRef){target{oid}}',
    'headRef:ref(qualifiedName:$headRef){target{oid}}',
    `headPrs:pullRequests(headRefName:$head,first:20,orderBy:{field:CREATED_AT,direction:DESC}){nodes{${PR_FIELDS}}}`,
    `parentPrs:pullRequests(headRefName:$base,states:[OPEN],first:20){nodes{${PR_FIELDS}}}`,
    ...local,
    '}',
    ...remote,
    '}',
  ].join(' ');
}

export function preflightVars(repo: RepoRef, base: string, head: string): Record<string, string> {
  return {
    owner: repo.owner,
    name: repo.name,
    base,
    head,
    baseRef: `refs/heads/${base}`,
    headRef: `refs/heads/${head}`,
  };
}

const PrNode = z.object({
  number: z.number().int(),
  state: z.string(),
  url: z.string(),
  headRepository: z.object({ nameWithOwner: z.string() }).nullable(),
});
type PrNode = z.infer<typeof PrNode>;

const RefNode = z.object({ target: z.object({ oid: z.string() }) }).nullable();

const PreflightData = z
  .object({
    viewer: z.object({ login: z.string() }),
    repository: z
      .object({
        nameWithOwner: z.string(),
        viewerPermission: z.string().nullable(),
        defaultBranchRef: z.object({ name: z.string() }).nullable(),
        baseRef: RefNode,
        headRef: RefNode,
        headPrs: z.object({ nodes: z.array(PrNode.nullable()) }),
        parentPrs: z.object({ nodes: z.array(PrNode.nullable()) }),
      })
      .loose()
      .nullable(),
  })
  .loose();

export interface PrSummary {
  number: number;
  state: string;
  url: string;
}

export interface Preflight {
  viewer: string;
  permission: string | null;
  defaultBranch: string;
  /** Null when the branch is not on the remote. */
  baseOid: string | null;
  headOid: string | null;
  /** The open PR from this repo's head branch (fork PRs with the same branch name are ignored). */
  openOnHead: PrSummary | null;
  /** Closed or merged PRs from this head branch (a warning, not an error: 02 §2.4). */
  closedOnHead: PrSummary[];
  /** The open PR whose head is the base: the stack parent. */
  baseParent: PrSummary | null;
  /** Refs (as written) that do not exist. */
  missingRefs: string[];
}

function sameRepoPrs(nodes: readonly (PrNode | null)[], repo: RepoRef): PrNode[] {
  const slug = repoSlug(repo).toLowerCase();
  return nodes.filter((n): n is PrNode => n !== null && n.headRepository?.nameWithOwner.toLowerCase() === slug);
}

const summary = (n: PrNode): PrSummary => ({ number: n.number, state: n.state, url: n.url });

/** Run the preflight query for one create input. */
export async function runPreflight(
  gh: Gh,
  repo: RepoRef,
  o: { base: string; head: string; refs: readonly string[] },
): Promise<Preflight> {
  const seen = new Set<string>();
  const lookups: RefLookup[] = [];
  for (const ref of o.refs) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    lookups.push(toLookup(ref, repo));
  }
  const { data, errors } = await gh.graphqlPartial(
    buildPreflightQuery(lookups),
    preflightVars(repo, o.base, o.head),
    PreflightData,
    { repo, notFound: 'REPO_NOT_FOUND' },
  );
  const r = data.repository;
  if (r === null) {
    throw new GhxError('REPO_NOT_FOUND', `Repository ${repoSlug(repo)} was not found or is not visible to you.`, {
      hint: 'Check -R owner/name (or the cwd remote) and your gh account.',
      details: { repo: repoSlug(repo) },
    });
  }
  // Errors under a ref alias are that ref's not-found; any other error is a real failure.
  const aliasOf = (path: readonly (string | number)[] | undefined): boolean => {
    const [a, b] = path ?? [];
    return (
      (typeof a === 'string' && /^x\d+$/.test(a)) || (a === 'repository' && typeof b === 'string' && /^r\d+$/.test(b))
    );
  };
  const other = errors.filter((e) => !aliasOf(e.path));
  if (other.length > 0) {
    throw new GhxError(
      'GH_FAILED',
      `GraphQL: ${other
        .map((e) => e.message)
        .join('; ')
        .slice(0, 300)}`,
      {
        details: { errors: other.slice(0, 10) },
      },
    );
  }
  const missingRefs = lookups
    .filter((l, i) => {
      if (l.owner === null) return (r as Record<string, unknown>)[`r${i}`] == null;
      const x = (data as Record<string, unknown>)[`x${i}`] as { issueOrPullRequest?: unknown } | null | undefined;
      return x == null || x.issueOrPullRequest == null;
    })
    .map((l) => l.ref);
  const head = sameRepoPrs(r.headPrs.nodes, repo);
  const parent = sameRepoPrs(r.parentPrs.nodes, repo)[0];
  const open = head.find((n) => n.state === 'OPEN');
  return {
    viewer: data.viewer.login,
    permission: r.viewerPermission,
    defaultBranch: r.defaultBranchRef?.name ?? 'main',
    baseOid: r.baseRef?.target.oid ?? null,
    headOid: r.headRef?.target.oid ?? null,
    openOnHead: open ? summary(open) : null,
    closedOnHead: head.filter((n) => n.state !== 'OPEN').map(summary),
    baseParent: parent ? summary(parent) : null,
    missingRefs,
  };
}

const CompareData = z.object({
  ahead_by: z.number().int(),
  files: z.array(z.object({ filename: z.string(), previous_filename: z.string().optional() })).optional(),
});

export interface ChangedFiles {
  aheadBy: number;
  /** Null when GitHub capped the list and no local checkout could fill it in. */
  files: string[] | null;
  /** Where `files` came from. */
  source: 'compare' | 'local-git' | 'none';
}

/** `compare/<base>...<head>` by OID; at the 300-file cap, local `git diff --name-only` when allowed [G-300]. */
export async function changedFiles(
  gh: Gh,
  git: Git | null,
  repo: RepoRef,
  baseOid: string,
  headOid: string,
): Promise<ChangedFiles> {
  const r = await gh.api({ path: `repos/{owner}/{repo}/compare/${baseOid}...${headOid}`, repo }, CompareData, {
    notFound: 'REF_NOT_FOUND',
  });
  if (r.notModified) throw new GhxError('INTERNAL', 'compare returned 304 without a conditional request.');
  const listed = (r.data.files ?? []).flatMap((f) =>
    f.previous_filename !== undefined ? [f.filename, f.previous_filename] : [f.filename],
  );
  if ((r.data.files ?? []).length < COMPARE_FILE_CAP) {
    return { aheadBy: r.data.ahead_by, files: listed, source: 'compare' };
  }
  const local = git ? await git.diffNames(baseOid, headOid) : undefined;
  if (local !== undefined) return { aheadBy: r.data.ahead_by, files: local, source: 'local-git' };
  return { aheadBy: r.data.ahead_by, files: null, source: 'none' };
}

/** The re-check after a transient POST failure (02 §2.6 step 7): open PRs from this repo's head. */
export function buildOpenOnHeadQuery(): string {
  return 'query($owner:String!,$name:String!,$head:String!){repository(owner:$owner,name:$name){pullRequests(headRefName:$head,states:[OPEN],first:20){nodes{number state url body headRepository{nameWithOwner}}}}}';
}

const OpenOnHeadData = z.object({
  repository: z
    .object({ pullRequests: z.object({ nodes: z.array(PrNode.extend({ body: z.string() }).nullable()) }) })
    .nullable(),
});

export async function openPrOnHead(
  gh: Gh,
  repo: RepoRef,
  head: string,
): Promise<(PrSummary & { body: string }) | null> {
  const data = await gh.graphql(buildOpenOnHeadQuery(), { owner: repo.owner, name: repo.name, head }, OpenOnHeadData, {
    repo,
    notFound: 'REPO_NOT_FOUND',
  });
  const slug = repoSlug(repo).toLowerCase();
  const n = (data.repository?.pullRequests.nodes ?? []).find(
    (x) => x !== null && x.headRepository?.nameWithOwner.toLowerCase() === slug,
  );
  return n ? { number: n.number, state: n.state, url: n.url, body: n.body } : null;
}
