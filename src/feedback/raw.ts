// The three feedback sources as GraphQL Q1 returns them (02 §4.3): issue comments, reviews and review
// threads. Loose on purpose: the snapshot may ask for more fields than the fold reads. Connections are
// already flattened by the snapshot's pagination, except a thread's `comments { nodes }`.
import { z } from 'zod';
import { Iso } from '../schemas/common.ts';

/** `author` is null for a deleted account ("ghost"). GraphQL bot logins have no `[bot]` suffix. */
export const RawActor = z.looseObject({ __typename: z.string().optional(), login: z.string() });

const common = {
  databaseId: z.number().int(),
  author: RawActor.nullable(),
  authorAssociation: z.string(),
  body: z.string(),
  createdAt: Iso,
  lastEditedAt: Iso.nullable().optional(),
  url: z.string(),
} as const;
const DbRef = z.looseObject({ databaseId: z.number().int() });
const Commit = z.looseObject({ oid: z.string() });

export const RawIssueComment = z.looseObject(common);

export const RawReview = z.looseObject({
  ...common,
  state: z.string(),
  submittedAt: Iso.nullable().optional(),
  commit: Commit.nullable().optional(),
});

export const RawReviewComment = z.looseObject({
  ...common,
  path: z.string(),
  line: z.number().int().nullable().optional(),
  originalLine: z.number().int().nullable().optional(),
  outdated: z.boolean().optional(),
  commit: Commit.nullable().optional(),
  replyTo: DbRef.nullable().optional(),
  pullRequestReview: DbRef.nullable().optional(),
});

export const RawReviewThread = z.looseObject({
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  path: z.string(),
  line: z.number().int().nullable().optional(),
  comments: z.looseObject({ nodes: z.array(RawReviewComment) }),
});

/** The fold's GitHub input, in the shape the snapshot hands over. */
export const RawFeedback = z.looseObject({
  issueComments: z.array(RawIssueComment),
  reviews: z.array(RawReview),
  reviewThreads: z.array(RawReviewThread),
});

export type RawActor = z.infer<typeof RawActor>;
export type RawIssueComment = z.infer<typeof RawIssueComment>;
export type RawReview = z.infer<typeof RawReview>;
export type RawReviewComment = z.infer<typeof RawReviewComment>;
export type RawReviewThread = z.infer<typeof RawReviewThread>;
export type RawFeedback = z.infer<typeof RawFeedback>;
