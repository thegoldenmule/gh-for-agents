// `components` (brief 6; 01 §5; 03 §1 row 7): the per-repo enum, keyed by name, optionally mapped to
// path globs, with an optional risk floor (`minRisk`, 02 §15; risk.below_component_floor).
import { z } from 'zod';
import { Glob } from './_shared.ts';

/**
 * The risk enum, low to high. Same values and order as RISK_ORDER in src/schemas/pr.ts; it is spelled out
 * here because pr.ts imports this file (an import back would be a cycle). A test pins the two together.
 */
export const ComponentMinRisk = z.enum(['trivial', 'low', 'medium', 'high']);

export const ComponentName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*$/)
  .describe('Conventional-commit scope token');

export const Component = z.strictObject({
  description: z.string().max(200).optional(),
  /** Maps changed files to components. */
  paths: z.array(Glob).min(1).optional(),
  /** The lowest risk a PR declaring this component may claim. */
  minRisk: ComponentMinRisk.optional(),
});

export const ComponentsRecord = z.record(ComponentName, Component);

export const ComponentsSection = ComponentsRecord.refine(
  (r) => Object.keys(r).length > 0,
  'declare at least one component',
);
