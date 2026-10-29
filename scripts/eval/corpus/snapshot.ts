// Snapshot: walk a corpus root and build its manifest (plan 07, determinism 1 and 6). Included files are
// transcripts, subagent meta and skill-fork files (findings §1.1); everything else is counted as unmatched.
// Files modified within `windowHours` of the injected `now` may still be live and are counted as recent.
import { type Dirent, readdirSync, type Stats, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MANIFEST_SCHEMA, type Manifest, type ManifestFile, manifestHash, sha256File, sortFiles } from './manifest.ts';

export const INCLUDE = ['*.jsonl', '*.meta.json', '*.forked-skill*.json'];
export const DEFAULT_WINDOW_HOURS = 6;

/** Whether a file name is part of the corpus: `*.jsonl`, `*.meta.json` or `*.forked-skill*.json`. */
export function isCorpusFile(name: string): boolean {
  return name.endsWith('.jsonl') || name.endsWith('.meta.json') || /\.forked-skill[^/]*\.json$/.test(name);
}

export interface WalkedFile {
  /** POSIX path relative to the root. */
  path: string;
  abs: string;
  stat: Stats;
}

/** Every regular file under `root` (symlinks are not followed), split into corpus files and the rest. */
export function walkCorpus(root: string): { files: WalkedFile[]; unmatched: WalkedFile[] } {
  const files: WalkedFile[] = [];
  const unmatched: WalkedFile[] = [];
  const visit = (dir: string, prefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (prefix === '') throw e;
      return;
    }
    for (const d of entries) {
      const abs = join(dir, d.name);
      const path = prefix === '' ? d.name : `${prefix}/${d.name}`;
      if (d.isDirectory()) {
        visit(abs, path);
        continue;
      }
      const stat = statSync(abs, { throwIfNoEntry: false });
      if (!stat) continue;
      const w = { path, abs, stat };
      (d.isFile() && isCorpusFile(d.name) ? files : unmatched).push(w);
    }
  };
  visit(resolve(root), '');
  return { files: sortFiles(files), unmatched: sortFiles(unmatched) };
}

export interface SnapshotOptions {
  root: string;
  /** Injected clock; library code never reads the wall clock. */
  now: Date;
  windowHours?: number;
}

/** Builds the manifest of `root`. Its `root` is absolute; `writeManifest` makes it relative. */
export function snapshot(options: SnapshotOptions): Manifest {
  const windowHours = options.windowHours ?? DEFAULT_WINDOW_HOURS;
  const cutoffMs = options.now.getTime() - windowHours * 3_600_000;
  const walked = walkCorpus(options.root);
  const files: ManifestFile[] = [];
  const recent = { files: 0, bytes: 0 };
  for (const w of walked.files) {
    if (w.stat.mtimeMs > cutoffMs) {
      recent.files++;
      recent.bytes += w.stat.size;
      continue;
    }
    const { size, sha256 } = sha256File(w.abs, w.stat.size);
    files.push({ path: w.path, size, mtime: new Date(w.stat.mtimeMs).toISOString(), sha256 });
  }
  return {
    schema: MANIFEST_SCHEMA,
    hash: manifestHash(files),
    root: resolve(options.root),
    createdAt: options.now.toISOString(),
    cutoff: new Date(cutoffMs).toISOString(),
    windowHours,
    include: [...INCLUDE],
    counts: { files: files.length, bytes: files.reduce((s, f) => s + f.size, 0) },
    excluded: {
      recent,
      unmatched: {
        files: walked.unmatched.length,
        bytes: walked.unmatched.reduce((s, w) => s + w.stat.size, 0),
      },
    },
    files,
  };
}
