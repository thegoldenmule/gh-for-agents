// The feedback fold (02 §4.1 folding rules; brief 7): GitHub's three sources in, one object out. Pure.
// Every GitHub item lands in exactly one of reviews, findings (inline), comments or bots; nothing is dropped.
// A COMMENTED review with an empty body is only the container GitHub makes for inline comments and thread
// replies: it is not listed, its comments are. Body-only findings are derived from their review's body.
// Order: reviews by submittedAt; findings in their review's order; comments and bots by source (inline,
// review, issue), then createdAt, then databaseId. Network facts come in through `facts` (see facts.ts).
import { strip } from '../meta/codec.ts';
import {
  type BlockRead,
  type CommentBlockRead,
  type FindingBlockRead,
  type ReviewBlockRead,
  readBlocks,
} from '../meta/schemas.ts';
import type { Author, Warning } from '../schemas/common.ts';
import { type Condition, type PreconditionStatus, SEVERITY_ORDER, type Severity, severityRank } from '../schemas/pr.ts';
import { type BotsConfig, botSummary, displayLogin, isBotAuthor, isBotItem, markerOf } from './bots.ts';
import { compareEvents, foldEvents, type ResolveEvent, type TargetKind } from './events.ts';
import type { RawActor, RawIssueComment, RawReview, RawReviewComment, RawReviewThread } from './raw.ts';
import {
  type BotItem,
  type Comment,
  type Feedback,
  type Finding,
  GithubReviewState,
  type ItemSource,
  type Precondition,
  type Review,
} from './schemas.ts';
import { normalizeAssociation, type TrustConfig, trustOf } from './trust.ts';

export interface FeedbackInput {
  issueComments: readonly RawIssueComment[];
  reviews: readonly RawReview[];
  reviewThreads: readonly RawReviewThread[];
  viewerLogin: string;
  headSha: string;
  config: { trust: TrustConfig; bots: BotsConfig };
}

/** A condition only the network can evaluate. `manual` waits for `pr resolve`; unknown types stay unknown. */
export type NetworkCondition = Extract<Condition, { type: 'pr-merged' | 'release-includes' }>;
export interface ConditionFact {
  status: Extract<PreconditionStatus, 'met' | 'unmet' | 'unknown'>;
  evidence: string;
}
export interface FoldFacts {
  /** SHA → reachable from the head and not from the base; null = could not tell. */
  commits?: ReadonlyMap<string, boolean | null>;
  /** conditionKey(c) → evaluation. */
  conditions?: ReadonlyMap<string, ConditionFact>;
}
export interface FactNeeds {
  commits: string[];
  conditions: NetworkCondition[];
}

export interface FoldResult {
  feedback: Feedback;
  openFindings: string[];
  preconditions: Precondition[];
  warnings: Warning[];
  /** Facts this fold lacked. Resolve them (resolveFacts) and fold again. */
  needs: FactNeeds;
}

export const conditionKey = (c: NetworkCondition): string => `${c.type}:${c.ref}`;

/** The severity policy should use: an unknown value counts as high (02 §9.3, fails closed). */
export function effectiveSeverity(severity: string): Severity {
  return SEVERITY_ORDER[severityRank(severity)] ?? 'high';
}

// ── Items ─────────────────────────────────────────────────────────────────
interface Item {
  source: ItemSource;
  key: string;
  databaseId: number;
  actor: RawActor | null;
  association: string;
  body: string;
  at: string;
  url: string;
  edited: boolean;
  review?: RawReview;
  thread?: RawReviewThread;
  comment?: RawReviewComment;
}

type Placement =
  | { as: 'container' }
  | { as: 'bot' }
  | { as: 'review'; block: ReviewBlockRead; findings: FindingBlockRead[] }
  | { as: 'finding'; block: FindingBlockRead }
  | { as: 'comment'; id: string; block: CommentBlockRead | null }
  | { as: 'unstructured'; blockError: string | null };

const SOURCE_RANK: Record<ItemSource, number> = { inline: 0, review: 1, issue: 2 };

function base(source: ItemSource, prefix: string, r: RawIssueComment | RawReview | RawReviewComment, at: string): Item {
  return {
    source,
    key: `${prefix}:${r.databaseId}`,
    databaseId: r.databaseId,
    actor: r.author,
    association: r.authorAssociation,
    body: r.body,
    at,
    url: r.url,
    edited: r.lastEditedAt != null,
  };
}

function collect(input: FeedbackInput): Item[] {
  const items: Item[] = [];
  for (const thread of input.reviewThreads) {
    for (const comment of thread.comments.nodes) {
      items.push({ ...base('inline', 'rc', comment, comment.createdAt), thread, comment });
    }
  }
  for (const review of input.reviews) {
    items.push({ ...base('review', 'rv', review, review.submittedAt ?? review.createdAt), review });
  }
  for (const c of input.issueComments) items.push(base('issue', 'ic', c, c.createdAt));
  return items;
}

// ── Classification ────────────────────────────────────────────────────────
type Pick =
  | { ok: true; placement: Exclude<Placement, { as: 'container' | 'bot' | 'unstructured' }>; used: BlockRead[] }
  | { ok: false; error: string | null };

function pickBlock(item: Item, blocks: BlockRead[]): Pick {
  if (item.source === 'review') {
    const review = blocks.find((b) => b.status === 'ok' && b.block.t === 'review');
    if (review?.status === 'ok' && review.block.t === 'review') {
      const findings = blocks.filter((b) => b.status === 'ok' && b.block.t === 'finding');
      return {
        ok: true,
        placement: {
          as: 'review',
          block: review.block,
          findings: findings.map((b) => (b as { block: FindingBlockRead }).block),
        },
        used: [review, ...findings],
      };
    }
    const invalid = blocks.find((b) => b.status === 'invalid');
    if (invalid?.status === 'invalid') return { ok: false, error: invalid.error };
    const other = blocks.find((b) => b.status === 'ok');
    return { ok: false, error: other?.status === 'ok' ? `unexpected ${other.block.t} block in a review body` : null };
  }
  const b = blocks[blocks.length - 1];
  if (!b) return { ok: false, error: null };
  if (b.status === 'invalid') return { ok: false, error: b.error };
  if (b.status === 'unknown-type') return { ok: true, placement: { as: 'comment', id: b.id, block: null }, used: [b] };
  if (b.block.t === 'comment')
    return { ok: true, placement: { as: 'comment', id: b.block.id, block: b.block }, used: [b] };
  if (b.block.t === 'finding' && item.source === 'inline') {
    return { ok: true, placement: { as: 'finding', block: b.block }, used: [b] };
  }
  return { ok: false, error: `unexpected ${b.block.t} block in an ${item.source} comment` };
}

const isContainer = (item: Item, blocks: BlockRead[]) =>
  item.source === 'review' && item.review?.state === 'COMMENTED' && blocks.length === 0 && item.body.trim() === '';

function placementId(item: Item, p: Placement): string {
  if (p.as === 'review' || p.as === 'finding') return p.block.id;
  if (p.as === 'comment') return p.id;
  return item.key;
}

function classifyAll(input: FeedbackInput, items: Item[], warnings: Warning[]): Map<Item, Placement> {
  const out = new Map<Item, Placement>();
  const seen = new Set<string>();
  const unstructuredOrBot = (item: Item, blockError: string | null): Placement =>
    isBotItem(item.actor, item.body, input.config.bots) ? { as: 'bot' } : { as: 'unstructured', blockError };

  for (const item of [...items].sort((a, b) => compareEvents(a, b))) {
    const blocks = readBlocks(item.body);
    if (isContainer(item, blocks)) {
      out.set(item, { as: 'container' });
      continue;
    }
    if (blocks.length === 0) {
      out.set(item, unstructuredOrBot(item, null));
      continue;
    }
    const login = displayLogin(item.actor);
    const trust = trustOf(login, item.association, input.config.trust, item.actor);
    if (!trust.trusted) {
      warnings.push({
        code: 'UNTRUSTED_BLOCK',
        message: `Ignored the ghx block on ${item.key}: ${trust.reason} is not in trust.associations or trust.bots.`,
      });
      out.set(item, unstructuredOrBot(item, trust.reason));
      continue;
    }
    for (const b of blocks) {
      if (b.status !== 'invalid') continue;
      if (b.code === 'SCHEMA_NEWER') {
        warnings.push({ code: 'SCHEMA_NEWER', message: `${item.key} has a ${b.error} block; upgrade ghx to read it.` });
      } else {
        // A trusted author's broken block must not vanish: policy would fail open (02 §9.3).
        warnings.push({ code: 'BLOCK_INVALID', message: `${item.key} has an unreadable ghx block (${b.error}).` });
      }
    }
    const pick = pickBlock(item, blocks);
    if (!pick.ok) {
      out.set(item, unstructuredOrBot(item, pick.error));
      continue;
    }
    const id = placementId(item, pick.placement);
    if (seen.has(id)) {
      warnings.push({ code: 'DUPLICATE_BLOCK', message: `${item.key} reuses block id ${id}; read as unstructured.` });
      out.set(item, unstructuredOrBot(item, `duplicate block id ${id}`));
      continue;
    }
    seen.add(id);
    if (pick.placement.as === 'review') {
      pick.placement.findings = pick.placement.findings.filter((f) => {
        if (!seen.has(f.id)) return seen.add(f.id);
        warnings.push({ code: 'DUPLICATE_BLOCK', message: `${item.key} repeats finding id ${f.id}; ignored.` });
        return false;
      });
    }
    for (const b of pick.used) if (b.status !== 'invalid') warnings.push(...b.warnings);
    out.set(item, pick.placement);
  }
  return out;
}

// ── Output builders ───────────────────────────────────────────────────────
function authorOf(item: Item, input: FeedbackInput): Author {
  const login = displayLogin(item.actor);
  return {
    login,
    isViewer: login === input.viewerLogin || item.actor?.login === input.viewerLogin,
    isBot: isBotAuthor(item.actor, input.config.bots),
    association: normalizeAssociation(item.association),
  };
}

function inlineLocation(item: Item): { path: string | null; line: number | null } {
  if (!item.comment || !item.thread) return { path: null, line: null };
  return {
    path: item.comment.path ?? item.thread.path,
    line: item.comment.line ?? item.comment.originalLine ?? item.thread.line ?? null,
  };
}

const sortItems = <T extends { item: Item }>(xs: T[]) =>
  xs.sort((a, b) => SOURCE_RANK[a.item.source] - SOURCE_RANK[b.item.source] || compareEvents(a.item, b.item));

/** Fold the three sources. Pure; pass `facts` from resolveFacts for verified commits and conditions. */
export function foldFeedback(input: FeedbackInput, facts: FoldFacts = {}): FoldResult {
  const warnings: Warning[] = [];
  const items = collect(input);
  const placed = classifyAll(input, items, warnings);
  const idOf = new Map<string, string>();
  for (const [item, p] of placed) idOf.set(item.key, placementId(item, p));

  const reviews: { item: Item; review: Review }[] = [];
  const findings: { item: Item; finding: Omit<Finding, 'status' | 'statusEvent'> }[] = [];
  const comments: { item: Item; comment: Comment; block: CommentBlockRead | null }[] = [];
  const bots: { item: Item; bot: BotItem }[] = [];

  for (const [item, p] of placed) {
    const loc = inlineLocation(item);
    if (p.as === 'container') continue;
    if (p.as === 'bot') {
      bots.push({
        item,
        bot: {
          id: item.key,
          source: item.source,
          author: displayLogin(item.actor),
          at: item.at,
          marker: markerOf(item.body, input.config.bots),
          summary: botSummary(item.body),
          ...loc,
          url: item.url,
        },
      });
    } else if (item.source === 'review' && (p.as === 'review' || p.as === 'unstructured')) {
      const raw = item.review as RawReview;
      const block = p.as === 'review' ? p.block : null;
      const state = GithubReviewState.safeParse(raw.state);
      const githubState = state.success ? state.data : 'COMMENTED';
      const commit = raw.commit?.oid ?? block?.commit ?? input.headSha;
      reviews.push({
        item,
        review: {
          id: idOf.get(item.key) ?? item.key,
          structured: block !== null,
          author: authorOf(item, input),
          verdict: block?.verdict ?? null,
          githubState,
          verdictDowngraded:
            block !== null && ['approve', 'request-changes'].includes(block.verdict) && githubState === 'COMMENTED',
          submittedAt: item.at,
          commit,
          outdated: commit !== input.headSha,
          summary: block?.summary ?? strip(item.body),
          truncated: false,
          findingIds: block?.findings ?? [],
          url: item.url,
        },
      });
      if (p.as === 'review') {
        for (const f of p.findings)
          findings.push({ item, finding: findingOf(f, false, f.commit !== input.headSha, item.url) });
      }
    } else if (p.as === 'finding') {
      const outdated = (item.thread?.isOutdated ?? false) || (item.comment?.outdated ?? false);
      findings.push({ item, finding: findingOf(p.block, true, outdated, item.url) });
    } else {
      const structured = p.as === 'comment';
      const replyTo = item.comment?.replyTo?.databaseId;
      comments.push({
        item,
        block: structured ? p.block : null,
        comment: {
          id: idOf.get(item.key) ?? item.key,
          source: item.source,
          author: authorOf(item, input),
          at: item.at,
          body: strip(item.body),
          truncated: false,
          structured,
          kind: structured ? (p.block?.kind ?? null) : null,
          ...loc,
          threadResolved: item.thread ? item.thread.isResolved : null,
          inReplyTo: replyTo === undefined ? null : (idOf.get(`rc:${replyTo}`) ?? `rc:${replyTo}`),
          edited: item.edited,
          blockError: p.as === 'unstructured' ? p.blockError : null,
          url: item.url,
        },
      });
    }
  }

  // A finding a structured review lists but no valid block carries (invalid, untrusted or deleted) stays
  // visible as an open placeholder of unknown severity, which policy ranks as high (fails closed).
  const haveFinding = new Set(findings.map((f) => f.finding.id));
  for (const { item, review } of reviews) {
    for (const fid of review.findingIds) {
      if (haveFinding.has(fid)) continue;
      haveFinding.add(fid);
      warnings.push({
        code: 'BLOCK_INVALID',
        message: `Review ${review.id} lists finding ${fid}, but no valid finding block has that id; it counts as open with unknown severity.`,
      });
      findings.push({ item, finding: placeholderFinding(fid, review) });
    }
  }

  sortItems(reviews);
  sortItems(comments);
  sortItems(bots);
  const position = new Map<string, number>();
  for (const [i, r] of reviews.entries()) {
    for (const [j, fid] of r.review.findingIds.entries()) position.set(fid, i * 1000 + j);
  }
  findings.sort((a, b) => {
    const pa = position.get(a.finding.id) ?? Number.MAX_SAFE_INTEGER;
    const pb = position.get(b.finding.id) ?? Number.MAX_SAFE_INTEGER;
    return pa - pb || compareEvents(a.item, b.item);
  });

  // Status events and preconditions.
  const declared = comments.filter((c) => c.block?.kind === 'precondition');
  const targets = new Map<string, TargetKind>([
    ...findings.map((f) => [f.finding.id, 'finding'] as const),
    ...declared.map((c) => [c.comment.id, 'precondition'] as const),
  ]);
  const events: ResolveEvent[] = comments.flatMap(({ item, comment, block }) =>
    block?.kind === 'resolve'
      ? [
          {
            id: comment.id,
            by: comment.author.login,
            at: item.at,
            databaseId: item.databaseId,
            url: item.url,
            targets: block.targets,
          },
        ]
      : [],
  );
  const ev = foldEvents(events, targets, facts.commits);
  warnings.push(...ev.warnings);

  const needs: FactNeeds = { commits: [...new Set(ev.unverifiedCommits)], conditions: [] };
  const outFindings: Finding[] = findings.map(({ finding }) => {
    const s = ev.findings.get(finding.id);
    return { ...finding, status: s?.status ?? 'open', statusEvent: s?.event ?? null };
  });
  const preconditions: Precondition[] = declared.map(({ comment, block }) => {
    const condition = (block as Extract<CommentBlockRead, { kind: 'precondition' }>).condition;
    const override = ev.preconditions.get(comment.id);
    const common = {
      id: comment.id,
      condition,
      declaredBy: comment.author.login,
      declaredAt: comment.at,
      url: comment.url,
    };
    if (override) {
      const note = override.event.note ? `: ${override.event.note}` : '';
      return {
        ...common,
        status: override.status,
        evidence: `${override.status} by ${override.event.by}${note}`,
        override: { ...override.event, status: override.status },
      };
    }
    return { ...common, ...evaluate(condition, comment.id, facts, needs), override: null };
  });

  const placementOf = new Map([...placed].map(([item, p]) => [item.key, p]));
  const unresolvedHumanThreads = input.reviewThreads.filter((t) => {
    const root = t.comments.nodes[0];
    const p = root && placementOf.get(`rc:${root.databaseId}`);
    return !t.isResolved && (p?.as === 'unstructured' || p?.as === 'comment');
  }).length;

  const openFindings = outFindings.filter((f) => f.status === 'open').map((f) => f.id);
  return {
    feedback: {
      reviews: reviews.map((r) => r.review),
      findings: outFindings,
      comments: comments.map((c) => c.comment),
      bots: bots.map((b) => b.bot),
      counts: {
        reviews: reviews.length,
        findingsTotal: outFindings.length,
        findingsOpen: openFindings.length,
        comments: comments.length,
        bots: bots.length,
        unresolvedHumanThreads,
        omitted: 0,
      },
    },
    openFindings,
    preconditions,
    warnings,
    needs,
  };
}

function findingOf(
  f: FindingBlockRead,
  inline: boolean,
  outdated: boolean,
  url: string,
): Omit<Finding, 'status' | 'statusEvent'> {
  return {
    id: f.id,
    reviewId: f.review,
    severity: f.severity,
    path: f.path,
    line: f.line,
    endLine: f.endLine ?? null,
    alsoAt: (f.alsoAt ?? []).map((l) => ({ path: l.path, line: l.line })),
    title: f.title,
    body: f.body,
    truncated: false,
    inline,
    commit: f.commit,
    outdated,
    url,
  };
}

function placeholderFinding(id: string, review: Review): Omit<Finding, 'status' | 'statusEvent'> {
  return {
    id,
    reviewId: review.id,
    severity: 'unknown',
    path: null,
    line: null,
    endLine: null,
    alsoAt: [],
    title: `Finding ${id} could not be read`,
    body: `Review ${review.id} lists this finding, but its block is missing or invalid. It counts as open, with unknown severity, until resolved.`,
    truncated: false,
    inline: false,
    commit: review.commit,
    outdated: review.outdated,
    url: review.url,
  };
}

function evaluate(
  condition: { type: string; [k: string]: unknown },
  id: string,
  facts: FoldFacts,
  needs: FactNeeds,
): ConditionFact {
  if (condition.type === 'manual') {
    return { status: 'unknown', evidence: `manual: waiting for ghx pr resolve ${id} --status met --note "…"` };
  }
  if (condition.type === 'pr-merged' || condition.type === 'release-includes') {
    const c = condition as NetworkCondition;
    const fact = facts.conditions?.get(conditionKey(c));
    if (fact) return fact;
    needs.conditions.push(c);
    return { status: 'unknown', evidence: 'not evaluated' };
  }
  return { status: 'unknown', evidence: `unknown condition type "${condition.type}"` };
}
