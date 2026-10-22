// `bots` (02 §15). Owned by M6 (pr status / feedback): bots.logins, bots.markers.
// Empty until that milestone adds its keys; it already parses so configs can be written against it.
import { z } from 'zod';

export const BotsSection = z.strictObject({}).prefault({});
