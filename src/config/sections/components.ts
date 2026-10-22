// `components` (brief 6; 01 §5; 03 §1 row 7): the per-repo enum, keyed by name, optionally mapped to
// path globs. M9 adds `minRisk` here.
import { z } from 'zod';
import { Glob } from './_shared.ts';

export const ComponentName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*$/)
  .describe('Conventional-commit scope token');

export const Component = z.strictObject({
  description: z.string().max(200).optional(),
  /** Maps changed files to components. */
  paths: z.array(Glob).min(1).optional(),
});

export const ComponentsRecord = z.record(ComponentName, Component);

export const ComponentsSection = ComponentsRecord.refine(
  (r) => Object.keys(r).length > 0,
  'declare at least one component',
);
