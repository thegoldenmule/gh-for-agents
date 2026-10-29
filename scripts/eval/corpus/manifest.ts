// A manifest freezes a corpus (plan 07, determinism 1): a run reads a manifest, not a directory. The hash
// covers path, size and sha256 only. mtime is metadata: git does not keep it, and a checked-in fixture
// corpus must hash the same on a fresh clone. Paths sort by UTF-8 bytes and serialisation has a fixed key
// order, so the same inputs give the same bytes. `root` is written relative to the manifest's directory.
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

export const MANIFEST_SCHEMA = 'ghx-eval/manifest@1';

export interface ManifestFile {
  /** POSIX path relative to the manifest root. */
  path: string;
  size: number;
  /** ISO-8601 UTC, ms precision. Metadata only: not in the hash. */
  mtime: string;
  sha256: string;
}

export interface Manifest {
  schema: typeof MANIFEST_SCHEMA;
  /** manifestHash(files). */
  hash: string;
  /** Corpus root; relative to the manifest file's directory when read from or written to disk. */
  root: string;
  /** The injected `now` of the snapshot. */
  createdAt: string;
  /** Files with mtime after this were excluded as possibly live. */
  cutoff: string;
  windowHours: number;
  include: string[];
  counts: { files: number; bytes: number };
  /** Counted, never dropped silently (determinism 6). */
  excluded: { recent: { files: number; bytes: number }; unmatched: { files: number; bytes: number } };
  files: ManifestFile[];
}

/** Byte order of the UTF-8 encodings, the one sort used for paths everywhere in ghx-eval. */
export function comparePaths(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function sortFiles<T extends { path: string }>(files: readonly T[]): T[] {
  return [...files].sort((a, b) => comparePaths(a.path, b.path));
}

/** sha256 over `${path}\t${size}\t${sha256}\n` for each file, in path byte order. */
export function manifestHash(files: readonly Pick<ManifestFile, 'path' | 'size' | 'sha256'>[]): string {
  const h = createHash('sha256');
  for (const f of sortFiles(files)) h.update(`${f.path}\t${f.size}\t${f.sha256}\n`, 'utf8');
  return h.digest('hex');
}

/** sha256 and byte count of the first `limit` bytes of a file (default: all of it). */
export function sha256File(path: string, limit?: number): { size: number; sha256: string } {
  const fd = openSync(path, 'r');
  try {
    const end = Math.min(limit ?? Number.POSITIVE_INFINITY, fstatSync(fd).size);
    const h = createHash('sha256');
    const buf = Buffer.allocUnsafe(1 << 20);
    let pos = 0;
    while (pos < end) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, end - pos), pos);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
      pos += n;
    }
    return { size: pos, sha256: h.digest('hex') };
  } finally {
    closeSync(fd);
  }
}

/** Stable serialisation: fixed key order, files sorted, two-space JSON, trailing newline. */
export function serializeManifest(m: Manifest): string {
  const ordered: Manifest = {
    schema: m.schema,
    hash: m.hash,
    root: m.root,
    createdAt: m.createdAt,
    cutoff: m.cutoff,
    windowHours: m.windowHours,
    include: [...m.include],
    counts: { files: m.counts.files, bytes: m.counts.bytes },
    excluded: {
      recent: { files: m.excluded.recent.files, bytes: m.excluded.recent.bytes },
      unmatched: { files: m.excluded.unmatched.files, bytes: m.excluded.unmatched.bytes },
    },
    files: sortFiles(m.files).map((f) => ({ path: f.path, size: f.size, mtime: f.mtime, sha256: f.sha256 })),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

const Count = z.object({ files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() });
const ManifestSchema = z.object({
  schema: z.literal(MANIFEST_SCHEMA),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  root: z.string(),
  createdAt: z.string(),
  cutoff: z.string(),
  windowHours: z.number().nonnegative(),
  include: z.array(z.string()),
  counts: Count,
  excluded: z.object({ recent: Count, unmatched: Count }),
  files: z.array(
    z.object({
      path: z.string().min(1),
      size: z.number().int().nonnegative(),
      mtime: z.string(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
});

/** Parses and checks a manifest: schema, sorted unique paths, counts, and that `hash` matches the files. */
export function parseManifest(text: string): Manifest {
  const m = ManifestSchema.parse(JSON.parse(text)) as Manifest;
  for (let i = 1; i < m.files.length; i++) {
    if (comparePaths(m.files[i - 1]!.path, m.files[i]!.path) >= 0) {
      throw new Error(`manifest: paths not sorted and unique at ${m.files[i]!.path}`);
    }
  }
  const bytes = m.files.reduce((s, f) => s + f.size, 0);
  if (m.counts.files !== m.files.length || m.counts.bytes !== bytes) throw new Error('manifest: counts mismatch');
  const hash = manifestHash(m.files);
  if (hash !== m.hash) throw new Error(`manifest: hash ${m.hash} does not match its files (${hash})`);
  return m;
}

/** Reads a manifest file; `rootDir` is its root resolved against the manifest's directory. */
export function readManifest(path: string): { manifest: Manifest; rootDir: string } {
  const manifest = parseManifest(readFileSync(path, 'utf8'));
  return { manifest, rootDir: resolve(dirname(path), manifest.root) };
}

/** Writes a manifest whose `root` is absolute (or cwd-relative), rewriting root relative to `path`'s dir. */
export function writeManifest(path: string, manifest: Manifest): string {
  const abs = resolve(path);
  const rootAbs = resolve(manifest.root);
  const rel = relative(dirname(abs), rootAbs).split(sep).join('/') || '.';
  const text = serializeManifest({ ...manifest, root: rel });
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return text;
}

/** Absolute path of a manifest entry. */
export function manifestFilePath(rootDir: string, file: Pick<ManifestFile, 'path'>): string {
  if (isAbsolute(file.path) || file.path.split('/').includes('..')) throw new Error(`manifest: bad path ${file.path}`);
  return join(rootDir, ...file.path.split('/'));
}

export interface VerifyResult {
  ok: boolean;
  missing: string[];
  /** Size or sha256 differs. mtime is never checked. */
  changed: string[];
}

/** Checks every manifest file against disk by size and sha256. */
export function verifyManifest(manifest: Manifest, rootDir: string): VerifyResult {
  const missing: string[] = [];
  const changed: string[] = [];
  for (const f of manifest.files) {
    let got: { size: number; sha256: string };
    try {
      got = sha256File(manifestFilePath(rootDir, f));
    } catch {
      missing.push(f.path);
      continue;
    }
    if (got.size !== f.size || got.sha256 !== f.sha256) changed.push(f.path);
  }
  return { ok: missing.length === 0 && changed.length === 0, missing, changed };
}
