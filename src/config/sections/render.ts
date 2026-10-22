// `render` (02 §15). Owned by M9 (pr create): render.mode, render.footer, render.descriptionMaxChars.
// Empty until that milestone adds its keys; it already parses so configs can be written against it.
import { z } from 'zod';

export const RenderSection = z.strictObject({}).prefault({});
