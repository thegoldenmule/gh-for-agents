// Reading a Claude Code projects directory in place (parsing rule 10). Sessions may be live, so a JSONL read
// stops at the last newline and counts what follows as a partial last line. Files are found by walking the
// directory in UTF-8 byte order of their paths, so the same files on disk give the same order anywhere.
// Offsets are bytes. A trailing `\r` is stripped from `line`. Blank lines are skipped and counted; a line
// that is not JSON is returned with `ok: false` and counted, never thrown.
import { type Dirent, readdirSync, type Stats, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------------------------- files

/** Byte order of the UTF-8 encodings, the one sort used for paths everywhere in ghx-eval. */
export function comparePaths(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Whether a file is read: `*.jsonl` transcripts, `*.meta.json` subagent meta, `*.forked-skill*.json` markers. */
export function isSessionFile(name: string): boolean {
  return name.endsWith('.jsonl') || name.endsWith('.meta.json') || /\.forked-skill[^/]*\.json$/.test(name);
}

export interface WalkedFile {
  /** POSIX path relative to the root. */
  path: string;
  abs: string;
  stat: Stats;
}

/**
 * Every regular file under `root` (symlinks below it are not followed), split into session files and the
 * rest, each sorted by path. Throws when `root` cannot be read.
 */
export function walkProjects(root: string): { files: WalkedFile[]; unmatched: WalkedFile[] } {
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
      (d.isFile() && isSessionFile(d.name) ? files : unmatched).push({ path, abs, stat });
    }
  };
  visit(resolve(root), '');
  const byPath = (a: WalkedFile, b: WalkedFile): number => comparePaths(a.path, b.path);
  return { files: files.sort(byPath), unmatched: unmatched.sort(byPath) };
}

// ---------------------------------------------------------------------------------------------- JSONL

interface EntryBase {
  /** 0-based position among the entries returned. */
  index: number;
  /** Byte offset of the line's first byte. */
  offset: number;
  /** Byte offset just past the line's newline. */
  next: number;
  /** The line's text without the newline (and without a trailing `\r`). */
  line: string;
}
export interface JsonlRecord extends EntryBase {
  ok: true;
  record: unknown;
}
export interface JsonlParseError extends EntryBase {
  ok: false;
  record: undefined;
  error: string;
}
export type JsonlEntry = JsonlRecord | JsonlParseError;

export interface JsonlReadStats {
  /** Byte offset just past the last newline. */
  end: number;
  /** Lines consumed, blank ones included. */
  lines: number;
  records: number;
  errors: number;
  blank: number;
  /** Bytes after the last newline: a partial last line, not returned. */
  trailing: number;
}

const NL = 0x0a;

/** Parses JSONL in memory up to its last newline. */
export function parseJsonl(input: Uint8Array | string): { entries: JsonlEntry[]; stats: JsonlReadStats } {
  const buf =
    typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.isBuffer(input) ? input : Buffer.from(input);
  const end = buf.lastIndexOf(NL) + 1;
  const stats: JsonlReadStats = { end, lines: 0, records: 0, errors: 0, blank: 0, trailing: buf.length - end };
  const entries: JsonlEntry[] = [];
  let pos = 0;
  while (pos < end) {
    const nl = buf.indexOf(NL, pos);
    let text = buf.toString('utf8', pos, nl);
    if (text.endsWith('\r')) text = text.slice(0, -1);
    const offset = pos;
    const next = nl + 1;
    pos = next;
    stats.lines++;
    if (text.trim() === '') {
      stats.blank++;
      continue;
    }
    const index = entries.length;
    try {
      const record: unknown = JSON.parse(text);
      stats.records++;
      entries.push({ ok: true, index, offset, next, line: text, record });
    } catch (e) {
      stats.errors++;
      entries.push({ ok: false, index, offset, next, line: text, record: undefined, error: (e as Error).message });
    }
  }
  return { entries, stats };
}
