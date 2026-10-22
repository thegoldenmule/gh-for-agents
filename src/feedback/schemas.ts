// The folded feedback, as `pr status` and `pr feedback` print it (02 §4.1, §5). They embed these
// schemas in their output, so nothing here may use a transform (test/registry.test.ts).
import { z } from 'zod';
import { Author, Iso, Sha } from '../schemas/common.ts';
import {
  CommentKind,
  ConditionRead,
  FindingStatus,
  PreconditionStatus,
  SeverityRead,
  StatusEvent,
  VerdictRead,
} from '../schemas/pr.ts';

export const ItemSource = z.enum(['issue', 'review', 'inline']);
export const GithubReviewState = z.enum(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING']);

export const Finding = z.object({
  id: z.string(),
  reviewId: z.string(),
  severity: SeverityRead,
  path: z.string().nullable(),
  line: z.number().nullable(),
  endLine: z.number().nullable(),
  alsoAt: z.array(z.object({ path: z.string(), line: z.number() })),
  title: z.string(),
  body: z.string(),
  truncated: z.boolean(),
  /** False for a finding carried in the review body (not placeable in the diff). */
  inline: z.boolean(),
  commit: Sha,
  outdated: z.boolean(),
  status: FindingStatus,
  statusEvent: StatusEvent.nullable(),
  url: z.string(),
});

export const Review = z.object({
  id: z.string(),
  structured: z.boolean(),
  author: Author,
  /** The ghx verdict from the block; null for an unstructured review. */
  verdict: VerdictRead.nullable(),
  githubState: GithubReviewState,
  verdictDowngraded: z.boolean(),
  submittedAt: Iso,
  commit: Sha,
  outdated: z.boolean(),
  summary: z.string(),
  truncated: z.boolean(),
  findingIds: z.array(z.string()),
  url: z.string(),
});

export const Comment = z.object({
  id: z.string(),
  source: ItemSource,
  author: Author,
  at: Iso,
  body: z.string(),
  truncated: z.boolean(),
  structured: z.boolean(),
  /** null for an unstructured comment, and for a structured one of an unknown kind. */
  kind: CommentKind.nullable(),
  path: z.string().nullable(),
  line: z.number().nullable(),
  threadResolved: z.boolean().nullable(),
  inReplyTo: z.string().nullable(),
  edited: z.boolean(),
  blockError: z.string().nullable(),
  url: z.string(),
});

export const BotItem = z.object({
  id: z.string(),
  source: ItemSource,
  author: z.string(),
  at: Iso,
  marker: z.string().nullable(),
  summary: z.string(),
  path: z.string().nullable(),
  line: z.number().nullable(),
  url: z.string(),
});

export const PreconditionOverride = StatusEvent.extend({ status: PreconditionStatus });

export const Precondition = z.object({
  id: z.string(),
  condition: ConditionRead,
  status: PreconditionStatus,
  evidence: z.string(),
  declaredBy: z.string(),
  declaredAt: Iso,
  url: z.string(),
  override: PreconditionOverride.nullable(),
});

export const FeedbackCounts = z.object({
  reviews: z.number(),
  findingsTotal: z.number(),
  findingsOpen: z.number(),
  comments: z.number(),
  bots: z.number(),
  unresolvedHumanThreads: z.number(),
  /** Bodies dropped by the caller's size budget; the fold itself never omits anything. */
  omitted: z.number(),
});

export const Feedback = z.object({
  reviews: z.array(Review),
  findings: z.array(Finding),
  comments: z.array(Comment),
  bots: z.array(BotItem),
  counts: FeedbackCounts,
});

export type Finding = z.infer<typeof Finding>;
export type Review = z.infer<typeof Review>;
export type Comment = z.infer<typeof Comment>;
export type BotItem = z.infer<typeof BotItem>;
export type Precondition = z.infer<typeof Precondition>;
export type PreconditionOverride = z.infer<typeof PreconditionOverride>;
export type FeedbackCounts = z.infer<typeof FeedbackCounts>;
export type Feedback = z.infer<typeof Feedback>;
export type ItemSource = z.infer<typeof ItemSource>;
