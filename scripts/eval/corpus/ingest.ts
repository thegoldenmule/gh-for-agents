// Ingest: copy a corpus into ghx-eval's own store incrementally (plan 07, determinism 2), so retention in
// ~/.claude can never change a past report. Keyed by relative path and byte offset: a new file is copied, a
// grown one gets its appended bytes, and a .jsonl only ever up to its last newline. A store copy is never
// changed except by appending after a verified prefix: a shrunk or rewritten source keeps the old copy, and
// the new version is saved under divergent/<sha12>/<path> and recorded in state.json.
import { execFileSync } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { comparePaths, sha256File } from './manifest.ts';
import { storeLayout } from './paths.ts';
import { lastNewlineOffset } from './read.ts';
import { type WalkedFile, walkCorpus } from './snapshot.ts';

export const STORE_SCHEMA = 'ghx-eval/store@1';

export interface StoreEntry {
  /** Bytes held in the store. */
  size: number;
  /** sha256 of the stored bytes. */
  sha256: string;
  /** The source's size and mtime at the last ingest; equal on both means unchanged without hashing. */
  sourceSize: number;
  sourceMtime: string;
  firstIngest: string;
  lastIngest: string;
}

export interface DivergentEntry {
  path: string;
  kind: 'shrunk' | 'rewritten';
  at: string;
  source: string;
  storeSize: number;
  storeSha256: string;
  sourceSize: number;
  sourceSha256: string;
  /** Store-relative path of the saved source version. */
  savedAs: string;
}

export interface IngestCounts {
  new: number;
  grown: number;
  unchanged: number;
  divergent: number;
  /** A .jsonl with no complete line yet: nothing to copy. */
  pending: number;
  /** Not a corpus file; never copied. */
  unmatched: number;
  bytesAdded: number;
}

export interface IngestRun {
  at: string;
  source: string;
  kind: 'dir' | 'archive';
  label: string | null;
  counts: IngestCounts;
}

export interface StoreState {
  schema: typeof STORE_SCHEMA;
  files: Record<string, StoreEntry>;
  divergent: DivergentEntry[];
  runs: IngestRun[];
}

export interface IngestOptions {
  /** A directory laid out like ~/.claude/projects, or a .tar/.tar.gz/.tgz of one. */
  source: string;
  store: string;
  now: Date;
  label?: string;
}

const SAVE_EVERY = 250;

export function isArchive(path: string): boolean {
  return /\.(tar|tar\.gz|tgz)$/.test(path) && statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

export function readState(store: string): StoreState {
  const path = storeLayout(store).state;
  if (!existsSync(path)) return { schema: STORE_SCHEMA, files: {}, divergent: [], runs: [] };
  const s = JSON.parse(readFileSync(path, 'utf8')) as StoreState;
  if (s.schema !== STORE_SCHEMA) throw new Error(`${path}: unknown schema ${String(s.schema)}`);
  return s;
}

/** Atomic, stable write: file keys in path byte order. */
export function writeState(store: string, state: StoreState): void {
  const path = storeLayout(store).state;
  const files: Record<string, StoreEntry> = {};
  for (const k of Object.keys(state.files).sort(comparePaths)) files[k] = state.files[k]!;
  const text = `${JSON.stringify({ schema: state.schema, files, divergent: state.divergent, runs: state.runs }, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

/** Streams bytes [from, to) of an open file to `onChunk`. */
function readRange(fd: number, from: number, to: number, onChunk: (b: Buffer) => void): void {
  const buf = Buffer.allocUnsafe(1 << 20);
  let pos = from;
  while (pos < to) {
    const n = readSync(fd, buf, 0, Math.min(buf.length, to - pos), pos);
    if (n === 0) throw new Error(`short read at ${pos} of ${to}`);
    onChunk(buf.subarray(0, n));
    pos += n;
  }
}

/** Copies bytes [0, end) of `src` to a new file at `dest`, returning their sha256. */
function copyPrefix(src: string, dest: string, end: number): string {
  mkdirSync(dirname(dest), { recursive: true });
  const h = createHash('sha256');
  const fd = openSync(src, 'r');
  const out = openSync(`${dest}.tmp`, 'w');
  try {
    readRange(fd, 0, end, (b) => {
      h.update(b);
      writeSync(out, b);
    });
  } finally {
    closeSync(fd);
    closeSync(out);
  }
  renameSync(`${dest}.tmp`, dest);
  return h.digest('hex');
}

/** The store entry, repaired from the store file itself when state.json is missing it or disagrees. */
function currentEntry(state: StoreState, rel: string, storeFile: string, at: string): StoreEntry | undefined {
  const st = statSync(storeFile, { throwIfNoEntry: false });
  const entry = state.files[rel];
  if (!st) return undefined;
  if (entry && entry.size === st.size) return entry;
  const { size, sha256 } = sha256File(storeFile);
  const repaired: StoreEntry = {
    size,
    sha256,
    sourceSize: -1,
    sourceMtime: '',
    firstIngest: entry?.firstIngest ?? at,
    lastIngest: entry?.lastIngest ?? at,
  };
  state.files[rel] = repaired;
  return repaired;
}

function ingestFile(
  state: StoreState,
  store: string,
  sourceLabel: string,
  w: WalkedFile,
  at: string,
  counts: IngestCounts,
): void {
  const layout = storeLayout(store);
  const storeFile = join(layout.files, ...w.path.split('/'));
  const entry = currentEntry(state, w.path, storeFile, at);
  const sourceMtime = new Date(w.stat.mtimeMs).toISOString();
  if (entry && entry.sourceSize === w.stat.size && entry.sourceMtime === sourceMtime) {
    counts.unchanged++;
    return;
  }
  const avail = w.path.endsWith('.jsonl') ? lastNewlineOffset(w.abs, 0, w.stat.size) : w.stat.size;
  const touch = (e: StoreEntry): void => {
    utimesSync(storeFile, w.stat.atime, w.stat.mtime);
    e.sourceSize = w.stat.size;
    e.sourceMtime = sourceMtime;
  };

  if (!entry) {
    if (avail === 0 && w.path.endsWith('.jsonl')) {
      counts.pending++;
      return;
    }
    const sha256 = copyPrefix(w.abs, storeFile, avail);
    const e: StoreEntry = { size: avail, sha256, sourceSize: 0, sourceMtime: '', firstIngest: at, lastIngest: at };
    touch(e);
    state.files[w.path] = e;
    counts.new++;
    counts.bytesAdded += avail;
    return;
  }

  // Hash the source up to avail, checking the stored prefix before appending anything after it.
  const h = createHash('sha256');
  let prefix: Hash | undefined;
  const fd = openSync(w.abs, 'r');
  try {
    readRange(fd, 0, Math.min(entry.size, avail), (b) => h.update(b));
    if (avail >= entry.size) prefix = h.copy();
    if (prefix && prefix.digest('hex') === entry.sha256) {
      if (avail === entry.size) {
        entry.sourceSize = w.stat.size;
        entry.sourceMtime = sourceMtime;
        counts.unchanged++;
        return;
      }
      const out = openSync(storeFile, 'a');
      try {
        readRange(fd, entry.size, avail, (b) => {
          h.update(b);
          writeSync(out, b);
        });
      } finally {
        closeSync(out);
      }
      counts.grown++;
      counts.bytesAdded += avail - entry.size;
      entry.size = avail;
      entry.sha256 = h.digest('hex');
      entry.lastIngest = at;
      touch(entry);
      return;
    }
    if (avail > entry.size) readRange(fd, entry.size, avail, (b) => h.update(b));
  } finally {
    closeSync(fd);
  }

  // Shrunk or rewritten: keep the store copy, save the source version once per content hash.
  const sourceSha256 = h.digest('hex');
  const savedAs = `divergent/${sourceSha256.slice(0, 12)}/${w.path}`;
  counts.divergent++;
  if (state.divergent.some((d) => d.path === w.path && d.sourceSha256 === sourceSha256)) return;
  copyPrefix(w.abs, join(store, ...savedAs.split('/')), avail);
  state.divergent.push({
    path: w.path,
    kind: avail < entry.size ? 'shrunk' : 'rewritten',
    at,
    source: sourceLabel,
    storeSize: entry.size,
    storeSha256: entry.sha256,
    sourceSize: avail,
    sourceSha256,
    savedAs,
  });
}

/** Ingests a directory laid out like ~/.claude/projects. */
export function ingestDir(options: IngestOptions, kind: IngestRun['kind'] = 'dir', source = options.source): IngestRun {
  const store = resolve(options.store);
  const at = options.now.toISOString();
  const state = readState(store);
  const walked = walkCorpus(options.source);
  const counts: IngestCounts = {
    new: 0,
    grown: 0,
    unchanged: 0,
    divergent: 0,
    pending: 0,
    unmatched: walked.unmatched.length,
    bytesAdded: 0,
  };
  walked.files.forEach((w, i) => {
    ingestFile(state, store, source, w, at, counts);
    if ((i + 1) % SAVE_EVERY === 0) writeState(store, state);
  });
  const run: IngestRun = { at, source, kind, label: options.label ?? null, counts };
  state.runs.push(run);
  writeState(store, state);
  return run;
}

/** Ingests a tar archive: extracted to a staging dir inside the store (same filesystem), removed after. */
export function ingestArchive(options: IngestOptions): IngestRun {
  const store = resolve(options.store);
  mkdirSync(store, { recursive: true });
  const staging = mkdtempSync(join(store, '.staging-'));
  try {
    execFileSync('tar', ['-xf', resolve(options.source), '-C', staging], { stdio: ['ignore', 'ignore', 'pipe'] });
    return ingestDir({ ...options, source: staging }, 'archive', resolve(options.source));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function ingest(options: IngestOptions): IngestRun {
  return isArchive(options.source) ? ingestArchive(options) : ingestDir(options, 'dir', resolve(options.source));
}
