// `merge` (02 §15, §8): default merge commit; squash only by explicit override (§4.3). M8 adds
// sharedRed, blockOnSeverity, requireOwnPr, deleteBranch here.
import { z } from 'zod';
import { MergeMethod } from './_shared.ts';

export const MergeSection = z
  .strictObject({
    method: MergeMethod.prefault('merge'),
    allowedMethods: z.array(MergeMethod).min(1).prefault(['merge']),
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
