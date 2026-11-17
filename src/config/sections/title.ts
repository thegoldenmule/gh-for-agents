// `title` (02 §15). Owned by M9 (pr create): title.types, title.scopeRequired.
import { z } from 'zod';
import { isValidPattern } from './data.ts';

/** Match the entire ticket key, even when the configured expression is unanchored. */
export function matchesTicket(key: string, pattern: string): boolean {
  return new RegExp(`^(?:${pattern})$`, 'u').test(key);
}

const TicketTitle = z.strictObject({
  pattern: z.string().min(1).max(300).refine(isValidPattern, 'invalid regular expression'),
  example: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[^\s:]+$/, 'a ticket key without whitespace or a colon'),
});

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
    format: z.enum(['conventional', 'ticket']).prefault('conventional'),
    ticket: TicketTitle.optional(),
    /** Allowed conventional-commit types (02 §2.1: "Types are configurable"). */
    types: z
      .array(z.string().regex(/^[a-z][a-z0-9-]*$/, 'a lowercase type token'))
      .min(1)
      .prefault([...DEFAULT_TITLE_TYPES]),
    /** Require a `(scope)` in every title (title.scope_missing). */
    scopeRequired: z.boolean().prefault(false),
  })
  .superRefine((title, ctx) => {
    if (title.format === 'ticket' && title.ticket === undefined) {
      ctx.addIssue({ code: 'custom', path: ['ticket'], message: 'ticket format requires a pattern and example' });
    }
    if (
      title.ticket !== undefined &&
      isValidPattern(title.ticket.pattern) &&
      !matchesTicket(title.ticket.example, title.ticket.pattern)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['ticket', 'example'],
        message: 'example must match the complete ticket pattern',
      });
    }
  })
  .prefault({});
