// `pr resolve` rules (02 §7.3, §9.4): which statuses a finding or a precondition takes, which need a note,
// and the `addressed` commit. The commit check uses the PR's commit list (PR_COMMITS_QUERY), the same
// definition the read side re-verifies with, so a write is accepted only if `pr status` will verify it.
// A typed prefix (7–40 hex) is expanded to the full SHA the block stores. GitHub lists at most 250 commits;
// a SHA not among them on a longer PR fails closed with its own message.
import { z } from 'zod';
import type { IssueDetail } from '../../core/errors.ts';
import type { Gh } from '../../gh/index.ts';
import type { RepoRef } from '../../gh/types.ts';
import { PR_COMMITS_CAP, PR_COMMITS_QUERY } from '../snapshot/facts.ts';

export const FINDING_STATUSES = ['addressed', 'wontfix', 'deferred', 'open'] as const;
export const PRECONDITION_STATUSES = ['met', 'withdrawn', 'unmet'] as const;
export const RESOLVE_STATUSES = [...FINDING_STATUSES, ...PRECONDITION_STATUSES] as const;
export type ResolveInputStatus = (typeof RESOLVE_STATUSES)[number];

const NOTE_REQUIRED = new Set<string>(['wontfix', 'deferred', 'met', 'withdrawn']);

/** Rules that need no network: the note and the addressed commit. */
export function offlineResolveIssues(o: {
  status: ResolveInputStatus;
  commit?: string | undefined;
  note?: string | undefined;
}): IssueDetail[] {
  const issues: IssueDetail[] = [];
  if (NOTE_REQUIRED.has(o.status) && !o.note) {
    issues.push({ path: 'note', code: 'resolve.note_required', message: `${o.status} needs --note "<why>"` });
  }
  if (o.status === 'addressed' && !o.commit) {
    issues.push({
      path: 'commit',
      code: 'resolve.commit_required',
      message: 'addressed needs --commit <sha> of the fix, pushed to the PR',
    });
  }
  return issues;
}

/** The status `kind` takes, or an issue. */
export function statusIssue(
  id: string,
  kind: 'finding' | 'precondition',
  status: ResolveInputStatus,
): IssueDetail | null {
  const allowed: readonly string[] = kind === 'finding' ? FINDING_STATUSES : PRECONDITION_STATUSES;
  if (allowed.includes(status)) return null;
  return {
    path: 'status',
    code: 'resolve.status_not_allowed',
    message: `${id} is a ${kind}; it takes ${allowed.join(', ')}, not ${status}`,
  };
}

const PrCommitsData = z.object({
  repository: z
    .object({
      pullRequest: z
        .object({
          headRefOid: z.string(),
          commits: z.object({
            totalCount: z.number().int(),
            pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
            nodes: z.array(z.object({ commit: z.object({ oid: z.string() }) }).nullable()),
          }),
        })
        .nullable(),
    })
    .nullable(),
});

export type CommitCheck = { ok: true; sha: string } | { ok: false; issue: IssueDetail };

/** Expand `prefix` against the PR's commits: reachable from the head and not from the base. */
export async function checkCommitInPr(gh: Gh, repo: RepoRef, number: number, prefix: string): Promise<CommitCheck> {
  const oids: string[] = [];
  let complete = false;
  let after: string | null = null;
  for (let page = 0; page * 100 < PR_COMMITS_CAP; page++) {
    const data: z.infer<typeof PrCommitsData> = await gh.graphql(
      PR_COMMITS_QUERY,
      { owner: repo.owner, name: repo.name, number, after },
      PrCommitsData,
      { repo, notFound: 'PR_NOT_FOUND' },
    );
    const pr = data.repository?.pullRequest;
    if (!pr) break;
    for (const n of pr.commits.nodes) if (n) oids.push(n.commit.oid);
    if (!pr.commits.pageInfo.hasNextPage || !pr.commits.pageInfo.endCursor) {
      complete = oids.length >= pr.commits.totalCount;
      break;
    }
    after = pr.commits.pageInfo.endCursor;
  }
  const matches = oids.filter((oid) => oid.startsWith(prefix));
  if (matches.length === 1) return { ok: true, sha: matches[0] as string };
  if (matches.length > 1) {
    return {
      ok: false,
      issue: {
        path: 'commit',
        code: 'resolve.commit_ambiguous',
        message: `${prefix} matches ${matches.length} commits in the PR; give more characters`,
      },
    };
  }
  return {
    ok: false,
    issue: {
      path: 'commit',
      code: 'resolve.commit_not_in_pr',
      message: complete
        ? `${prefix} is not one of the PR's commits (reachable from the head and not from the base); push the fix first`
        : `${prefix} is not among the first ${PR_COMMITS_CAP} commits GitHub lists for this PR, so ghx cannot verify it`,
    },
  };
}
