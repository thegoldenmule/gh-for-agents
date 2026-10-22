// `ci` (02 §15): owned by the CI milestones (M2–M5), which add ci.expected, ci.keySteps,
// ci.stall.*, ci.knownFlaky, … here. 01's `checks.ignore` lives here as ci.ignore (02 §6, 03 §4.4.1).
import { z } from 'zod';
import { Glob } from './_shared.ts';

export const IgnoredCheck = z.union([
  z.string().min(1).describe('Exact check name or glob, e.g. "notify-discord"'),
  z.strictObject({ name: z.string().min(1), workflow: z.string().optional(), reason: z.string().min(1) }),
]);

/** A JavaScript regular expression source, checked to compile. */
export const LogPattern = z
  .string()
  .min(1)
  .refine((p) => {
    try {
      new RegExp(p);
      return true;
    } catch {
      return false;
    }
  }, 'invalid regular expression');

export const CiSection = z
  .strictObject({
    ignore: z.array(IgnoredCheck).prefault([]),
    // M2.4: extra log lines that count as errors in a diagnosis (02 §12 step 4). Optional, no default.
    logPatterns: z.array(LogPattern).optional(),
    // M2.6 (02 §11.8): jobs or tests known to be flaky (`*` wildcards), and extra infra-error log patterns.
    knownFlaky: z.array(z.strictObject({ job: z.string().min(1), test: z.string().min(1).optional() })).optional(),
    infraPatterns: z.array(LogPattern).optional(),
    // M3.2 (02 §12, §8.2 row 12): steps that must run in a green job; a skipped one is a misleading green.
    keySteps: z.array(z.string().min(1)).optional(),
    // M4.1 (02 §11.3): checks ci wait expects even before they register. An entry with `paths` applies
    // only when a changed file matches one of the globs. Optional, no default.
    expected: z
      .array(
        z.strictObject({
          name: z.string().min(1),
          workflow: z.string().min(1).optional(),
          paths: z.array(Glob).min(1).optional(),
        }),
      )
      .optional(),
    // M4.5 (02 §11.1, 03 Q1): stall fuses for ci wait. Optional; src/ci/wait/stall.ts fills the defaults
    // (queuedMinutes 30, missingMinutes 10).
    stall: z
      .strictObject({
        queuedMinutes: z.number().int().positive().optional(),
        missingMinutes: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .prefault({});
