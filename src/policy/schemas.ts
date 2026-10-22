// Output schemas for the policy engine (02 §4.1 MergeState, §8.3 MergePlan). pr status embeds MergeState,
// pr merge prints MergePlan, ci wait --until mergeable summarises both. No transforms (JSON Schema export).
import { z } from 'zod';
import { MergeMethod } from '../config/sections/_shared.ts';
import { Iso, PrRef, Sha } from '../schemas/common.ts';
import { Violation } from '../schemas/pr.ts';

export const PlanCheckStatus = z.enum(['pass', 'fail', 'waived', 'overridden', 'warn', 'skipped']);
export const PlanCheck = z.object({ code: z.string(), status: PlanCheckStatus, message: z.string() });

export const MergeOverride = z.object({ code: z.string(), reason: z.string() });

export const MergePlan = z.object({
  ref: PrRef,
  headSha: Sha,
  method: MergeMethod,
  allowed: z.boolean(),
  checks: z.array(PlanCheck),
  blockers: z.array(Violation),
  waivers: z.array(Violation),
  overrides: z.array(MergeOverride),
  request: z.object({ method: z.literal('PUT'), path: z.string(), body: z.record(z.string(), z.unknown()) }),
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
});

export type PlanCheckStatus = z.infer<typeof PlanCheckStatus>;
export type PlanCheck = z.infer<typeof PlanCheck>;
export type MergeOverride = z.infer<typeof MergeOverride>;
export type MergePlan = z.infer<typeof MergePlan>;
export type MergeState = z.infer<typeof MergeState>;
