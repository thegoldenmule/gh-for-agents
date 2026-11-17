// `data` (08 §1): the agent data fields a project declares. A declared field has a type and may be required,
// always or from a risk up. Declarations are a floor, not a list: an agent may add any other key.
import { z } from 'zod';
import { DataKey, MAX_DATA_ITEMS, MAX_DATA_STRING, MAX_DECLARED_FIELDS } from '../../schemas/data.ts';
import { ComponentMinRisk } from './components.ts';

/** True when `s` compiles as a `u`-flag regular expression, the flag dataRules matches with. */
export function isValidPattern(s: string): boolean {
  try {
    new RegExp(s, 'u');
    return true;
  } catch {
    return false;
  }
}

const base = {
  description: z.string().max(200).optional(),
  /** Every PR must carry it. */
  required: z.boolean().optional(),
  /** PRs at this risk or higher must carry it (like a component's minRisk). */
  requiredFromRisk: ComponentMinRisk.optional(),
} as const;

export const DataField = z.discriminatedUnion('type', [
  z.strictObject({
    ...base,
    type: z.literal('string'),
    pattern: z.string().min(1).refine(isValidPattern, 'invalid regular expression').optional(),
    maxChars: z.number().int().min(1).max(MAX_DATA_STRING).optional(),
    /** The value `--example` shows; needed when a pattern makes `<key>` invalid. */
    example: z.string().optional(),
  }),
  z.strictObject({ ...base, type: z.literal('enum'), values: z.array(z.string().min(1).max(100)).min(1).max(50) }),
  z.strictObject({
    ...base,
    type: z.literal('number'),
    min: z.number().optional(),
    max: z.number().optional(),
    example: z.number().optional(),
  }),
  z.strictObject({ ...base, type: z.literal('boolean') }),
  z.strictObject({
    ...base,
    type: z.literal('string[]'),
    example: z.array(z.string()).max(MAX_DATA_ITEMS).optional(),
  }),
]);

export const DataSection = z
  .strictObject({
    fields: z
      .record(DataKey, DataField)
      .refine((r) => Object.keys(r).length <= MAX_DECLARED_FIELDS, `declare at most ${MAX_DECLARED_FIELDS} fields`)
      .prefault({}),
  })
  .prefault({});

export type DataField = z.output<typeof DataField>;
