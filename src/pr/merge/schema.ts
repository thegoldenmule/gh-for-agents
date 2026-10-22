// pr merge's output (02 §8.3). The plan is the policy engine's MergePlan, so `plan.request` is exactly the
// PUT that was (or, under --dry-run, would be) sent. No transforms (JSON Schema export).
import { z } from 'zod';
import { MergeMethod } from '../../config/sections/_shared.ts';
import { MergePlan } from '../../policy/schemas.ts';
import { Iso, PrRef, Sha } from '../../schemas/common.ts';

export const MergeChild = z.object({
  ref: PrRef,
  base: z.string().describe('The branch it is based on: the merged head branch'),
});

export const PrMergeOutput = z.object({
  ref: PrRef.describe('owner/repo#N'),
  merged: z.literal(true),
  alreadyMerged: z.boolean().describe('The PR was already merged at the evaluated head; nothing was sent'),
  recoveredFromTransient: z
    .boolean()
    .describe('The PUT failed transiently, and a re-read showed the PR merged at the pinned head'),
  method: MergeMethod,
  headSha: Sha.describe('The head the merge was pinned to'),
  mergeCommit: Sha,
  mergedAt: Iso,
  deletedBranch: z.boolean().describe('ghx deleted the remote head branch'),
  children: z.array(MergeChild).describe('Open PRs based on the merged head branch'),
  plan: MergePlan,
  next: z.array(z.string()),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
});

export type MergeChild = z.infer<typeof MergeChild>;
export type PrMergeOutput = z.infer<typeof PrMergeOutput>;
