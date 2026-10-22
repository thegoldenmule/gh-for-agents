// The `pr edit` reads and draft mutations (02 §3 gh calls 1, 3 and 5): the PR snapshot (node id, state,
// draft, title, body, updatedAt, base, head and author), the same query again just before the PATCH, the open
// PRs stacked on this one (HAS_CHILDREN), and the two GraphQL draft transitions.
import { z } from 'zod';
import { GhxError } from '../../core/errors.ts';
import type { Gh } from '../../gh/index.ts';
import { type RepoRef, repoSlug } from '../../gh/types.ts';

export const SNAPSHOT_QUERY =
  'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id number url state isDraft title body updatedAt baseRefName headRefName headRefOid author{login}}}}';

const SnapshotData = z.object({
  repository: z
    .object({
      pullRequest: z
        .object({
          id: z.string(),
          number: z.number().int(),
          url: z.string(),
          state: z.string(),
          isDraft: z.boolean(),
          title: z.string(),
          body: z.string(),
          updatedAt: z.string(),
          baseRefName: z.string(),
          headRefName: z.string(),
          headRefOid: z.string(),
          /** null for a deleted account (ghost); absent only in replies recorded before it was queried. */
          author: z.object({ login: z.string() }).nullable().optional(),
        })
        .nullable(),
    })
    .nullable(),
});

export type PrSnapshot = NonNullable<NonNullable<z.infer<typeof SnapshotData>['repository']>['pullRequest']>;

/** The PR as `pr edit` needs it. A missing PR is PR_NOT_FOUND. */
export async function fetchPrSnapshot(gh: Gh, repo: RepoRef, number: number): Promise<PrSnapshot> {
  const data = await gh.graphql(SNAPSHOT_QUERY, { owner: repo.owner, name: repo.name, number }, SnapshotData, {
    repo,
    notFound: 'PR_NOT_FOUND',
  });
  const pr = data.repository?.pullRequest ?? null;
  if (pr === null) {
    throw new GhxError('PR_NOT_FOUND', `No PR #${number} in ${repoSlug(repo)}.`, {
      hint: 'Check the number, or pass the repo: owner/repo#N (or -R owner/repo).',
      details: { repo: repoSlug(repo) },
    });
  }
  return pr;
}

export const CHILDREN_QUERY =
  'query($owner:String!,$name:String!,$head:String!){repository(owner:$owner,name:$name){pullRequests(baseRefName:$head,states:[OPEN],first:20){nodes{number}}}}';

const ChildrenData = z.object({
  repository: z.object({ pullRequests: z.object({ nodes: z.array(z.object({ number: z.number() }).nullable()) }) }),
});

/** Open PRs whose base is `head` (stacked on this PR). */
export async function openChildren(gh: Gh, repo: RepoRef, head: string): Promise<number[]> {
  const data = await gh.graphql(CHILDREN_QUERY, { owner: repo.owner, name: repo.name, head }, ChildrenData, {
    repo,
    notFound: 'REPO_NOT_FOUND',
  });
  return data.repository.pullRequests.nodes.flatMap((n) => (n === null ? [] : [n.number]));
}

export const READY_MUTATION =
  'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}';
export const DRAFT_MUTATION =
  'mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){pullRequest{isDraft}}}';

const DraftResult = z.object({}).loose();

/** `draft:false` replaces `gh pr ready`; `draft:true` converts back. Not retried: the transition is one-way. */
export async function setDraft(gh: Gh, repo: RepoRef, id: string, draft: boolean): Promise<void> {
  await gh.graphql(draft ? DRAFT_MUTATION : READY_MUTATION, { id }, DraftResult, {
    repo,
    mutates: true,
    notFound: 'PR_NOT_FOUND',
  });
}
