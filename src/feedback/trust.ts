// The trust gate (02 §9.4): a ghx block counts only if its author's association is in
// `trust.associations`, or its author is a GraphQL Bot whose login is in `trust.bots` (a User with the
// same name is not; display-side bot detection in bots.ts stays lenient). Every write uses the user's token, so identity
// can't be checked; association is what stops a drive-by commenter forging `addressed` or `met`.
import type { GhxConfig } from '../config/schema.ts';
import { Association } from '../schemas/common.ts';
import { trustedBotMatches } from './bots.ts';

export type TrustConfig = Pick<GhxConfig['trust'], 'associations' | 'bots'>;

export type TrustVerdict = { trusted: true } | { trusted: false; reason: string };

/** GitHub's association, or NONE for a value this ghx doesn't know (fails closed). */
export function normalizeAssociation(value: string): Association {
  const r = Association.safeParse(value);
  return r.success ? r.data : 'NONE';
}

/**
 * `actor` carries the GraphQL `__typename`; without it (or for any type but Bot) `trust.bots` never matches,
 * so a human cannot pass as an app by taking its name.
 */
export function trustOf(
  login: string,
  association: string,
  config: TrustConfig,
  actor?: { __typename?: string | undefined } | null,
): TrustVerdict {
  const bot = actor?.__typename === 'Bot' ? { __typename: 'Bot', login } : null;
  if (config.bots.some((b) => trustedBotMatches(bot, b))) return { trusted: true };
  const a = normalizeAssociation(association);
  if ((config.associations as readonly string[]).includes(a)) return { trusted: true };
  return { trusted: false, reason: `untrusted author ${login} (${a})` };
}
