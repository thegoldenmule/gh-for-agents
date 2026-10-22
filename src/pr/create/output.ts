// `pr create` output (02 §2.3) and the `--batch` result (02 §2.4). The runner adds `warnings`.
import { z } from 'zod';
import { PrRef, Sha } from '../../schemas/common.ts';

/** One created PR. `--dry-run` prints the same fields without ref, number and url, as the preview. */
export const PrCreateOutput = z.object({
  ref: PrRef.describe('owner/repo#N'),
  number: z.number().int().positive(),
  url: z.string().url(),
  title: z.string(),
  base: z.string(),
  head: z.object({ ref: z.string(), sha: Sha }),
  draft: z.boolean(),
  draftDerived: z.boolean().describe('true when draft came from the stack rule, not the input'),
  stackedOn: PrRef.nullable(),
  blockId: z.string(),
  body: z.string(),
  /** The PR already existed after a transient POST failure and carried this run's block id. */
  recoveredFromTransient: z.boolean().optional(),
  next: z.array(z.string()),
});
export type PrCreateOutput = z.infer<typeof PrCreateOutput>;

/** The dry-run plan of one PR: the output without ref, number and url. */
export type PrCreatePreview = Omit<PrCreateOutput, 'ref' | 'number' | 'url' | 'recoveredFromTransient'> & {
  /** --batch: the input index of a batch item this one is stacked on; stackedOn is filled once it exists. */
  stackedOnItem?: number;
};

/** `--batch` success. A failure is PARTIAL_FAILURE (or the first item's own error) with the same keys in details. */
export const PrBatchResultFields = {
  created: z.array(PrCreateOutput).optional().describe('--batch: the PRs created, in creation order'),
  failed: z
    .object({ index: z.number().int(), head: z.string(), code: z.string(), message: z.string() })
    .nullable()
    .optional()
    .describe('--batch: null on success'),
  notAttempted: z.array(z.number().int()).optional().describe('--batch: input indexes never attempted'),
};

/** One schema for both modes (a spec has one output object): a single PR's fields, or the batch fields. */
export const PrCreateCommandOutput = PrCreateOutput.partial().extend(PrBatchResultFields);
