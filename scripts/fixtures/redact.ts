#!/usr/bin/env node
// Fixture redaction (03 §6.1). Scrubs tokens, emails, request ids, SAS query strings and Date
// headers; maps logins to stable aliases; keeps SHAs and timestamps (ETA, stall and ordering tests
// need them). Usage: node scripts/fixtures/redact.ts <dir> [--viewer <login>]
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const TOKEN = /\b(?:gh[opsu]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
/** Email addresses, except git transport users (git@github.com:o/r.git). */
export const EMAIL = /(?<![\w.+-])(?!git@)[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const GITHUB_REQUEST_ID = /\b[0-9A-F]{4}:[0-9A-F]{4,6}:[0-9A-F]{4,8}:[0-9A-F]{4,8}:[0-9A-F]{8}\b/g;
const FIXED_DATE = 'Thu, 22 Oct 2026 12:00:00 GMT';

export interface RedactOptions {
  /** login → alias. The viewer maps to 'viewer-user'. Bots ([bot]) are never aliased. */
  aliases?: Record<string, string>;
}

export function redactText(s: string, o: RedactOptions = {}): string {
  let out = s
    .replace(TOKEN, '<redacted-token>')
    .replace(/\b(Bearer|token)\s+[A-Za-z0-9_.-]{20,}/g, '$1 <redacted-token>')
    .replace(EMAIL, 'user@example.invalid')
    .replace(GITHUB_REQUEST_ID, '0000:0000:0000000:0000000:00000000')
    .replace(/^(x-ms-request-id|x-ms-client-request-id):\s*\S+/gim, '$1: 00000000-0000-0000-0000-000000000000')
    .replace(/(<RequestId>|RequestId:)\s*[0-9a-f-]{36}/gi, '$1 00000000-0000-0000-0000-000000000000')
    .replace(/^Date:\s*.+$/gim, (m) => `${m.slice(0, m.indexOf(':'))}: ${FIXED_DATE}`)
    .replace(/^(set-cookie):.*$/gim, '$1: <redacted>')
    .replace(/(https:\/\/[^\s"'<>]+?)\?[^\s"'<>]*\bsig=[^\s"'<>]*/g, '$1?<redacted-sas>');
  for (const [login, alias] of Object.entries(o.aliases ?? {})) {
    if (!login || login.endsWith('[bot]')) continue;
    const esc = login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![A-Za-z0-9-])${esc}(?![A-Za-z0-9-])`, 'g'), alias);
  }
  return out;
}

/**
 * Alias every JSON `login` of a person (any depth) not already aliased. Bots and organisations are
 * kept: organisation logins are repo owners that also appear in request paths. Mutates `aliases`.
 */
export function collectLogins(value: unknown, aliases: Record<string, string>, orgs: Set<string> = new Set()): void {
  const people: string[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.login === 'string') {
        if (o.type === 'Organization') orgs.add(o.login);
        else people.push(o.login);
      }
      for (const x of Object.values(o)) if (x && typeof x === 'object') visit(x);
    }
  };
  visit(value);
  for (const login of people) {
    if (login.endsWith('[bot]') || orgs.has(login) || login in aliases || Object.values(aliases).includes(login))
      continue;
    aliases[login] = `user-${Object.values(aliases).filter((a) => a.startsWith('user-')).length + 1}`;
  }
}

/** Rewrite only `"login": "<x>"` values (not other text) with the discovered aliases. */
export function aliasLoginFields(s: string, aliases: Record<string, string>): string {
  return s.replace(/("login"\s*:\s*")([^"\\]+)(")/g, (m, a: string, login: string, c: string) =>
    aliases[login] ? `${a}${aliases[login]}${c}` : m,
  );
}

function tryJson(s: string): unknown {
  const i = s.search(/[[{]/);
  if (i === -1) return undefined;
  try {
    return JSON.parse(s.slice(i));
  } catch {
    return undefined;
  }
}

/**
 * Redact one GhFixture object. The given aliases (the viewer) apply to every string; logins discovered
 * in the response body apply only to `"login"` fields of stdout, never to argv, so replays still match.
 */
export function redactFixture<T extends Record<string, unknown>>(f: T, o: RedactOptions = {}): T {
  const global = { ...(o.aliases ?? {}) };
  const discovered: Record<string, string> = { ...global };
  if (typeof f.stdout === 'string') collectLogins(tryJson(f.stdout), discovered);
  for (const k of Object.keys(global)) delete discovered[k];
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') {
      const r = redactText(v, { aliases: global });
      return key === 'stdout' ? aliasLoginFields(r, discovered) : r;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'meta' ? x : walk(x, k)]));
    }
    return v;
  };
  return walk(f) as T;
}

export function redactDir(dir: string, o: RedactOptions = {}): string[] {
  const changed: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      changed.push(...redactDir(p, o));
      continue;
    }
    const before = readFileSync(p, 'utf8');
    const after =
      name.endsWith('.json') && !name.startsWith('_')
        ? `${JSON.stringify(redactFixture(JSON.parse(before) as Record<string, unknown>, o), null, 2)}\n`
        : redactText(before, o);
    if (after !== before) {
      writeFileSync(p, after);
      changed.push(p);
    }
  }
  return changed;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  const vi = args.indexOf('--viewer');
  const viewer = vi >= 0 ? args[vi + 1] : undefined;
  if (!dir) {
    process.stderr.write('usage: node scripts/fixtures/redact.ts <dir> [--viewer <login>]\n');
    process.exitCode = 2;
  } else {
    const changed = redactDir(dir, viewer ? { aliases: { [viewer]: 'viewer-user' } } : {});
    process.stdout.write(`${JSON.stringify({ redacted: changed })}\n`);
  }
}
