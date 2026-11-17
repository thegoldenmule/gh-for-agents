// Output schemas for the policy engine (02 §4.1 MergeState, §8.3 MergePlan). pr status embeds MergeState,
// pr merge prints MergePlan, ci wait --until mergeable summarises both. No transforms (JSON Schema export).
import { z } from 'zod';
import { MergeMethod } from '../config/sections/_shared.ts';
import { Iso, PrRef, Sha } from '../schemas/common.ts';
import { Violation } from '../schemas/pr.ts';

export const PlanCheckStatus = z.enum(['pass', 'fail', 'waived', 'overridden', 'warn', 'skipped']);
export const PlanCheck = z.object({ code: z.string(), status: PlanCheckStatus, message: z.string() });

export const MergeOverride = z.object({ code: z.string(), reason: z.string() });

export const MergeQueueState = z.object({
  required: z
    .boolean()
    .describe('The base branch merges only through its merge queue: pr merge and pr land add the PR to it'),
  method: MergeMethod.nullable().describe('How the queue merges (it decides, not --method); null when not reported'),
  queued: z.boolean().describe('The PR is in the queue'),
  state: z
    .string()
    .nullable()
    .describe('QUEUED, AWAITING_CHECKS, MERGEABLE, UNMERGEABLE or LOCKED; null when the PR is not in the queue'),
  position: z.number().int().nullable().describe('Its place in the queue; null when the PR is not in it'),
  enqueuedAt: Iso.nullable(),
  url: z.string().nullable(),
});

export const MergeRequestPlan = z.object({
  method: z.enum(['PUT', 'POST']).describe('PUT: the REST merge. POST: the GraphQL enqueuePullRequest mutation'),
  path: z.string().describe('The REST path, or graphql'),
  body: z.record(z.string(), z.unknown()),
});

export const MergePlan = z.object({
  ref: PrRef,
  headSha: Sha,
  method: MergeMethod,
  via: z
    .enum(['merge', 'queue'])
    .describe('merge: a direct merge. queue: the base branch has a merge queue, so the PR is added to it'),
  allowed: z.boolean(),
  checks: z.array(PlanCheck),
  blockers: z.array(Violation),
  waivers: z.array(Violation),
  overrides: z.array(MergeOverride),
  request: MergeRequestPlan,
});

export const MergeState = z.object({
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
  settled: z.boolean(),
  mergeStateStatus: z.enum(['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE']),
  reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable(),
  method: MergeMethod,
  ready: z.boolean(),
  blockers: z.array(Violation),
  waivers: z.array(Violation),
  warnings: z.array(Violation),
  mergedAt: Iso.nullable(),
  mergeCommit: Sha.nullable(),
  queue: MergeQueueState.nullable().describe('The merge queue of the base branch; null when it has none'),
});

export type PlanCheckStatus = z.infer<typeof PlanCheckStatus>;
export type PlanCheck = z.infer<typeof PlanCheck>;
export type MergeOverride = z.infer<typeof MergeOverride>;
export type MergePlan = z.infer<typeof MergePlan>;
export type MergeState = z.infer<typeof MergeState>;
export type MergeQueueState = z.infer<typeof MergeQueueState>;
