// `merge` (02 §15, §8): default merge commit; squash only by explicit override (§4.3). M6.4 added the
// policy keys (sharedRed, blockOnSeverity, requireOwnPr); M8 adds deleteBranch here.
import { z } from 'zod';
import { MergeMethod } from './_shared.ts';

export const MergeSection = z
  .strictObject({
    method: MergeMethod.prefault('merge'),
    allowedMethods: z.array(MergeMethod).min(1).prefault(['merge']),
    /** CI_RED is waived when every failure is shared with main (02 §1.5); `off` never waives. */
    sharedRed: z.enum(['tests', 'step', 'off']).prefault('tests'),
    /** Open findings at or above this severity block a merge (FINDINGS_OPEN); lower ones only warn. */
    blockOnSeverity: z.enum(['high', 'medium', 'low']).prefault('high'),
    /** Refuse to merge someone else's PR (AUTHOR_NOT_VIEWER, overridable). */
    requireOwnPr: z.boolean().prefault(true),
    /** pr merge deletes the same-repo head branch after merging, as --delete-branch does (02 §8.1 step 9). */
    deleteBranch: z.boolean().prefault(false),
  })
  .superRefine((m, ctx) => {
    if (!m.allowedMethods.includes(m.method)) {
      ctx.addIssue({
        code: 'custom',
        path: ['method'],
        message: `merge.method '${m.method}' is not in merge.allowedMethods (${m.allowedMethods.join(', ')})`,
      });
    }
  })
  .prefault({});
