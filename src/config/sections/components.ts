// `components` (brief 6; 01 §5; 03 §1 row 7): the per-repo enum, keyed by name, optionally mapped to
// path globs, with an optional risk floor (`minRisk`, 02 §15; risk.below_component_floor) and aliases:
// other names agents use for it (an old name, a commit-log scope), mapped to the key with a warning.
import { z } from 'zod';
import { Glob } from './_shared.ts';

/**
 * The risk enum, low to high. Same values and order as RISK_ORDER in src/schemas/pr.ts; it is spelled out
 * here because pr.ts imports this file (an import back would be a cycle). A test pins the two together.
 */
export const ComponentMinRisk = z.enum(['trivial', 'low', 'medium', 'high']);

/** The same token as the title scope (02 §2.1), so every component can be a `type(scope)` scope. */
export const ComponentName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/)
  .describe('Conventional-commit scope token: lowercase letters, digits and hyphens');

export const Component = z.strictObject({
  description: z.string().max(200).optional(),
  /** Maps changed files to components. */
  paths: z.array(Glob).min(1).optional(),
  /** The lowest risk a PR declaring this component may claim. */
  minRisk: ComponentMinRisk.optional(),
  /** Other names for this component (an old name, a commit scope); a title scope or components entry using one is mapped to the key. */
  aliases: z
    .array(ComponentName)
    .max(20)
    .optional()
    .describe(
      'Other names for this component (an old name, a commit-log scope). A title scope or components entry that uses one is mapped to this key with a warning. Unique across components; never a component name.',
    ),
});

export const ComponentsRecord = z.record(ComponentName, Component);

export const ComponentsSection = ComponentsRecord.refine(
  (r) => Object.keys(r).length > 0,
  'declare at least one component',
).superRefine((r, ctx) => {
  const owner = new Map<string, string>();
  for (const [name, c] of Object.entries(r)) {
    (c.aliases ?? []).forEach((alias, i) => {
      const path = [name, 'aliases', i];
      if (Object.hasOwn(r, alias)) {
        ctx.addIssue({ code: 'custom', path, message: `alias '${alias}' is already a component name` });
      } else if (owner.has(alias)) {
        ctx.addIssue({ code: 'custom', path, message: `alias '${alias}' is also an alias of '${owner.get(alias)}'` });
      } else owner.set(alias, name);
    });
  }
});

/** alias → component name, for every declared alias. */
export function aliasMap(
  components: Readonly<Record<string, { aliases?: readonly string[] | undefined }>>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, c] of Object.entries(components)) for (const a of c.aliases ?? []) out.set(a, name);
  return out;
}
