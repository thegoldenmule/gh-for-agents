// `pr create` input (02 §2.1) and the `pr edit` patch derived from it (02 §3).
//
// Structure only. Everything that needs the repo config (component membership, title types, risk floors)
// or crosses fields lives in createRules (./rules.ts), because a command's `spec.input` must export to
// JSON Schema without a config (test/registry.test.ts). No transforms, for the same reason.
import { z } from 'zod';
import { OneLine, PrRef } from '../../schemas/common.ts';
import { ComponentName, Refs, RevertPolicy, Risk, TestingItem } from '../../schemas/pr.ts';

export const MAX_TESTING_ITEMS = 10;
export const MAX_COMPONENTS = 5;

/** The fields of a PR create input, without the config-dependent rules. */
export const PrCreateInput = z
  .strictObject({
    title: z.string().describe('Conventional-commit title, ≤72 code points: type(scope): summary'),
    description: z.string().describe('1–3 plain lines, ≤500 chars; no headings, lists, quotes, tables or fences'),
    testing: z.array(TestingItem).min(1).max(MAX_TESTING_ITEMS),
    risk: Risk,
    riskNote: OneLine(160).optional().describe('Required for medium and high risk'),
    components: z
      .array(ComponentName)
      .min(1)
      .max(MAX_COMPONENTS)
      .describe(
        'Components from .github/ghx.json: every one the diff touches; past 5, the 5 primary ones (ghx records the rest as alsoTouched)',
      ),
    revertPolicy: RevertPolicy,
    revertNote: OneLine(200).optional().describe('Required for revert-with-followup and forward-fix-only'),
    revertWith: z.array(PrRef).max(10).optional().describe('Required (≥1) for coordinated'),
    base: z.string().min(1).max(255),
    head: z.string().min(1).max(255),
    draft: z.boolean().optional(),
    refs: Refs.optional(),
  })
  .describe('A structured PR (02 §2.1)');

export type PrCreateInput = z.infer<typeof PrCreateInput>;

/**
 * A `pr edit` patch (02 §3): any create field except `head`, plus `adopt`. Arrays replace on merge. The
 * merged object is validated with the full createRules (and the network rules), so this schema is
 * structure only, like PrCreateInput.
 */
export const PrEditInput = PrCreateInput.omit({ head: true })
  .partial()
  .extend({ adopt: z.boolean().optional().describe('Adopt a PR that has no ghx block (needs every field)') })
  .refine((p) => Object.keys(p).length > 0, 'empty patch: give at least one field');

export type PrEditInput = z.infer<typeof PrEditInput>;
