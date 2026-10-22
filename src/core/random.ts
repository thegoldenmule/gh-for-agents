// The only module that touches randomness (03 §1 row 13). Tests pass a seeded Random; architecture.test.ts
// bans Math.random and crypto.randomUUID elsewhere in src/.
import { randomBytes } from 'node:crypto';

export interface Random {
  /** Uniform in [0, 1). */
  next(): number;
}

export const realRandom: Random = { next: () => Math.random() };

/** Deterministic PRNG (mulberry32) for tests. */
export function seededRandom(seed: number): Random {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/** `ms` scaled by a uniform factor in [1 - fraction, 1 + fraction]. */
export function jitter(ms: number, fraction: number, random: Random): number {
  if (fraction <= 0) return ms;
  return Math.max(0, ms * (1 - fraction + 2 * fraction * random.next()));
}

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

/** `length` lowercase Crockford base32 characters (02 §1.4 ids use 6). */
export function crockford(length: number, random: Random): string {
  let s = '';
  for (let i = 0; i < length; i++) s += CROCKFORD[Math.floor(random.next() * 32)] ?? '0';
  return s;
}

/** Hex from the OS CSPRNG, for names that must not collide across processes (temp files). */
export function secureHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}
