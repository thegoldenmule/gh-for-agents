// The trust gate (02 §9.4): a ghx block counts only if its author's association is in
// `trust.associations` or its login is in `trust.bots`. Every write uses the user's token, so identity
// can't be checked; association is what stops a drive-by commenter forging `addressed` or `met`.
import type { GhxConfig } from '../config/schema.ts';
import { Association } from '../schemas/common.ts';
import { loginMatches } from './bots.ts';

export type TrustConfig = Pick<GhxConfig['trust'], 'associations' | 'bots'>;

export type TrustVerdict = { trusted: true } | { trusted: false; reason: string };

/** GitHub's association, or NONE for a value this ghx doesn't know (fails closed). */
export function normalizeAssociation(value: string): Association {
  const r = Association.safeParse(value);
  return r.success ? r.data : 'NONE';
}

export function trustOf(login: string, association: string, config: TrustConfig): TrustVerdict {
  if (config.bots.some((b) => loginMatches(login, b))) return { trusted: true };
  const a = normalizeAssociation(association);
  if ((config.associations as readonly string[]).includes(a)) return { trusted: true };
  return { trusted: false, reason: `untrusted author ${login} (${a})` };
}
