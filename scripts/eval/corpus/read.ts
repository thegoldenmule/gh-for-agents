// The JSONL reader every ghx-eval stage uses (plan 07, parsing rule 10). Transcripts may be live, so a read
// stops at the last newline; `stats.end` is the byte offset past it, where an incremental read resumes.
// Offsets are bytes. `start` must be a line start; `end` bounds the read (it stops at the last newline at or
// before it). A trailing `\r` is stripped from `line`. Blank lines are skipped and counted; a line that is not
// JSON is yielded with `ok: false` and counted, never thrown. `index` counts yielded entries from `start`.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { open } from 'node:fs/promises';

interface EntryBase {
  /** 0-based position among the entries yielded by this read. */
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

export interface JsonlReadOptions {
  /** Byte offset to start at; a line start. Default 0. */
  start?: number;
  /** Byte bound; reading stops at the last newline at or before it. Default: the file size at open. */
  end?: number;
  /** Read size in bytes. Default 1 MiB. */
  chunkSize?: number;
}

export interface JsonlReadStats {
  start: number;
  /** Byte offset just past the last newline consumed; resume here. Equals `start` when no line completed. */
  end: number;
  /** The bound actually used: min(options.end, file size at open). */
  limit: number;
  /** Lines consumed, blank ones included. */
  lines: number;
  records: number;
  errors: number;
  blank: number;
  /** Bytes after `end` up to `limit`: a partial last line, not yielded. */
  trailing: number;
}

const NL = 0x0a;
const DEFAULT_CHUNK = 1 << 20;

function newStats(start: number, limit: number): JsonlReadStats {
  return { start, end: start, limit, lines: 0, records: 0, errors: 0, blank: 0, trailing: 0 };
}

/** Entries in `buf`, which holds only complete lines (it ends with a newline, or is empty). */
function* completeLines(buf: Buffer, base: number, stats: JsonlReadStats): Generator<JsonlEntry> {
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(NL, pos);
    if (nl === -1) throw new Error('completeLines: buffer does not end with a newline');
    let text = buf.toString('utf8', pos, nl);
    if (text.endsWith('\r')) text = text.slice(0, -1);
    const offset = base + pos;
    const next = base + nl + 1;
    pos = nl + 1;
    stats.lines++;
    if (text.trim() === '') {
      stats.blank++;
      continue;
    }
    const index = stats.records + stats.errors;
    try {
      const record: unknown = JSON.parse(text);
      stats.records++;
      yield { ok: true, index, offset, next, line: text, record };
    } catch (e) {
      stats.errors++;
      yield { ok: false, index, offset, next, line: text, record: undefined, error: (e as Error).message };
    }
  }
}

/** Splits a chunk stream into complete lines, carrying a partial line between chunks. */
function* feed(
  carry: { buf: Buffer; base: number },
  chunk: Buffer,
  stats: JsonlReadStats,
): Generator<JsonlEntry, void, undefined> {
  const data = carry.buf.length === 0 ? chunk : Buffer.concat([carry.buf, chunk]);
  const last = data.lastIndexOf(NL);
  if (last === -1) {
    carry.buf = data;
    return;
  }
  yield* completeLines(data.subarray(0, last + 1), carry.base, stats);
  carry.base += last + 1;
  carry.buf = data.subarray(last + 1);
  stats.end = carry.base;
}

function bounds(size: number, options: JsonlReadOptions): { start: number; limit: number } {
  const start = options.start ?? 0;
  const limit = Math.min(options.end ?? size, size);
  if (!Number.isInteger(start) || start < 0) throw new Error(`readJsonl: bad start ${start}`);
  return { start, limit: Math.max(limit, start) };
}

/**
 * Streams a JSONL file in file order, stopping at the last newline. The generator's return value is the
 * read's stats; use `readJsonlAll` or `readJsonlSync` when you want both without driving `next()` by hand.
 */
export async function* readJsonl(
  path: string,
  options: JsonlReadOptions = {},
): AsyncGenerator<JsonlEntry, JsonlReadStats, undefined> {
  const fh = await open(path, 'r');
  try {
    const { start, limit } = bounds((await fh.stat()).size, options);
    const stats = newStats(start, limit);
    const chunkSize = options.chunkSize ?? DEFAULT_CHUNK;
    const carry = { buf: Buffer.alloc(0), base: start };
    let pos = start;
    while (pos < limit) {
      const want = Math.min(chunkSize, limit - pos);
      const chunk = Buffer.allocUnsafe(want);
      const { bytesRead } = await fh.read(chunk, 0, want, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      yield* feed(carry, chunk.subarray(0, bytesRead), stats);
    }
    stats.trailing = pos - stats.end;
    return stats;
  } finally {
    await fh.close();
  }
}

/** Every entry plus the stats, async. */
export async function readJsonlAll(
  path: string,
  options: JsonlReadOptions = {},
): Promise<{ entries: JsonlEntry[]; stats: JsonlReadStats }> {
  const entries: JsonlEntry[] = [];
  const it = readJsonl(path, options);
  for (;;) {
    const r = await it.next();
    if (r.done) return { entries, stats: r.value };
    entries.push(r.value);
  }
}

/** Every entry plus the stats, synchronously. Same semantics as `readJsonl`. */
export function readJsonlSync(
  path: string,
  options: JsonlReadOptions = {},
): { entries: JsonlEntry[]; stats: JsonlReadStats } {
  const fd = openSync(path, 'r');
  try {
    const { start, limit } = bounds(fstatSync(fd).size, options);
    const stats = newStats(start, limit);
    const chunkSize = options.chunkSize ?? DEFAULT_CHUNK;
    const carry = { buf: Buffer.alloc(0), base: start };
    const entries: JsonlEntry[] = [];
    let pos = start;
    while (pos < limit) {
      const want = Math.min(chunkSize, limit - pos);
      const chunk = Buffer.allocUnsafe(want);
      const bytesRead = readSync(fd, chunk, 0, want, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      for (const e of feed(carry, chunk.subarray(0, bytesRead), stats)) entries.push(e);
    }
    stats.trailing = pos - stats.end;
    return { entries, stats };
  } finally {
    closeSync(fd);
  }
}

/** Parses JSONL already in memory, with the same semantics; `base` is the byte offset of `buf[0]`. */
export function parseJsonl(input: Uint8Array | string, base = 0): { entries: JsonlEntry[]; stats: JsonlReadStats } {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  const stats = newStats(base, base + buf.length);
  const carry = { buf: Buffer.alloc(0), base };
  const entries = [...feed(carry, buf, stats)];
  stats.trailing = base + buf.length - stats.end;
  return { entries, stats };
}
