// `pr comment` input (02 §7.1): a typed coordination comment. Strict; the handler validates with it so
// every issue comes back at once (VALIDATION). A `manual` condition's text is one line here: the block's
// Condition accepts any string, but a write should not carry an empty or multi-line condition.
import { z } from 'zod';
import { Body, OneLine, PrRef } from '../../schemas/common.ts';
import { StatusCommentState } from '../../schemas/pr.ts';

export const ConditionInput = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('pr-merged'), ref: PrRef }),
  z.strictObject({ type: z.literal('release-includes'), ref: PrRef }),
  z.strictObject({ type: z.literal('manual'), text: OneLine(300) }),
]);

export const PrCommentInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('note'), body: Body(1500, 15) }),
  z.strictObject({ kind: z.literal('precondition'), condition: ConditionInput, body: Body(500, 3).optional() }),
  z.strictObject({
    kind: z.literal('status'),
    state: StatusCommentState,
    body: Body(500, 3),
    refs: z.array(PrRef).max(10).optional(),
  }),
  z.strictObject({ kind: z.literal('supersede'), by: PrRef, body: Body(500, 3).optional() }),
]);

export type ConditionInput = z.infer<typeof ConditionInput>;
export type PrCommentInput = z.infer<typeof PrCommentInput>;

/** Every PR ref the comment names (02 §7.1: each must exist and must not be this PR). */
export function commentRefs(c: PrCommentInput): { path: string; ref: string }[] {
  switch (c.kind) {
    case 'precondition':
      return c.condition.type === 'manual' ? [] : [{ path: 'condition.ref', ref: c.condition.ref }];
    case 'status':
      return (c.refs ?? []).map((ref, i) => ({ path: `refs[${i}]`, ref }));
    case 'supersede':
      return [{ path: 'by', ref: c.by }];
    case 'note':
      return [];
  }
}
