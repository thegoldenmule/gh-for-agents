// `pr feedback` filters (02 §5; 03 M6.7), pure. `--open` keeps open findings (isOpenFinding, as in
// openFindings: an addressed one at blocking severity whose commit is unverified counts as open), unresolved human thread comments, unmet preconditions and
// each reviewer's latest standing change request (GitHub's CHANGES_REQUESTED, or a ghx request-changes verdict
// downgraded to COMMENTED on the author's own PR; a later dismissed review clears it, as in merge policy). Under --open,
// outdated findings that do not block merge are dropped unless --include-outdated; one that blocks merge (open at or
// above merge.blockOnSeverity, or addressed there with an unverified commit) is never dropped for being outdated (04).
// Items are filtered, never altered; counts follow the kept lists,
// except unresolvedHumanThreads, which describes the PR.
import { type FoldResult, isOpenFinding } from '../../feedback/fold.ts';
import type { Feedback, Finding, Precondition, Review } from '../../feedback/schemas.ts';
import { type Severity, severityRank } from '../../schemas/pr.ts';

export type FeedbackSource = 'ghx' | 'human' | 'bot';

export interface FeedbackFilter {
  open?: boolean;
  source?: FeedbackSource | undefined;
  /** Epoch ms: keep items newer than this. */
  since?: number | undefined;
  includeOutdated?: boolean;
  /**
   * merge.blockOnSeverity: with --open, an addressed finding at or above it whose commit is unverified
   * counts as open, as merge policy counts it (04). Absent, every unverified one does (fails closed).
   */
  blockOnSeverity?: Severity | undefined;
}

export type FeedbackView = Pick<FoldResult, 'feedback' | 'openFindings' | 'preconditions'>;

const STANDING = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

function requestsChanges(r: Review): boolean {
  return r.githubState === 'CHANGES_REQUESTED' || (r.verdictDowngraded && r.verdict === 'request-changes');
}

/**
 * Each author's latest approving, change-requesting or dismissed review (merge policy's definition), kept
 * if it requests changes: a dismissed latest review clears that author's earlier change request.
 */
function standingChangeRequests(reviews: readonly Review[]): Set<string> {
  const latest = new Map<string, Review>();
  for (const r of reviews) {
    const decisive = STANDING.has(r.githubState) || (r.verdictDowngraded && r.verdict !== null);
    if (!decisive) continue;
    const cur = latest.get(r.author.login);
    if (!cur || Date.parse(r.submittedAt) >= Date.parse(cur.submittedAt)) latest.set(r.author.login, r);
  }
  return new Set([...latest.values()].filter(requestsChanges).map((r) => r.id));
}

/** Blocks merge, as merge policy's blockingFindings reads it: open or unverified, at or above the threshold. */
const blocksMerge = (x: Finding, threshold: Severity | undefined): boolean =>
  isOpenFinding(x, threshold) && severityRank(x.severity) >= severityRank(threshold ?? 'low');

const unmet = (p: Precondition): boolean => p.status !== 'met' && p.status !== 'withdrawn';

export function filterFeedback(v: FeedbackView, f: FeedbackFilter): FeedbackView {
  const fb = v.feedback;
  const newer = (at: string | null | undefined): boolean =>
    f.since === undefined || (at != null && Date.parse(at) > f.since);
  const reviewAt = new Map(fb.reviews.map((r) => [r.id, r.submittedAt]));
  const standing = f.open ? standingChangeRequests(fb.reviews) : null;
  const wants = (s: FeedbackSource): boolean => f.source === undefined || f.source === s;

  const reviews = fb.reviews.filter(
    (r) => wants(r.structured ? 'ghx' : 'human') && newer(r.submittedAt) && (!standing || standing.has(r.id)),
  );
  const findings = fb.findings.filter(
    (x: Finding) =>
      wants('ghx') &&
      (newer(reviewAt.get(x.reviewId)) || newer(x.statusEvent?.at)) &&
      (!f.open ||
        (isOpenFinding(x, f.blockOnSeverity) &&
          (f.includeOutdated || !x.outdated || blocksMerge(x, f.blockOnSeverity)))),
  );
  const comments = fb.comments.filter(
    (c) =>
      wants(c.structured ? 'ghx' : 'human') &&
      newer(c.at) &&
      (!f.open || (c.source === 'inline' && c.threadResolved === false)),
  );
  const bots = fb.bots.filter((b) => wants('bot') && newer(b.at) && !f.open);
  const preconditions = v.preconditions.filter(
    (p) => wants('ghx') && (newer(p.declaredAt) || newer(p.override?.at)) && (!f.open || unmet(p)),
  );
  const kept = new Set(findings.map((x) => x.id));
  const feedback: Feedback = {
    reviews,
    findings,
    comments,
    bots,
    counts: {
      ...fb.counts,
      reviews: reviews.length,
      findingsTotal: findings.length,
      findingsOpen: findings.filter((x) => isOpenFinding(x, f.blockOnSeverity)).length,
      comments: comments.length,
      bots: bots.length,
    },
  };
  return { feedback, openFindings: v.openFindings.filter((id) => kept.has(id)), preconditions };
}
