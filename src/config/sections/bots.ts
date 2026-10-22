// `bots` (02 §4.1, §15): what else counts as bot output, beyond a Bot author or a `[bot]` login.
import { z } from 'zod';

export const BotsSection = z
  .strictObject({
    /** Extra logins treated as bots (compared case-insensitively). */
    logins: z.array(z.string().min(1)).prefault([]),
    /** HTML-comment markers, e.g. `ci-duration-watch` for a body carrying `<!-- ci-duration-watch -->`. */
    markers: z.array(z.string().regex(/^[\w.:-]+$/, 'a marker is the token inside <!-- … -->')).prefault([]),
  })
  .prefault({});
