import { z } from 'zod';
import { PlanCheck } from '../../policy/schemas.ts';
import { Sha } from '../../schemas/common.ts';
import { Violation } from '../../schemas/pr.ts';
import { Impact } from '../impact/schema.ts';

export const PrCheckOutput = z.object({
  ref: z.string(),
  headSha: Sha,
  baseSha: Sha,
  valid: z.boolean(),
  issues: z.array(
    z.object({ path: z.string(), code: z.string(), message: z.string(), suggestion: z.string().optional() }),
  ),
  impact: Impact,
  config: z.record(z.string(), z.unknown()),
  mergePolicy: z.object({ allowed: z.boolean(), checks: z.array(PlanCheck), blockers: z.array(Violation) }).nullable(),
  excludedChecks: z.array(z.object({ code: z.string(), reason: z.string(), checkId: z.number().int().optional() })),
  warnings: z.array(
    z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.unknown()).optional() }),
  ),
});
