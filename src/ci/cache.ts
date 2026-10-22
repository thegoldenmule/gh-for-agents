// A JSON disk cache under the artifact root (03 M2.5), with TTLs measured on the injected Clock.
// 03 places this at src/core/cache.ts; it lives in src/ci/ because wave 2b's ci-core owns only
// src/ci/** (a later wave may move it). Entries with `ttlMs: null` never expire: parsed test lists
// keyed by job id are immutable, because a job's log never changes. A corrupt or unreadable file is
// a miss, never an error.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import type { ArtifactStore } from '../core/artifacts.ts';
import type { Clock } from '../core/clock.ts';
import type { RepoRef } from '../gh/types.ts';

export interface JsonCache {
  get<S extends z.ZodType>(key: string, schema: S): z.output<S> | undefined;
  set(key: string, value: unknown, ttlMs: number | null): void;
}

interface Entry {
  v: 1;
  storedAt: number;
  expiresAt: number | null;
  value: unknown;
}

function fileFor(dir: string, key: string): string {
  const safe = key.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  const h = createHash('sha256').update(key).digest('hex').slice(0, 12);
  return join(dir, `${safe}-${h}.json`);
}

export function createJsonCache(o: { dir: string; clock: Clock }): JsonCache {
  let made = false;
  return {
    get(key, schema) {
      const file = fileFor(o.dir, key);
      let entry: Entry;
      try {
        entry = JSON.parse(readFileSync(file, 'utf8')) as Entry;
      } catch {
        return undefined;
      }
      if (entry?.v !== 1 || (entry.expiresAt !== null && typeof entry.expiresAt !== 'number')) return undefined;
      if (entry.expiresAt !== null && o.clock.now() >= entry.expiresAt) {
        rmSync(file, { force: true });
        return undefined;
      }
      const parsed = schema.safeParse(entry.value);
      return parsed.success ? parsed.data : undefined;
    },
    set(key, value, ttlMs) {
      if (!made) {
        mkdirSync(o.dir, { recursive: true });
        made = true;
      }
      const now = o.clock.now();
      const entry: Entry = { v: 1, storedAt: now, expiresAt: ttlMs === null ? null : now + ttlMs, value };
      const file = fileFor(o.dir, key);
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(entry));
      renameSync(tmp, file);
    },
  };
}

/** The cache for one repo and namespace: <root>/<host>/<owner>/<repo>/cache/<ns>/. */
export async function repoCache(o: {
  artifacts: ArtifactStore;
  repo: RepoRef;
  clock: Clock;
  ns: string;
}): Promise<JsonCache> {
  const dir = await o.artifacts.pathFor('cache', o.ns, o.repo);
  return createJsonCache({ dir, clock: o.clock });
}
