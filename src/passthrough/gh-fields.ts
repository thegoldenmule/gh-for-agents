// gh pr view --json field names as ghx pr status paths: the redirect (redirect.ts) turns --json into
// --fields with them, and the refusal hint (policy.ts) names the same --fields.

/**
 * gh pr view --json fields as ghx pr status paths; null when pr status has no such field (gh 2.86's
 * field list). `commits` is a count in pr status (changes.commits), a list in gh.
 */
export const GH_PR_FIELDS: Readonly<Record<string, string | null>> = {
  number: 'number',
  title: 'title',
  body: 'description.text',
  state: 'state',
  closed: 'state',
  isDraft: 'draft',
  url: 'url',
  author: 'author',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  baseRefName: 'base.ref',
  headRefName: 'head.ref',
  headRefOid: 'head.sha',
  additions: 'changes.additions',
  deletions: 'changes.deletions',
  changedFiles: 'changes.files',
  commits: 'changes.commits',
  mergeable: 'merge.mergeable',
  mergeStateStatus: 'merge.mergeStateStatus',
  reviewDecision: 'merge.reviewDecision',
  mergedAt: 'merge.mergedAt',
  mergeCommit: 'merge.mergeCommit',
  statusCheckRollup: 'ci',
  reviews: 'feedback.reviews',
  latestReviews: 'feedback.reviews',
  comments: 'feedback.comments',
  assignees: null,
  autoMergeRequest: null,
  baseRefOid: null,
  closedAt: null,
  closingIssuesReferences: null,
  files: null,
  fullDatabaseId: null,
  headRepository: null,
  headRepositoryOwner: null,
  id: null,
  isCrossRepository: null,
  labels: null,
  maintainerCanModify: null,
  mergedBy: null,
  milestone: null,
  potentialMergeCommit: null,
  projectCards: null,
  projectItems: null,
  reactionGroups: null,
  reviewRequests: null,
};

/**
 * --fields paths: gh --json names mapped, and passthrough.json.<gh name> (the passthrough envelope
 * path an agent may carry over) mapped the same way; other paths are kept as typed.
 */
export function mapGhFields(
  json: string | undefined,
  fields: readonly string[] | undefined,
): { paths: string[]; mapped: Record<string, string>; unmapped: string[] } {
  const paths: string[] = [];
  const mapped: Record<string, string> = {};
  const unmapped: string[] = [];
  const add = (gh: string): void => {
    const to = Object.hasOwn(GH_PR_FIELDS, gh) ? GH_PR_FIELDS[gh] : undefined;
    if (to === undefined || to === null) unmapped.push(gh);
    else {
      mapped[gh] = to;
      if (!paths.includes(to)) paths.push(to);
    }
  };
  for (const name of (json ?? '').split(',').map((s) => s.trim())) if (name !== '') add(name);
  for (const raw of (fields ?? []).flatMap((v) => v.split(',')).map((s) => s.trim())) {
    if (raw === '' || raw === 'passthrough' || raw === 'passthrough.json') continue;
    const m = /^passthrough\.json(?:\[\])?\.([A-Za-z]+)/.exec(raw);
    if (m) add(m[1] as string);
    else if (!paths.includes(raw)) paths.push(raw);
  }
  return { paths, mapped, unmapped };
}
