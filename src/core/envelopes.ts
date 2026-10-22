// The global stdout envelopes (01 §3.4, 02 §1.3), as zod schemas for `ghx schema envelopes`.
import { z } from 'zod';

export const ErrorEnvelope = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    hint: z.string().nullable(),
    details: z.record(z.string(), z.unknown()).nullable(),
  }),
});

export const SpilledEnvelope = z.strictObject({
  spilled: z.literal(true),
  path: z.string(),
  bytes: z.number().int(),
  command: z.string(),
});

export const DryRunEnvelope = z.strictObject({
  dryRun: z.literal(true),
  wouldRun: z.array(z.strictObject({ argv: z.array(z.string()), stdin: z.string().optional() })),
  preview: z.unknown().nullable(),
  warnings: z.array(z.object({ code: z.string(), message: z.string() }).loose()).optional(),
});

export const StreamLine = z
  .object({
    type: z.string(),
    seq: z.number().int().min(0),
    at: z.string(),
  })
  .loose();

export const ENVELOPES = {
  error: ErrorEnvelope,
  spilled: SpilledEnvelope,
  dryRun: DryRunEnvelope,
  streamLine: StreamLine,
} as const;
