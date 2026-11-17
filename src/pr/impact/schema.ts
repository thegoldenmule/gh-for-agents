import { z } from 'zod';
import { Iso, Sha } from '../../schemas/common.ts';
import { Risk } from '../../schemas/pr.ts';
import { PrStatusErrorEntry } from '../status/schema.ts';

export const Impact = z.object({
  components: z.array(z.string()),
  alsoTouched: z.array(z.string()),
  riskFloor: Risk.nullable(),
});
export const PrImpactOutput = Impact.extend({
  ref: z.string(),
  headSha: Sha,
  baseSha: Sha,
  config: z.record(z.string(), z.unknown()),
  fetchedAt: Iso,
});
export const PrImpactCommandOutput = PrImpactOutput.partial().extend({
  results: z.array(z.union([PrImpactOutput, PrStatusErrorEntry])).optional(),
});
