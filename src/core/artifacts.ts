// Artifact files (01 §8): deterministic paths under <root>/<host>/<owner>/<repo>/<kind>/<name>, so a
// repeat call reuses the file. Files older than 7 days are pruned lazily on the first write.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RepoRef } from '../gh/types.ts';
import type { Clock } from './clock.ts';

export interface ArtifactRef {
  path: string;
  bytes: number;
  sha256: string;
  kind: string;
}

export interface ArtifactStore {
  readonly root: string;
  write(a: { kind: string; name: string; content: string | Uint8Array; repo?: RepoRef }): Promise<ArtifactRef>;
  /** mkdir -p and return the absolute path (for gh stdoutFile streaming). */
  pathFor(kind: string, name: string, repo?: RepoRef): Promise<string>;
  /** Bind the default repo once the command has resolved it. */
  setRepo(repo: RepoRef): void;
}

export const PRUNE_AFTER_MS = 7 * 24 * 3_600_000;

const SAFE = /^[A-Za-z0-9._-]+$/;

function safeSegment(s: string): string {
  const t = s.replace(/[^A-Za-z0-9._-]+/g, '_');
  return t === '' || t === '.' || t === '..' ? '_' : t;
}

export function artifactRoot(env: Readonly<Record<string, string | undefined>>): string {
  return resolve(env.GHX_ARTIFACT_DIR || join(tmpdir(), 'ghx'));
}

function pruneTree(dir: string, cutoff: number): void {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    try {
      if (e.isDirectory()) pruneTree(p, cutoff);
      else if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
    } catch {
      // best effort
    }
  }
}

export function createArtifactStore(o: { root: string; clock: Clock }): ArtifactStore {
  let repo: RepoRef | undefined;
  let pruned = false;
  const dirFor = (kind: string, r: RepoRef | undefined): string => {
    const base = r
      ? join(o.root, safeSegment(r.host), safeSegment(r.owner), safeSegment(r.name))
      : join(o.root, '_local');
    return join(base, safeSegment(kind));
  };
  const pathFor = async (kind: string, name: string, r?: RepoRef): Promise<string> => {
    const dir = dirFor(kind, r ?? repo);
    mkdirSync(dir, { recursive: true });
    return join(dir, SAFE.test(name) ? name : safeSegment(name));
  };
  return {
    root: o.root,
    setRepo(r) {
      repo = r;
    },
    pathFor,
    async write(a) {
      if (!pruned) {
        pruned = true;
        pruneTree(o.root, o.clock.now() - PRUNE_AFTER_MS);
      }
      const path = await pathFor(a.kind, a.name, a.repo);
      const buf = typeof a.content === 'string' ? Buffer.from(a.content, 'utf8') : Buffer.from(a.content);
      writeFileSync(path, buf);
      return { path, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), kind: a.kind };
    },
  };
}
