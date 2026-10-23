// GraphQL Q1 (02 §4.3 step 2; 03 M6.3): one query for the PR fields, the CI rollup (CI_COMMIT_FIELDS),
// the three feedback sources, the base-change timeline [G-RETARGET], the viewer and the repo's merge
// settings. Every connection that reports `hasNextPage` is followed with a narrow per-connection query,
// up to MAX_PAGES pages each (warned FEEDBACK_TRUNCATED beyond that). The rollup is finished by the CI
// module's completeRollup (the head re-query, CI_SNAPSHOT_QUERY pages and the head-moved guard), with Q1
// itself as the re-query so the PR fields stay in step with the head.
import { z } from 'zod';
import type { RollupContext } from '../../ci/checks.ts';
import { CI_COMMIT_FIELDS, CI_SNAPSHOT_QUERY, CiCommit, completeRollup } from '../../ci/snapshot.ts';
import { GhxError } from '../../core/errors.ts';
import { RawIssueComment, RawReview, RawReviewComment, type RawReviewThread } from '../../feedback/raw.ts';
import type { Gh } from '../../gh/index.ts';
import { type RepoRef, repoSlug } from '../../gh/types.ts';
import type { Warning } from '../../schemas/common.ts';

/** Pages followed per feedback connection (100 items a page; 50 per page of a thread's comments). */
export const MAX_PAGES = 10;

const ACTOR = 'author{__typename login}';
const COMMON = `databaseId ${ACTOR} authorAssociation body createdAt lastEditedAt url`;
const ISSUE_COMMENT_FIELDS = COMMON;
const REVIEW_FIELDS = `${COMMON} state submittedAt commit{oid}`;
const REVIEW_COMMENT_FIELDS = `${COMMON} path line originalLine outdated commit{oid} replyTo{databaseId} pullRequestReview{databaseId}`;
const PAGE = 'pageInfo{hasNextPage endCursor}';
const THREAD_FIELDS = `id isResolved isOutdated path line comments(first:50){${PAGE} nodes{${REVIEW_COMMENT_FIELDS}}}`;
const TIMELINE_FIELDS =
  '__typename ... on BaseRefChangedEvent{createdAt previousRefName currentRefName} ' +
  '... on AutomaticBaseChangeSucceededEvent{createdAt oldBase newBase}';
const TIMELINE_ARGS = 'itemTypes:[BASE_REF_CHANGED_EVENT,AUTOMATIC_BASE_CHANGE_SUCCEEDED_EVENT]';

/** The connections Q1 paginates, with their per-page selection. */
const CONNECTIONS = {
  comments: { first: 100, args: '', nodes: ISSUE_COMMENT_FIELDS },
  reviews: { first: 100, args: '', nodes: REVIEW_FIELDS },
  reviewThreads: { first: 100, args: '', nodes: THREAD_FIELDS },
  timelineItems: { first: 100, args: TIMELINE_ARGS, nodes: TIMELINE_FIELDS },
} as const;
type ConnectionName = keyof typeof CONNECTIONS;

function connection(name: ConnectionName, after: boolean): string {
  const c = CONNECTIONS[name];
  const args = [`first:${c.first}`, ...(after ? ['after:$after'] : []), ...(c.args ? [c.args] : [])].join(',');
  return `${name}(${args}){${PAGE} nodes{${c.nodes}}}`;
}

/** Q1. The CI selection needs `$number` and `$after`; Q1 passes `after: null`. */
export const Q1_QUERY =
  'query($owner:String!,$name:String!,$number:Int!,$after:String){viewer{login} ' +
  'repository(owner:$owner,name:$name){mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed deleteBranchOnMerge ' +
  'viewerPermission defaultBranchRef{name} pullRequest(number:$number){number url title body state isDraft createdAt updatedAt ' +
  `${ACTOR} authorAssociation baseRefName baseRefOid headRefName headRefOid isCrossRepository ` +
  'headRepository{nameWithOwner} changedFiles additions deletions commitCount:commits{totalCount} ' +
  'mergeable mergeStateStatus reviewDecision mergedAt mergeCommit{oid} ' +
  `commits(last:1){nodes{commit{${CI_COMMIT_FIELDS}}}} ` +
  `${(Object.keys(CONNECTIONS) as ConnectionName[]).map((n) => connection(n, false)).join(' ')}}}}`;

/** A follow-up page of one PR connection. */
export function connectionPageQuery(name: ConnectionName): string {
  return (
    'query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){' +
    `pullRequest(number:$number){${connection(name, true)}}}}`
  );
}

/** A follow-up page of one review thread's comments. */
export const THREAD_COMMENTS_QUERY =
  'query($id:ID!,$after:String){node(id:$id){... on PullRequestReviewThread{' +
  `comments(first:50,after:$after){${PAGE} nodes{${REVIEW_COMMENT_FIELDS}}}}}}`;

// ── Shapes ────────────────────────────────────────────────────────────────
const PageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const conn = <T extends z.ZodType>(node: T) => z.object({ pageInfo: PageInfo, nodes: z.array(node.nullable()) });

export const RawThread = z.looseObject({
  id: z.string(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  path: z.string(),
  line: z.number().int().nullable().optional(),
  comments: conn(RawReviewComment),
});

export const TimelineNode = z.union([
  z.object({
    __typename: z.literal('BaseRefChangedEvent'),
    createdAt: z.string(),
    previousRefName: z.string(),
    currentRefName: z.string(),
  }),
  z.object({
    __typename: z.literal('AutomaticBaseChangeSucceededEvent'),
    createdAt: z.string(),
    oldBase: z.string(),
    newBase: z.string(),
  }),
  z.looseObject({ __typename: z.string() }),
]);
export type TimelineNode = z.infer<typeof TimelineNode>;

const Actor = z.looseObject({ __typename: z.string().optional(), login: z.string() });

export const Q1Pr = z.object({
  number: z.number().int(),
  url: z.string(),
  title: z.string(),
  body: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  author: Actor.nullable(),
  authorAssociation: z.string(),
  baseRefName: z.string(),
  baseRefOid: z.string(),
  headRefName: z.string(),
  headRefOid: z.string(),
  isCrossRepository: z.boolean(),
  headRepository: z.object({ nameWithOwner: z.string() }).nullable(),
  changedFiles: z.number().int(),
  additions: z.number().int(),
  deletions: z.number().int(),
  commitCount: z.object({ totalCount: z.number().int() }),
  // Strings, not enums: a future value must not fail the read (it maps to UNKNOWN downstream).
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  reviewDecision: z.string().nullable(),
  mergedAt: z.string().nullable(),
  mergeCommit: z.object({ oid: z.string() }).nullable(),
  commits: z.object({ nodes: z.array(z.object({ commit: CiCommit }).nullable()) }),
  comments: conn(RawIssueComment),
  reviews: conn(RawReview),
  reviewThreads: conn(RawThread),
  timelineItems: conn(TimelineNode),
});
export type Q1Pr = z.infer<typeof Q1Pr>;

export const Q1Data = z.object({
  viewer: z.object({ login: z.string() }),
  repository: z
    .object({
      mergeCommitAllowed: z.boolean(),
      squashMergeAllowed: z.boolean(),
      rebaseMergeAllowed: z.boolean(),
      deleteBranchOnMerge: z.boolean(),
      // ADMIN, MAINTAIN, WRITE, TRIAGE, READ; null when GitHub does not say (merge policy fails closed).
      viewerPermission: z.string().nullable(),
      defaultBranchRef: z.object({ name: z.string() }).nullable(),
      pullRequest: Q1Pr.nullable(),
    })
    .nullable(),
});
export type Q1Data = z.infer<typeof Q1Data>;

const CiPageData = z.object({
  repository: z
    .object({
      pullRequest: z
        .object({
          headRefOid: z.string(),
          commits: z.object({ nodes: z.array(z.object({ commit: CiCommit }).nullable()) }),
        })
        .nullable(),
    })
    .nullable(),
});

// ── Fetch ─────────────────────────────────────────────────────────────────
export interface Q1Result {
  viewerLogin: string;
  /** The viewer's permission on the base repo (Repository.viewerPermission). */
  viewerPermission: string | null;
  repoSettings: {
    mergeCommitAllowed: boolean;
    squashMergeAllowed: boolean;
    rebaseMergeAllowed: boolean;
    deleteBranchOnMerge: boolean;
  };
  defaultBranch: string;
  pr: Q1Pr;
  /** Every rollup node for the head commit; null when the rollup oid is not the head (CI_SHA_MISMATCH). */
  rollup: RollupContext[] | null;
  /** The rollup oid seen (completeRollup warned CI_SHA_MISMATCH when it is not the head). */
  rollupOid: string | null;
  /** More than MAX_CONTEXT_PAGES pages of checks existed. */
  checksTruncated: boolean;
  /**
   * A feedback connection (comments, reviews, review threads or a thread's comments) had more pages than
   * ghx reads (warned FEEDBACK_TRUNCATED): an unread finding may be open, so merge policy fails closed.
   */
  feedbackTruncated: boolean;
  issueComments: z.infer<typeof RawIssueComment>[];
  reviews: z.infer<typeof RawReview>[];
  threads: (RawReviewThread & { id: string })[];
  timeline: TimelineNode[];
  queries: number;
}

export interface Q1Options {
  gh: Gh;
  repo: RepoRef;
  number: number;
  warn: (w: Warning) => void;
}

const nonNull = <T>(xs: readonly (T | null)[]): T[] => xs.filter((x): x is T => x !== null);

async function runQ1(o: Q1Options): Promise<{ data: Q1Data; pr: Q1Pr }> {
  const data = await o.gh.graphql(
    Q1_QUERY,
    { owner: o.repo.owner, name: o.repo.name, number: o.number, after: null },
    Q1Data,
    { repo: o.repo, notFound: 'PR_NOT_FOUND' },
  );
  const pr = data.repository?.pullRequest;
  if (!data.repository || !pr) {
    throw new GhxError('PR_NOT_FOUND', `PR ${repoSlug(o.repo)}#${o.number} was not found.`, {
      details: { repo: repoSlug(o.repo), number: o.number },
    });
  }
  return { data, pr };
}

/** Q1 plus every follow-up page. The rollup is re-queried once when its oid is not the head [G-SHA]. */
export async function fetchQ1(o: Q1Options): Promise<Q1Result> {
  let first = await runQ1(o);
  const commitOf = (pr: Q1Pr) => pr.commits.nodes.at(-1)?.commit ?? null;
  const r = await completeRollup({
    gh: o.gh,
    repo: o.repo,
    number: o.number,
    headSha: first.pr.headRefOid,
    firstPage: commitOf(first.pr),
    warn: o.warn,
    fetchPage: async (after) => {
      if (after === null) {
        // Eventual consistency right after a push: re-run Q1 itself, so every PR field matches the head.
        first = await runQ1(o);
        return { headSha: first.pr.headRefOid, commit: commitOf(first.pr) };
      }
      const next = await o.gh.graphql(
        CI_SNAPSHOT_QUERY,
        { owner: o.repo.owner, name: o.repo.name, number: o.number, after },
        CiPageData,
        { repo: o.repo, notFound: 'PR_NOT_FOUND' },
      );
      const np = next.repository?.pullRequest;
      return { headSha: np?.headRefOid ?? '', commit: np?.commits.nodes.at(-1)?.commit ?? null };
    },
  });
  const { data, pr } = first;
  const repository = data.repository as NonNullable<Q1Data['repository']>;
  const counter = { queries: 1 + r.queries, feedbackTruncated: false };
  const rollupOid = r.forHeadSha ? r.headSha : r.rollupOid;
  const rollup: RollupContext[] | null = r.forHeadSha ? r.nodes : null;
  const checksTruncated = r.forHeadSha && r.truncated;

  const issueComments = await follow(o, 'comments', pr.comments, RawIssueComment, counter);
  const reviews = await follow(o, 'reviews', pr.reviews, RawReview, counter);
  const rawThreads = await follow(o, 'reviewThreads', pr.reviewThreads, RawThread, counter);
  const timeline = await follow(o, 'timelineItems', pr.timelineItems, TimelineNode, counter);
  const threads: Q1Result['threads'] = [];
  for (const t of rawThreads) {
    const nodes = nonNull(t.comments.nodes);
    let page = t.comments.pageInfo;
    for (let pages = 1; page.hasNextPage && page.endCursor; pages++) {
      if (pages >= MAX_PAGES) {
        o.warn({
          code: 'FEEDBACK_TRUNCATED',
          message: `A review thread on ${t.path} has more comments than ghx reads.`,
        });
        counter.feedbackTruncated = true;
        break;
      }
      counter.queries++;
      const next = await o.gh.graphql(
        THREAD_COMMENTS_QUERY,
        { id: t.id, after: page.endCursor },
        z.object({ node: z.object({ comments: conn(RawReviewComment) }).nullable() }),
        { repo: o.repo },
      );
      if (!next.node) break;
      nodes.push(...nonNull(next.node.comments.nodes));
      page = next.node.comments.pageInfo;
    }
    threads.push({
      id: t.id,
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      path: t.path,
      line: t.line ?? null,
      comments: { nodes },
    });
  }

  return {
    viewerLogin: data.viewer.login,
    viewerPermission: repository.viewerPermission,
    repoSettings: {
      mergeCommitAllowed: repository.mergeCommitAllowed,
      squashMergeAllowed: repository.squashMergeAllowed,
      rebaseMergeAllowed: repository.rebaseMergeAllowed,
      deleteBranchOnMerge: repository.deleteBranchOnMerge,
    },
    defaultBranch: repository.defaultBranchRef?.name ?? pr.baseRefName,
    pr,
    rollup,
    rollupOid,
    checksTruncated,
    feedbackTruncated: counter.feedbackTruncated,
    issueComments,
    reviews,
    threads,
    timeline,
    queries: counter.queries,
  };
}

async function follow<T extends z.ZodType>(
  o: Q1Options,
  name: ConnectionName,
  firstPage: { pageInfo: z.infer<typeof PageInfo>; nodes: (z.output<T> | null)[] },
  node: T,
  counter: { queries: number; feedbackTruncated?: boolean },
): Promise<z.output<T>[]> {
  const out = nonNull(firstPage.nodes);
  let page = firstPage.pageInfo;
  const schema = z.object({
    repository: z.object({ pullRequest: z.object({ [name]: conn(node) }).nullable() }).nullable(),
  });
  for (let pages = 1; page.hasNextPage && page.endCursor; pages++) {
    if (pages >= MAX_PAGES) {
      o.warn({
        code: 'FEEDBACK_TRUNCATED',
        message: `PR ${repoSlug(o.repo)}#${o.number} has more ${name} than ghx reads (${MAX_PAGES} pages).`,
      });
      // The base-change timeline is not feedback.
      if (name !== 'timelineItems') counter.feedbackTruncated = true;
      break;
    }
    counter.queries++;
    const next = await o.gh.graphql(
      connectionPageQuery(name),
      { owner: o.repo.owner, name: o.repo.name, number: o.number, after: page.endCursor },
      schema,
      { repo: o.repo, notFound: 'PR_NOT_FOUND' },
    );
    const c = next.repository?.pullRequest?.[name] as
      | { pageInfo: z.infer<typeof PageInfo>; nodes: (z.output<T> | null)[] }
      | undefined;
    if (!c) break;
    out.push(...nonNull(c.nodes));
    page = c.pageInfo;
  }
  return out;
}
