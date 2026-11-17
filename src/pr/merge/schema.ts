// pr merge's output (02 §8.3). The plan is the policy engine's MergePlan, so `plan.request` is exactly the
// PUT (or, where the base branch has a merge queue, the enqueue mutation) that was (or, under --dry-run,
// would be) sent. No transforms (JSON Schema export).
import { z } from 'zod';
import { MergeMethod } from '../../config/sections/_shared.ts';
import { MergePlan } from '../../policy/schemas.ts';
import { Iso, PrRef, Sha } from '../../schemas/common.ts';

export const MergeChild = z.object({
  ref: PrRef,
  base: z.string().describe('The branch it is based on: the merged head branch'),
});

export const HeadBranch = z.object({
  state: z
    .enum(['deleted', 'present', 'unknown'])
    .describe('The remote head branch after the merge; unknown for a fork head or when its ref could not be read'),
  deletedBy: z
    .enum(['ghx', 'github', 'unknown'])
    .nullable()
    .describe('Who deleted it: ghx, github (the repo deletes head branches on merge) or unknown; null unless deleted'),
  autoDelete: z
    .boolean()
    .describe("The repo's delete_branch_on_merge setting: when on and state is present, GitHub is about to delete it"),
});

export const MergeQueueResult = z.object({
  method: MergeMethod.nullable().describe('How the queue merges; null when GitHub does not report it'),
  url: z.string().nullable(),
  alreadyQueued: z.boolean().describe('The PR was already in the queue at the evaluated head; nothing was sent'),
  state: z
    .string()
    .nullable()
    .describe('QUEUED, AWAITING_CHECKS, MERGEABLE, UNMERGEABLE or LOCKED, as last read; null once the queue merged it'),
  position: z.number().int().nullable().describe('Its place in the queue, as last read'),
  enqueuedAt: Iso.nullable(),
});

export const PrMergeOutput = z.object({
  ref: PrRef.describe('owner/repo#N'),
  merged: z
    .boolean()
    .describe('false when the PR was added to the merge queue instead (queued): the queue merges it later'),
  queued: z
    .boolean()
    .describe(
      'The base branch has a merge queue and the PR is in it, pinned to headSha, not merged yet: wait with ghx pr land',
    ),
  queue: MergeQueueResult.nullable().describe('The merge queue the PR went through; null for a direct merge'),
  alreadyMerged: z.boolean().describe('The PR was already merged at the evaluated head; nothing was sent'),
  recoveredFromTransient: z
    .boolean()
    .describe('The PUT failed transiently, and a re-read showed the PR merged at the pinned head'),
  method: MergeMethod,
  headSha: Sha.describe('The head the merge was pinned to'),
  mergeCommit: Sha.nullable().describe('null while queued'),
  mergedAt: Iso.nullable().describe('null while queued'),
  deletedBranch: z
    .boolean()
    .describe('ghx itself deleted the remote head branch; headBranch says whether it still exists'),
  headBranch: HeadBranch,
  children: z.array(MergeChild).describe('Open PRs based on the merged head branch'),
  plan: MergePlan,
  next: z.array(z.string()),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
});

export type MergeChild = z.infer<typeof MergeChild>;
export type MergeQueueResult = z.infer<typeof MergeQueueResult>;
export type HeadBranch = z.infer<typeof HeadBranch>;
export type PrMergeOutput = z.infer<typeof PrMergeOutput>;
