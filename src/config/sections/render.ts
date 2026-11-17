// `render` (02 §15, 08 §2): render.mode, render.prBody, render.footer, render.descriptionMaxChars.
// The template's own rules (placeholders, required ones, data keys) need the data section, so they run after
// the parse (templateIssues in src/config/load.ts).
import { z } from 'zod';

/** The attribution footer under every ghx PR body (02 §2.2). */
export const DEFAULT_FOOTER = '🤖 Generated with [Claude Code](https://claude.com/claude-code)';

export const RenderSection = z
  .strictObject({
    /** The built-in template: `trailer` (Summary, Data) or `details` (adds How to test). Not with prBody. */
    mode: z.enum(['trailer', 'details']).prefault('trailer'),
    /** The project's PR body template (08 §2), as a string or a list of lines; replaces `mode`. */
    prBody: z.union([z.string().min(1), z.array(z.string())]).optional(),
    /** The line under the body; null for none. */
    footer: z
      .string()
      .max(500)
      .refine((s) => !s.includes('<!--'), 'must not contain an HTML comment')
      .nullable()
      .prefault(DEFAULT_FOOTER),
    /** The description's cap in chars (description.too_long). 02 §2.1: 500. */
    descriptionMaxChars: z.number().int().min(1).max(2000).prefault(500),
  })
  .prefault({});
