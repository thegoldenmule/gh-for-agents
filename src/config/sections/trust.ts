// `trust` (02 §15). Owned by M6 (pr status / feedback): trust.associations, trust.bots.
// Empty until that milestone adds its keys; it already parses so configs can be written against it.
import { z } from 'zod';

export const TrustSection = z.strictObject({}).prefault({});
