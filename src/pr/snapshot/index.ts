// The PR snapshot (03 M6.3): everything `pr status`, `pr merge` and `ci wait --until mergeable` read about a
// PR, in one typed object. Q1, the mergeable retry [G-UNKNOWN], Q2 (stack and precondition refs) and the
// feedback fold with its facts. The CI part is a CiSnapshot; callers add the expected set and the
// shared-with-main verdicts before summarising, then hand everything to the policy engine.
import type { IgnoreRule, NormalisedRollup } from '../../ci/checks.ts';
import { normaliseRollup } from '../../ci/checks.ts';
import type { CiSnapshot } from '../../ci/snapshot.ts';
import type { Clock } from '../../core/clock.ts';
import { isoNow } from '../../core/clock.ts';
import type { BotsConfig } from '../../feedback/bots.ts';
import { displayLogin, isBotAuthor } from '../../feedback/bots.ts';
import { MAX_COMMIT_CHECKS, resolveFacts } from '../../feedback/facts.ts';
import { type FeedbackInput, type FoldResult, foldFeedback } from '../../feedback/fold.ts';
import type { RawFeedback } from '../../feedback/raw.ts';
import type { TrustConfig } from '../../feedback/trust.ts';
import { normalizeAssociation } from '../../feedback/trust.ts';
import type { Gh } from '../../gh/index.ts';
import { formatPrRef } from '../../gh/refs.ts';
import type { RepoRef } from '../../gh/types.ts';
import { type PrBlockResult, readPrBlock } from '../../meta/schemas.ts';
import type { Author, Warning } from '../../schemas/common.ts';
import { type Severity, severityRank } from '../../schemas/pr.ts';
import { snapshotFacts } from './facts.ts';
import {
  MERGEABLE_BUDGET_MS,
  type Mergeable,
  type MergeStateStatus,
  retryMergeable,
  toMergeable,
  toMergeState,
} from './mergeable.ts';
import { fetchQ1, type Q1Result } from './query.ts';
import { buildStack, fetchQ2, type Stack } from './stack.ts';

export type { Mergeable, MergeStateStatus } from './mergeable.ts';
export { MERGE_MERGEABLE_BUDGET_MS, MERGEABLE_BUDGET_MS } from './mergeable.ts';
export { Stack } from './stack.ts';

export const REVIEW_DECISIONS = ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export interface PrSnapshot {
  repo: RepoRef;
  /** owner/repo#N. */
  ref: string;
  number: number;
  url: string;
  title: string;
  body: string;
  author: Author;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  base: { ref: string; sha: string; isDefault: boolean };
  /** `repo` is owner/name of the head repository (null when it was deleted). */
  head: { ref: string; sha: string; repo: string | null; crossRepository: boolean };
  defaultBranch: string;
  changes: { files: number; additions: number; deletions: number; commits: number };
  merge: {
    mergeable: Mergeable;
    /**
     * False when mergeable or mergeStateStatus stayed UNKNOWN (or was not retried); MERGEABLE_UNKNOWN then
     * blocks a merge.
     */
    settled: boolean;
    mergeStateStatus: MergeStateStatus;
    reviewDecision: ReviewDecision | null;
    mergedAt: string | null;
    mergeCommit: string | null;
    /** Mergeable re-queries made. */
    retries: number;
  };
  viewer: { login: string };
  repoSettings: Q1Result['repoSettings'];
  /** The PR body's ghx block, as readPrBlock reads it. */
  meta: PrBlockResult;
  ci: CiSnapshot;
  feedbackInput: FeedbackInput;
  feedback: FoldResult;
  /**
   * More feedback existed than ghx reads (FEEDBACK_TRUNCATED): an unread finding may be open, so merge
   * policy blocks with FEEDBACK_TRUNCATED. Optional so hand-built snapshots stay valid.
   */
  feedbackTruncated?: boolean;
  stack: Stack;
  /** Snapshot warnings (CI_SHA_MISMATCH, MERGEABLE_UNKNOWN, …). Fold warnings are in `feedback.warnings`. */
  warnings: Warning[];
  /** GraphQL calls made. */
  queries: number;
  fetchedAt: string;
}

export interface PrSnapshotConfig {
  ci: { ignore: readonly IgnoreRule[] };
  trust: TrustConfig;
  bots: BotsConfig;
}

export interface FetchPrSnapshotOptions {
  gh: Gh;
  clock: Clock;
  signal?: AbortSignal;
  repo: RepoRef;
  number: number;
  config: PrSnapshotConfig;
  /** Retry an UNKNOWN mergeable (default true; `pr status --no-wait-mergeable` turns it off). */
  waitMergeable?: boolean;
  /** MERGEABLE_BUDGET_MS (20 s) by default; `pr merge` passes MERGE_MERGEABLE_BUDGET_MS (30 s). */
  mergeableBudgetMs?: number;
  /**
   * merge.blockOnSeverity. Addressed events of findings at or above it are all verified, with no cap
   * (04, fail closed); the others share the MAX_COMMIT_CHECKS cap.
   */
  blockOnSeverity?: Severity;
}

/** Fold feedback with facts: blocking-severity addressed commits first and uncapped, then up to 10 others. */
export async function loadSnapshotFeedback(
  input: FeedbackInput,
  resolver: Parameters<typeof resolveFacts>[1],
  blockOnSeverity: Severity,
): Promise<FoldResult> {
  const first = foldFeedback(input);
  if (first.needs.commits.length === 0 && first.needs.conditions.length === 0) return first;
  const threshold = severityRank(blockOnSeverity);
  const blocking = new Set(
    first.feedback.findings
      .filter((f) => f.status === 'addressed' && f.statusEvent?.verified === null && f.statusEvent.commit)
      .filter((f) => severityRank(f.severity) >= threshold)
      .map((f) => f.statusEvent?.commit as string),
  );
  const ordered = [
    ...first.needs.commits.filter((c) => blocking.has(c)),
    ...first.needs.commits.filter((c) => !blocking.has(c)),
  ];
  const facts = await resolveFacts({ commits: ordered, conditions: first.needs.conditions }, resolver, {
    maxCommits: blocking.size + MAX_COMMIT_CHECKS,
  });
  return foldFeedback(input, facts);
}

function authorOf(q1: Q1Result, bots: BotsConfig): Author {
  const actor = q1.pr.author;
  const login = displayLogin(actor);
  return {
    login,
    isViewer: login === q1.viewerLogin || actor?.login === q1.viewerLogin,
    isBot: isBotAuthor(actor, bots),
    association: normalizeAssociation(q1.pr.authorAssociation),
  };
}

function ciSnapshotOf(o: FetchPrSnapshotOptions, q1: Q1Result, warnings: Warning[]): CiSnapshot {
  const pr = q1.pr;
  const base = {
    repo: o.repo,
    number: pr.number,
    prState: pr.state,
    headSha: pr.headRefOid,
    headRef: pr.headRefName,
    baseRef: pr.baseRefName,
    defaultBranch: q1.defaultBranch,
    queries: q1.queries,
  };
  if (q1.rollup === null) {
    warnings.push({
      code: 'CI_SHA_MISMATCH',
      message: `The check rollup is for ${q1.rollupOid?.slice(0, 7) ?? 'no commit'}, not the head ${pr.headRefOid.slice(0, 7)}; CI is reported as pending.`,
    });
    return { ...base, forHeadSha: false, checks: [], ignored: [], runs: {}, truncated: false };
  }
  const norm: NormalisedRollup = normaliseRollup(q1.rollup, {
    repo: o.repo,
    headSha: pr.headRefOid,
    ignore: o.config.ci.ignore,
  });
  return { ...base, forHeadSha: true, ...norm, truncated: q1.checksTruncated };
}

/** Read the PR. A missing PR is PR_NOT_FOUND (the command layer adds the cwd hint, 02 §1.2). */
export async function fetchPrSnapshot(o: FetchPrSnapshotOptions): Promise<PrSnapshot> {
  const warnings: Warning[] = [];
  const warn = (w: Warning) => warnings.push(w);
  let queries = 0;
  let q1: Q1Result;
  let settled: boolean;
  let mergeable: Mergeable;
  let mergeStateStatus: MergeStateStatus;
  let retries = 0;
  let closedMidRetry: 'CLOSED' | 'MERGED' | undefined;
  for (let restart = 0; ; restart++) {
    warnings.length = 0;
    q1 = await fetchQ1({ gh: o.gh, repo: o.repo, number: o.number, warn });
    queries += q1.queries;
    mergeable = toMergeable(q1.pr.mergeable);
    mergeStateStatus = toMergeState(q1.pr.mergeStateStatus);
    settled = mergeable !== 'UNKNOWN' && mergeStateStatus !== 'UNKNOWN';
    if (settled || q1.pr.state !== 'OPEN' || o.waitMergeable === false) break;
    const budgetMs = o.mergeableBudgetMs ?? MERGEABLE_BUDGET_MS;
    const r = await retryMergeable({
      gh: o.gh,
      clock: o.clock,
      repo: o.repo,
      number: o.number,
      headSha: q1.pr.headRefOid,
      budgetMs,
      ...(o.signal ? { signal: o.signal } : {}),
    });
    queries += r.queries;
    retries += r.queries;
    if (r.kind === 'head-changed' && restart === 0) continue; // restart the whole read once
    // Merged or closed mid-retry: re-read, so state, mergedAt and mergeCommit are current (pr merge's
    // already-merged path). Bounded: a PR that keeps flipping falls back to the retry's state.
    if (r.kind === 'not-open' && restart < 2) continue;
    if (r.kind === 'not-open') closedMidRetry = r.state;
    if (r.kind === 'settled') {
      mergeable = r.mergeable;
      mergeStateStatus = r.mergeStateStatus;
      settled = true;
    } else if (r.kind === 'unknown') {
      mergeStateStatus = r.mergeStateStatus;
      mergeable = r.mergeable ?? mergeable;
      const what = mergeable === 'UNKNOWN' ? 'mergeable' : 'mergeStateStatus';
      warn({
        code: 'MERGEABLE_UNKNOWN',
        message: `GitHub still reports ${what} UNKNOWN after ${budgetMs / 1000} s; re-run to check again.`,
      });
    } else if (r.kind === 'head-changed') {
      warn({
        code: 'HEAD_CHANGED',
        message: `The head moved again (now ${r.headSha.slice(0, 7)}) while mergeability was computed; re-run.`,
      });
    }
    break;
  }

  const pr = q1.pr;
  const meta = readPrBlock(pr.body);
  const raw: RawFeedback = {
    issueComments: q1.issueComments,
    reviews: q1.reviews,
    reviewThreads: q1.threads,
  };
  const feedbackInput: FeedbackInput = {
    ...raw,
    viewerLogin: q1.viewerLogin,
    headSha: pr.headRefOid,
    config: { trust: o.config.trust, bots: o.config.bots },
  };
  const firstFold = foldFeedback(feedbackInput);
  const q2 = await fetchQ2({
    gh: o.gh,
    repo: o.repo,
    baseRef: pr.baseRefName,
    headRef: pr.headRefName,
    defaultBranch: q1.defaultBranch,
    crossRepository: pr.isCrossRepository,
    conditions: firstFold.needs.conditions,
  });
  queries += q2.queries;
  const resolver = snapshotFacts({
    gh: o.gh,
    repo: o.repo,
    number: pr.number,
    headSha: pr.headRefOid,
    refs: q2.refs,
    onQuery: () => {
      queries++;
    },
  });
  const feedback = await loadSnapshotFeedback(feedbackInput, resolver, o.blockOnSeverity ?? 'high');

  const reviewDecision = (REVIEW_DECISIONS as readonly string[]).includes(pr.reviewDecision ?? '')
    ? (pr.reviewDecision as ReviewDecision)
    : null;
  return {
    repo: o.repo,
    ref: formatPrRef(o.repo, pr.number),
    number: pr.number,
    url: pr.url,
    title: pr.title,
    body: pr.body,
    author: authorOf(q1, o.config.bots),
    state: closedMidRetry ?? pr.state,
    draft: pr.isDraft,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    base: { ref: pr.baseRefName, sha: pr.baseRefOid, isDefault: pr.baseRefName === q1.defaultBranch },
    head: {
      ref: pr.headRefName,
      sha: pr.headRefOid,
      repo: pr.headRepository?.nameWithOwner ?? null,
      crossRepository: pr.isCrossRepository,
    },
    defaultBranch: q1.defaultBranch,
    changes: {
      files: pr.changedFiles,
      additions: pr.additions,
      deletions: pr.deletions,
      commits: pr.commitCount.totalCount,
    },
    merge: {
      mergeable,
      settled,
      mergeStateStatus,
      reviewDecision,
      mergedAt: pr.mergedAt,
      mergeCommit: pr.mergeCommit?.oid ?? null,
      retries,
    },
    viewer: { login: q1.viewerLogin },
    repoSettings: q1.repoSettings,
    meta,
    ci: ciSnapshotOf(o, q1, warnings),
    feedbackInput,
    feedback,
    feedbackTruncated: q1.feedbackTruncated,
    stack: buildStack({
      q2,
      stackedOn: meta.status === 'ok' ? meta.block.refs?.stackedOn : undefined,
      repo: o.repo,
      timeline: q1.timeline,
    }),
    warnings,
    queries,
    fetchedAt: isoNow(o.clock),
  };
}
