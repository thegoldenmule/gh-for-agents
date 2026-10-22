// `title` (02 §15). Owned by M9 (pr create): title.types, title.scopeRequired.
// Empty until that milestone adds its keys; it already parses so configs can be written against it.
import { z } from 'zod';

export const TitleSection = z.strictObject({}).prefault({});
