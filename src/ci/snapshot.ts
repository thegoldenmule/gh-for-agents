// The CI subset of GraphQL Q1 (02 §4.3 steps 2–3; 03 M2.2). CI is never reported for a SHA other
// than the head [G-SHA]: the rollup commit oid must equal headRefOid. On a mismatch the query runs
// once more; if it still differs, the snapshot carries no checks, warns CI_SHA_MISMATCH and summarises
// as `pending`.
//
// pr status (M6.3) builds a bigger Q1; it embeds CI_COMMIT_FIELDS under `commits(last:1){nodes{commit{…}}}`
// and passes `rollupNodes(commit)` to `normaliseRollup` (checks.ts), so both share one normalisation.
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

async function queryPage(o: FetchCiSnapshotOptions, after: string | null): Promise<PageResult> {
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

export async function fetchCiSnapshot(o: FetchCiSnapshotOptions): Promise<CiSnapshot> {
  let queries = 1;
  let first = await queryPage(o, null);
  if (first.commit?.oid !== first.data.headRefOid) {
    // Eventual consistency right after a push: re-query once (02 §4.3 step 3).
    queries++;
    first = await queryPage(o, null);
  }
  const headSha = first.data.headRefOid;
  const base = {
    repo: o.repo,
    number: first.data.number,
    prState: first.data.state,
    headSha,
    headRef: first.data.headRefName,
    baseRef: first.data.baseRefName,
    defaultBranch: first.defaultBranch,
  };
  const mismatch = (oid: string | undefined): CiSnapshot => {
    o.warn?.({
      code: 'CI_SHA_MISMATCH',
      message: `The check rollup is for ${oid?.slice(0, 7) ?? 'no commit'}, not the head ${headSha.slice(0, 7)}; CI is reported as pending.`,
    });
    return { ...base, forHeadSha: false, checks: [], ignored: [], runs: {}, truncated: false, queries };
  };
  if (first.commit?.oid !== headSha) return mismatch(first.commit?.oid);

  const nodes = rollupNodes(first.commit);
  let page = first.commit.statusCheckRollup?.contexts.pageInfo;
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
    const next = await queryPage(o, page.endCursor);
    // A push between pages: the remaining pages belong to another commit.
    if (next.data.headRefOid !== headSha || next.commit?.oid !== headSha) return mismatch(next.commit?.oid);
    nodes.push(...rollupNodes(next.commit));
    page = next.commit.statusCheckRollup?.contexts.pageInfo;
  }
  const norm = normaliseRollup(nodes, { repo: o.repo, headSha, ...(o.ignore ? { ignore: o.ignore } : {}) });
  return { ...base, forHeadSha: true, ...norm, truncated, queries };
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
