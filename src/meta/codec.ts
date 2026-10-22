// The hidden metadata block wire format (01 §6, 02 §9.1, 03 §1 row 8): `<!-- ghx:vN {json} -->`.
// 02 owns the payload schemas (passed in as MetaSchemas); this module owns encoding and parsing.
//
// Escaping: after stableStringify, `<`, `>` and `&` become <, > and &. JSON syntax
// outside string literals never contains them, so every occurrence is inside a string, where the
// escape decodes back to the same character. `-->`, `--!>` and `<!--` therefore cannot appear inside
// the block, and JSON.parse round-trips exactly.
import type { z } from 'zod';
import { GhxError } from '../core/errors.ts';
import { stableStringify } from '../util/json.ts';

export const META_VERSION = 1;
/** GitHub's body limit, in characters. */
export const MAX_BODY_CHARS = 65_536;

export type MetaSchemas = Readonly<Record<number, z.ZodType>>;

export type Decoded<T> =
  | { status: 'absent' }
  | { status: 'ok'; version: number; data: T; raw: string; range: [number, number] }
  | {
      status: 'invalid';
      reason: 'json' | 'schema' | 'unsupported-version';
      version?: number;
      raw: string;
      range: [number, number];
      issues?: unknown;
    };

const BLOCK = /<!--\s*ghx:v(\d+)\s+(\{[\s\S]*?\})\s*-->/g;

export function escapeJson(json: string): string {
  return json.replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
}

/** `<!-- ghx:v1 {...} -->` on one line, keys sorted. */
export function encode(data: unknown, version: number = META_VERSION): string {
  return `<!-- ghx:v${version} ${escapeJson(stableStringify(data))} -->`;
}

function decodeMatch(m: RegExpMatchArray, schemas: MetaSchemas): Decoded<unknown> {
  const version = Number(m[1]);
  const raw = m[0];
  const start = m.index ?? 0;
  const range: [number, number] = [start, start + raw.length];
  const schema = schemas[version];
  if (!schema) return { status: 'invalid', reason: 'unsupported-version', version, raw, range };
  let json: unknown;
  try {
    json = JSON.parse(m[2] ?? '');
  } catch {
    return { status: 'invalid', reason: 'json', version, raw, range };
  }
  const r = schema.safeParse(json);
  if (!r.success) return { status: 'invalid', reason: 'schema', version, raw, range, issues: r.error.issues };
  return { status: 'ok', version, data: r.data, raw, range };
}

/** Every ghx block in order. Other HTML comments (e.g. `<!-- ci-duration-watch -->`) are ignored. Never throws. */
export function decodeAll(body: string, schemas: MetaSchemas): Decoded<unknown>[] {
  return [...body.matchAll(BLOCK)].map((m) => decodeMatch(m, schemas));
}

/**
 * One block. Default: the last block wins (01 §6); `first-valid` returns the first ok block (02 §9.2
 * for `pr` blocks; callers raise DUPLICATE_BLOCK from decodeAll when there are several).
 */
export function decode<T>(body: string, schemas: MetaSchemas, o: { pick?: 'last' | 'first-valid' } = {}): Decoded<T> {
  const all = decodeAll(body, schemas);
  if (all.length === 0) return { status: 'absent' };
  if (o.pick === 'first-valid') return (all.find((d) => d.status === 'ok') ?? all[0]) as Decoded<T>;
  return all[all.length - 1] as Decoded<T>;
}

/** The visible text: the body without ghx blocks, with the blank lines they leave trimmed. */
export function strip(body: string): string {
  return body
    .replace(/[ \t]*\r?\n?[ \t]*<!--\s*ghx:v\d+\s+\{[\s\S]*?\}\s*-->[ \t]*/g, '')
    .replace(/(\r?\n){3,}/g, '\n\n')
    .replace(/\s+$/, '');
}

/**
 * Replace the last ghx block in place, else append one on its own line after a blank line.
 * Idempotent: upserting the same data twice equals once. Over 65,536 chars is META_TOO_LARGE.
 */
export function upsert(body: string, data: unknown, version: number = META_VERSION): string {
  const block = encode(data, version);
  const matches = [...body.matchAll(BLOCK)];
  const last = matches[matches.length - 1];
  let out: string;
  if (last && last.index !== undefined) {
    out = body.slice(0, last.index) + block + body.slice(last.index + last[0].length);
  } else {
    const visible = body.replace(/\s+$/, '');
    out = visible === '' ? block : `${visible}\n\n${block}`;
  }
  if (out.length > MAX_BODY_CHARS) {
    throw new GhxError(
      'META_TOO_LARGE',
      `The body with its ghx block is ${out.length} characters; GitHub allows ${MAX_BODY_CHARS}.`,
      {
        details: { chars: out.length, max: MAX_BODY_CHARS, blockChars: block.length },
      },
    );
  }
  return out;
}
