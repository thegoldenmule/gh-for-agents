// `render` (02 §15). Owned by M9 (pr create): render.mode, render.footer, render.descriptionMaxChars.
import { z } from 'zod';

/** The attribution footer under every ghx PR body (02 §2.2). */
export const DEFAULT_FOOTER = '🤖 Generated with [Claude Code](https://claude.com/claude-code)';

export const RenderSection = z
  .strictObject({
    /** `trailer`: description, one trailer line, footer. `details` adds a collapsed "How to test" list. */
    mode: z.enum(['trailer', 'details']).prefault('trailer'),
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
