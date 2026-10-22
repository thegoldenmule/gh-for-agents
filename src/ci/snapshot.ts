// The CI subset of GraphQL Q1 (02 §4.3 steps 2–3; 03 M2.2). CI is never reported for a SHA other
// than the head [G-SHA]: the rollup commit oid must equal headRefOid. On a mismatch the query runs
// once more; if it still differs, the snapshot carries no checks, warns CI_SHA_MISMATCH and summarises
// as `pending`.
//
// pr status (M6.3) builds a bigger Q1; it embeds CI_COMMIT_FIELDS under `commits(last:1){nodes{commit{…}}}`
// and passes `rollupNodes(commit)` to `normaliseRollup` (checks.ts), so both share one normalisation.
// completeRollup does the rest for such a caller: the head-SHA re-query and the context pagination.
import { z } from 'zod';
import { GhxError } from '../core/errors.ts';
import type { Gh } from '../gh/index.ts';
import type { RepoRef } from '../gh/types.ts';
import type { Check, CiSummary, ExpectedCheck } from '../schemas/ci.ts';
import { type IgnoreRule, normaliseRollup, RollupContext, type WorkflowRunInfo } from './checks.ts';
import { summariseCi } from './summary.ts';

/** Contexts per page, and the page bound (500 checks). */
export const CONTEXTS_PAGE = 100;
export const MAX_CONTEXT_PAGES = 5;

const CHECK_RUN_FIELDS =
  'databaseId name status conclusion startedAt completedAt detailsUrl isRequired(pullRequestNumber:$number) ' +
  'checkSuite{app{slug} workflowRun{databaseId event file{path} workflow{databaseId name}}}';
const STATUS_CONTEXT_FIELDS = 'context state targetUrl createdAt isRequired(pullRequestNumber:$number)';

/** The commit selection for the CI rollup. Needs `$number:Int!` and `$after:String` in the operation. */
export const CI_COMMIT_FIELDS =
  `oid statusCheckRollup{contexts(first:${CONTEXTS_PAGE},after:$after){pageInfo{hasNextPage endCursor} ` +
  `nodes{__typename ... on CheckRun{${CHECK_RUN_FIELDS}} ... on StatusContext{${STATUS_CONTEXT_FIELDS}}}}}`;

export const CI_SNAPSHOT_QUERY =
  'query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){' +
  'defaultBranchRef{name} pullRequest(number:$number){number state headRefOid headRefName baseRefName ' +
  `commits(last:1){nodes{commit{${CI_COMMIT_FIELDS}}}}}}}`;

export const CiCommit = z.object({
  oid: z.string(),
  statusCheckRollup: z
    .object({
      contexts: z.object({
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
        nodes: z.array(RollupContext.nullable()),
      }),
    })
    .nullable(),
});
export type CiCommit = z.infer<typeof CiCommit>;

const SnapshotData = z.object({
  repository: z
    .object({
      defaultBranchRef: z.object({ name: z.string() }).nullable(),
      pullRequest: z
        .object({
          number: z.number().int(),
          state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
          headRefOid: z.string(),
          headRefName: z.string(),
          baseRefName: z.string(),
          commits: z.object({ nodes: z.array(z.object({ commit: CiCommit }).nullable()) }),
        })
        .nullable(),
    })
    .nullable(),
});
type SnapshotData = z.infer<typeof SnapshotData>;

export interface CiSnapshot {
  repo: RepoRef;
  number: number;
  prState: 'OPEN' | 'CLOSED' | 'MERGED';
  headSha: string;
  headRef: string;
  baseRef: string;
  /** The repo default branch: the shared-with-main comparison branch (02 §1.5), not the PR base. */
  defaultBranch: string;
  /** False when the rollup oid never matched headRefOid; `checks` is then empty. */
  forHeadSha: boolean;
  /** Considered checks: latest attempt per (workflow, name), ci.ignore applied. */
  checks: Check[];
  ignored: string[];
  /** Workflow runs behind the Actions checks, keyed by run id. */
  runs: Record<string, WorkflowRunInfo>;
  /** More than MAX_CONTEXT_PAGES pages of contexts existed (warned CI_CHECKS_TRUNCATED). */
  truncated: boolean;
  /** GraphQL calls made (1 for a green PR with ≤100 checks). */
  queries: number;
}

export interface SnapshotWarning {
  code: string;
  message: string;
}

export interface FetchCiSnapshotOptions {
  gh: Gh;
  repo: RepoRef;
  number: number;
  ignore?: readonly IgnoreRule[];
  warn?: (w: SnapshotWarning) => void;
}

interface PageResult {
  data: NonNullable<NonNullable<SnapshotData['repository']>['pullRequest']>;
  defaultBranch: string;
  commit: CiCommit | null;
}

async function queryPage(
  o: Pick<FetchCiSnapshotOptions, 'gh' | 'repo' | 'number'>,
  after: string | null,
): Promise<PageResult> {
  const data = await o.gh.graphql(
    CI_SNAPSHOT_QUERY,
    { owner: o.repo.owner, name: o.repo.name, number: o.number, after },
    SnapshotData,
    { repo: o.repo, notFound: 'PR_NOT_FOUND' },
  );
  const pr = data.repository?.pullRequest;
  if (!data.repository || !pr) {
    throw new GhxError('PR_NOT_FOUND', `PR ${o.repo.owner}/${o.repo.name}#${o.number} was not found.`, {
      details: { repo: `${o.repo.owner}/${o.repo.name}`, number: o.number },
    });
  }
  return {
    data: pr,
    defaultBranch: data.repository.defaultBranchRef?.name ?? pr.baseRefName,
    commit: pr.commits.nodes.at(-1)?.commit ?? null,
  };
}

/** Rollup nodes from a commit, null entries dropped. */
export function rollupNodes(commit: CiCommit | null): RollupContext[] {
  return (commit?.statusCheckRollup?.contexts.nodes ?? []).filter((n): n is RollupContext => n !== null);
}

/** One page of a PR's rollup: the PR head at query time and its last commit (CI_COMMIT_FIELDS). */
export interface RollupPage {
  headSha: string;
  commit: CiCommit | null;
}
/** Fetch the rollup page after `after`; null re-runs the first page. */
export type RollupPageFetcher = (after: string | null) => Promise<RollupPage>;

export interface CompleteRollupOptions {
  gh: Gh;
  repo: RepoRef;
  number: number;
  /** headRefOid from the caller's query. */
  headSha: string;
  /** The commit node from the caller's query (CI_COMMIT_FIELDS under `commits(last:1)`), or null. */
  firstPage: CiCommit | null;
  /** How a page is fetched. Default: CI_SNAPSHOT_QUERY (needs only gh, repo and number). */
  fetchPage?: RollupPageFetcher;
  warn?: (w: SnapshotWarning) => void;
}

export type CompletedRollup =
  | {
      forHeadSha: true;
      /** The head the nodes belong to (the re-queried head, if a re-query ran). */
      headSha: string;
      nodes: RollupContext[];
      /** More than MAX_CONTEXT_PAGES pages existed (warned CI_CHECKS_TRUNCATED). */
      truncated: boolean;
      /** GraphQL calls made here, beyond the caller's own. */
      queries: number;
    }
  | { forHeadSha: false; headSha: string; rollupOid: string | null; queries: number };

/**
 * Finish a rollup a caller started in its own query [G-SHA]: if the first page's commit is not the head,
 * re-query once (02 §4.3 step 3); then follow `hasNextPage` up to MAX_CONTEXT_PAGES, bailing out if the head
 * moves between pages. A rollup that never matches the head warns CI_SHA_MISMATCH and has `forHeadSha:false`.
 */
export async function completeRollup(o: CompleteRollupOptions): Promise<CompletedRollup> {
  const fetchPage: RollupPageFetcher =
    o.fetchPage ??
    (async (after) => {
      const p = await queryPage(o, after);
      return { headSha: p.data.headRefOid, commit: p.commit };
    });
  let queries = 0;
  let headSha = o.headSha;
  let first = o.firstPage;
  if (first?.oid !== headSha) {
    // Eventual consistency right after a push: re-query once (02 §4.3 step 3).
    queries++;
    const again = await fetchPage(null);
    headSha = again.headSha;
    first = again.commit;
  }
  const mismatch = (oid: string | undefined): CompletedRollup => {
    o.warn?.({
      code: 'CI_SHA_MISMATCH',
      message: `The check rollup is for ${oid?.slice(0, 7) ?? 'no commit'}, not the head ${headSha.slice(0, 7)}; CI is reported as pending.`,
    });
    return { forHeadSha: false, headSha, rollupOid: oid ?? null, queries };
  };
  if (first?.oid !== headSha) return mismatch(first?.oid);

  const nodes = rollupNodes(first);
  let page = first.statusCheckRollup?.contexts.pageInfo;
  let pages = 1;
  let truncated = false;
  while (page?.hasNextPage && page.endCursor) {
    if (pages >= MAX_CONTEXT_PAGES) {
      truncated = true;
      o.warn?.({
        code: 'CI_CHECKS_TRUNCATED',
        message: `More than ${MAX_CONTEXT_PAGES * CONTEXTS_PAGE} checks; only the first ${MAX_CONTEXT_PAGES * CONTEXTS_PAGE} were read.`,
      });
      break;
    }
    queries++;
    pages++;
    const next = await fetchPage(page.endCursor);
    // A push between pages: the remaining pages belong to another commit.
    if (next.headSha !== headSha || next.commit?.oid !== headSha) return mismatch(next.commit?.oid);
    nodes.push(...rollupNodes(next.commit));
    page = next.commit.statusCheckRollup?.contexts.pageInfo;
  }
  return { forHeadSha: true, headSha, nodes, truncated, queries };
}

export async function fetchCiSnapshot(o: FetchCiSnapshotOptions): Promise<CiSnapshot> {
  const first = await queryPage(o, null);
  // completeRollup's first-page re-query refreshes the PR fields too.
  let latest = first;
  const r = await completeRollup({
    gh: o.gh,
    repo: o.repo,
    number: o.number,
    headSha: first.data.headRefOid,
    firstPage: first.commit,
    ...(o.warn ? { warn: o.warn } : {}),
    fetchPage: async (after) => {
      const p = await queryPage(o, after);
      if (after === null) latest = p;
      return { headSha: p.data.headRefOid, commit: p.commit };
    },
  });
  const queries = 1 + r.queries;
  const base = {
    repo: o.repo,
    number: latest.data.number,
    prState: latest.data.state,
    headSha: r.headSha,
    headRef: latest.data.headRefName,
    baseRef: latest.data.baseRefName,
    defaultBranch: latest.defaultBranch,
  };
  if (!r.forHeadSha)
    return { ...base, forHeadSha: false, checks: [], ignored: [], runs: {}, truncated: false, queries };
  const norm = normaliseRollup(r.nodes, {
    repo: o.repo,
    headSha: r.headSha,
    ...(o.ignore ? { ignore: o.ignore } : {}),
  });
  return { ...base, forHeadSha: true, ...norm, truncated: r.truncated, queries };
}

/** The CiSummary for a snapshot. `expected`, `eta` and `next` come from the caller (M4.1, M4.2). */
export function snapshotSummary(
  s: CiSnapshot,
  extra: { expected?: readonly ExpectedCheck[]; eta?: CiSummary['eta']; next?: readonly string[] } = {},
): CiSummary {
  return summariseCi({
    headSha: s.headSha,
    checks: s.checks,
    ignored: s.ignored,
    shaMismatch: !s.forHeadSha,
    ...extra,
  });
}
