// `trust` (02 §9.4, §15): whose ghx blocks count. Anyone else's block is read as structured:false with
// UNTRUSTED_BLOCK, which stops forged `met` or `addressed` events (prompt-injection defence).
import { z } from 'zod';
import { Association } from '../../schemas/common.ts';

export const DEFAULT_TRUSTED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'] as const;

export const TrustSection = z
  .strictObject({
    /** GitHub `authorAssociation` values whose blocks are trusted. */
    associations: z.array(Association).prefault([...DEFAULT_TRUSTED_ASSOCIATIONS]),
    /** Logins trusted whatever their association, e.g. a bot that runs ghx (`my-app[bot]`). */
    bots: z.array(z.string().min(1)).prefault([]),
  })
  .prefault({});
