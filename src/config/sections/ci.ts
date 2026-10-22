// `ci` (02 §15): owned by the CI milestones (M2–M5), which add ci.expected, ci.keySteps,
// ci.stall.*, ci.knownFlaky, … here. 01's `checks.ignore` lives here as ci.ignore (02 §6, 03 §4.4.1).
import { z } from 'zod';

export const IgnoredCheck = z.union([
  z.string().min(1).describe('Exact check name or glob, e.g. "notify-discord"'),
  z.strictObject({ name: z.string().min(1), workflow: z.string().optional(), reason: z.string().min(1) }),
]);

export const CiSection = z
  .strictObject({
    ignore: z.array(IgnoredCheck).prefault([]),
  })
  .prefault({});
