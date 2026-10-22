// `render` (02 §15). Owned by M9 (pr create): render.mode, render.footer, render.descriptionMaxChars.
import { z } from 'zod';

export const RenderSection = z
  .strictObject({
    /** The description's cap in chars (description.too_long). 02 §2.1: 500. */
    descriptionMaxChars: z.number().int().min(1).max(2000).prefault(500),
  })
  .prefault({});
