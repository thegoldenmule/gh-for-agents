// `title` (02 §15). Owned by M9 (pr create): title.types, title.scopeRequired.
import { z } from 'zod';

/** The conventional-commit types of 02 §2.1's title.format regex. */
export const DEFAULT_TITLE_TYPES = [
  'feat',
  'fix',
  'docs',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
  'style',
] as const;

export const TitleSection = z
  .strictObject({
    /** Allowed conventional-commit types (02 §2.1: "Types are configurable"). */
    types: z
      .array(z.string().regex(/^[a-z][a-z0-9-]*$/, 'a lowercase type token'))
      .min(1)
      .prefault([...DEFAULT_TITLE_TYPES]),
    /** Require a `(scope)` in every title (title.scope_missing). */
    scopeRequired: z.boolean().prefault(false),
  })
  .prefault({});
