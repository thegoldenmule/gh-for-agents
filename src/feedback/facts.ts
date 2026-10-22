// Network facts for the fold, behind an injected resolver so the fold itself stays pure: whether an
// `addressed` commit is still in the PR (02 §9.4) and whether a pr-merged or release-includes condition
// holds (02 §4.3 steps 5 and 8). Fold, resolve what it reports in `needs`, fold again.
import {
  type ConditionFact,
  conditionKey,
  type FactNeeds,
  type FeedbackInput,
  type FoldFacts,
  type FoldResult,
  foldFeedback,
  type NetworkCondition,
} from './fold.ts';

export interface FeedbackFactsResolver {
  /** Reachable from the PR head and not from its base? null when it can't tell (e.g. compare failed). */
  commitInPr(sha: string): Promise<boolean | null>;
  condition(c: NetworkCondition): Promise<ConditionFact>;
}

/** 02 §4.3: verify at most 10 `addressed` commits per read. The rest stay `verified:null`. */
export const MAX_COMMIT_CHECKS = 10;

export async function resolveFacts(
  needs: FactNeeds,
  resolver: FeedbackFactsResolver,
  o: { maxCommits?: number } = {},
): Promise<FoldFacts> {
  const shas = needs.commits.slice(0, o.maxCommits ?? MAX_COMMIT_CHECKS);
  const conditions = [...new Map(needs.conditions.map((c) => [conditionKey(c), c])).values()];
  const [commitResults, conditionResults] = await Promise.all([
    Promise.all(shas.map(async (sha) => [sha, await resolver.commitInPr(sha)] as const)),
    Promise.all(conditions.map(async (c) => [conditionKey(c), await resolver.condition(c)] as const)),
  ]);
  return { commits: new Map(commitResults), conditions: new Map(conditionResults) };
}

/** foldFeedback with its network facts resolved: the one call `pr status`, `pr feedback` and `pr merge` make. */
export async function loadFeedback(
  input: FeedbackInput,
  resolver: FeedbackFactsResolver,
  o: { maxCommits?: number } = {},
): Promise<FoldResult> {
  const first = foldFeedback(input);
  if (first.needs.commits.length === 0 && first.needs.conditions.length === 0) return first;
  return foldFeedback(input, await resolveFacts(first.needs, resolver, o));
}
