// Client-side ghx ids (02 §1.4): a type prefix plus 6 lowercase Crockford base32 chars, unique per PR.
import { GhxError } from '../core/errors.ts';
import { crockford, type Random } from '../core/random.ts';
import { ID_PREFIXES, Id } from '../schemas/common.ts';

export type IdKind = keyof typeof ID_PREFIXES;

const MAX_ATTEMPTS = 1000;

/** A fresh id of `kind` that is not in `taken` (the ids already on the PR). */
export function newId(kind: IdKind, random: Random, taken: ReadonlySet<string> = new Set()): string {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const id = `${ID_PREFIXES[kind]}_${crockford(6, random)}`;
    if (!taken.has(id)) return id;
  }
  throw new GhxError('INTERNAL', `Could not generate a unique ${kind} id after ${MAX_ATTEMPTS} attempts.`);
}

/** Allocates several ids for one write, unique against the PR's existing ids and each other. */
export class IdAllocator {
  readonly #taken: Set<string>;
  readonly #random: Random;

  constructor(random: Random, existing: Iterable<string> = []) {
    this.#random = random;
    this.#taken = new Set(existing);
  }

  next(kind: IdKind): string {
    const id = newId(kind, this.#random, this.#taken);
    this.#taken.add(id);
    return id;
  }
}

/** The kind of a ghx id, or null for anything else (including `ic:`/`rc:`/`rv:` synthetic ids). */
export function idKind(id: string): IdKind | null {
  if (!Id.safeParse(id).success) return null;
  const prefix = id[0];
  return (Object.keys(ID_PREFIXES) as IdKind[]).find((k) => ID_PREFIXES[k] === prefix) ?? null;
}
