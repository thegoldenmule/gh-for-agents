// Bot separation (02 §4.1, §8c4). An item is bot output if its author is a GraphQL Bot or its login ends
// in `[bot]`, if its login is in `bots.logins`, or if its body carries a marker from `bots.markers`.
import type { GhxConfig } from '../config/schema.ts';
import type { RawActor } from './raw.ts';

export type BotsConfig = Pick<GhxConfig['bots'], 'logins' | 'markers'>;

const BOT_SUFFIX = '[bot]';
const MARKER = /<!--\s*([\w.:-]+)\s*-->/g;

/** The login as GitHub's REST API and UI show it: GraphQL drops the `[bot]` suffix for Bot actors. */
export function displayLogin(actor: RawActor | null): string {
  if (!actor) return 'ghost';
  if (actor.__typename === 'Bot' && !actor.login.endsWith(BOT_SUFFIX)) return `${actor.login}${BOT_SUFFIX}`;
  return actor.login;
}

const bare = (login: string) => login.toLowerCase().replace(/\[bot\]$/, '');

/** Case-insensitive, and `x` matches `x[bot]` either way round. */
export function loginMatches(login: string, configured: string): boolean {
  return bare(login) === bare(configured);
}

/**
 * The trust gate's matcher (02 §9.4): only a GraphQL Bot actor, by its exact login (case-insensitive, and the
 * `[bot]` suffix optional on either side, since GraphQL drops it). A User named like an app never matches.
 */
export function trustedBotMatches(actor: Pick<RawActor, '__typename' | 'login'> | null, configured: string): boolean {
  if (actor?.__typename !== 'Bot') return false;
  return bare(actor.login) === bare(configured);
}

/** The author alone is a bot: a Bot actor, a `[bot]` login, or a `bots.logins` entry. */
export function isBotAuthor(actor: RawActor | null, config: BotsConfig): boolean {
  if (!actor) return false;
  const login = displayLogin(actor);
  return login.endsWith(BOT_SUFFIX) || config.logins.some((l) => loginMatches(login, l));
}

/** Marker tokens in a body's non-ghx HTML comments, in order (`<!-- ci-duration-watch -->`). */
export function markersIn(body: string): string[] {
  return [...body.matchAll(MARKER)].map((m) => m[1] ?? '').filter((t) => t !== '' && !/^ghx:v\d+$/.test(t));
}

/** The first configured marker in the body, else its first marker of any kind; null if none. */
export function markerOf(body: string, config: BotsConfig): string | null {
  const found = markersIn(body);
  return found.find((m) => config.markers.includes(m)) ?? found[0] ?? null;
}

export function isBotItem(actor: RawActor | null, body: string, config: BotsConfig): boolean {
  return isBotAuthor(actor, config) || markersIn(body).some((m) => config.markers.includes(m));
}

/** One line for `BotItem.summary`: the first visible line, HTML comments removed, at most 400 chars. */
export function botSummary(body: string): string {
  const visible = body.replace(/<!--[\s\S]*?-->/g, '');
  const line = visible
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '');
  return [...(line ?? '')].slice(0, 400).join('');
}
