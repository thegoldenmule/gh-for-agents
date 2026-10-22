// The FeedbackFactsResolver behind the snapshot's feedback fold (02 §4.3 steps 5 and 8; 02 §9.4).
// - commitInPr: is the SHA one of the PR's commits (reachable from the head, not from the base)? The PR's
//   commit list is read once, lazily, by GraphQL; GitHub lists at most 250, so beyond that it is null.
// - pr-merged comes from Q2's ref aliases. release-includes reads the ref repo's latest release and
//   compares its tag with the ref's merge commit. Any failure is `unknown`, which policy treats as unmet.
import { z } from 'zod';
import { rethrowControlFlow } from '../../core/control-flow.ts';
import type { FeedbackFactsResolver } from '../../feedback/facts.ts';
import type { ConditionFact, NetworkCondition } from '../../feedback/fold.ts';
import type { Gh } from '../../gh/index.ts';
import type { RepoRef } from '../../gh/types.ts';
import { parsePrRef, type RefPr } from './stack.ts';

/** GitHub's cap on a PR's listed commits. */
export const PR_COMMITS_CAP = 250;

export const PR_COMMITS_QUERY =
  'query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){' +
  'pullRequest(number:$number){headRefOid commits(first:100,after:$after){totalCount ' +
  'pageInfo{hasNextPage endCursor} nodes{commit{oid}}}}}}';

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

const Release = z.object({ tag_name: z.string() });
const Compare = z.object({ status: z.string(), behind_by: z.number().int() });

export interface SnapshotFactsOptions {
  gh: Gh;
  repo: RepoRef;
  number: number;
  headSha: string;
  /** Q2's owner/repo#N → PR map. */
  refs: ReadonlyMap<string, RefPr | null>;
  onQuery?: () => void;
}

interface PrCommits {
  oids: Set<string>;
  complete: boolean;
}

export function snapshotFacts(o: SnapshotFactsOptions): FeedbackFactsResolver {
  let commitsP: Promise<PrCommits | null> | undefined;
  const loadCommits = async (): Promise<PrCommits | null> => {
    const oids = new Set<string>();
    let after: string | null = null;
    for (let page = 0; page * 100 < PR_COMMITS_CAP; page++) {
      o.onQuery?.();
      const data: z.infer<typeof PrCommitsData> = await o.gh.graphql(
        PR_COMMITS_QUERY,
        { owner: o.repo.owner, name: o.repo.name, number: o.number, after },
        PrCommitsData,
        { repo: o.repo, notFound: 'PR_NOT_FOUND' },
      );
      const pr = data.repository?.pullRequest;
      // The head moved since the snapshot: this list says nothing about the snapshot's head.
      if (!pr || pr.headRefOid !== o.headSha) return null;
      for (const n of pr.commits.nodes) if (n) oids.add(n.commit.oid);
      if (!pr.commits.pageInfo.hasNextPage || !pr.commits.pageInfo.endCursor) {
        return { oids, complete: oids.size >= pr.commits.totalCount };
      }
      after = pr.commits.pageInfo.endCursor;
    }
    return { oids, complete: false };
  };

  const refFact = (ref: string): { pr: RefPr | null; known: boolean } => {
    const p = parsePrRef(ref, o.repo);
    const full = p ? `${p.repo.owner}/${p.repo.name}#${p.number}` : ref;
    return { pr: o.refs.get(full) ?? null, known: o.refs.has(full) };
  };

  async function releaseIncludes(c: NetworkCondition, pr: RefPr): Promise<ConditionFact> {
    const target = parsePrRef(c.ref, o.repo);
    if (!target) return { status: 'unknown', evidence: `${c.ref} is not a PR ref` };
    if (pr.state !== 'MERGED' || !pr.mergeCommit) return { status: 'unmet', evidence: `${c.ref} is not merged` };
    o.onQuery?.();
    const rel = await o.gh
      .api({ path: 'repos/{owner}/{repo}/releases/latest', repo: target.repo }, Release, { notFound: 'REF_NOT_FOUND' })
      .catch((e: unknown) => {
        rethrowControlFlow(e);
        if (e instanceof Error && 'code' in e && e.code === 'REF_NOT_FOUND') return null;
        throw e;
      });
    if (rel === null)
      return { status: 'unmet', evidence: `no release yet in ${target.repo.owner}/${target.repo.name}` };
    if (rel.notModified) return { status: 'unknown', evidence: 'releases/latest returned 304' };
    const tag = rel.data.tag_name;
    o.onQuery?.();
    const cmp = await o.gh.api(
      {
        path: `repos/{owner}/{repo}/compare/${pr.mergeCommit.oid}...${encodeURIComponent(tag)}`,
        repo: target.repo,
        fields: { per_page: 1 },
      },
      Compare,
      { notFound: 'REF_NOT_FOUND' },
    );
    if (cmp.notModified) return { status: 'unknown', evidence: 'compare returned 304' };
    return cmp.data.behind_by === 0
      ? { status: 'met', evidence: `${tag} includes ${c.ref}` }
      : { status: 'unmet', evidence: `the latest release ${tag} does not include ${c.ref}` };
  }

  return {
    async commitInPr(sha) {
      commitsP ??= loadCommits().catch((e: unknown) => {
        rethrowControlFlow(e);
        return null;
      });
      const commits = await commitsP;
      if (!commits) return null;
      if ([...commits.oids].some((oid) => oid.startsWith(sha))) return true;
      return commits.complete ? false : null;
    },
    async condition(c) {
      const { pr, known } = refFact(c.ref);
      if (!known) return { status: 'unknown', evidence: `${c.ref} was not looked up` };
      if (!pr) return { status: 'unknown', evidence: `${c.ref} was not found` };
      if (c.type === 'pr-merged') {
        if (pr.state === 'MERGED')
          return { status: 'met', evidence: `${c.ref} merged at ${pr.mergedAt ?? 'unknown time'}` };
        return {
          status: 'unmet',
          evidence: pr.state === 'CLOSED' ? `${c.ref} was closed without merging` : `${c.ref} is open`,
        };
      }
      try {
        return await releaseIncludes(c, pr);
      } catch (e) {
        rethrowControlFlow(e);
        return { status: 'unknown', evidence: `could not check the latest release: ${(e as Error).message}` };
      }
    },
  };
}
