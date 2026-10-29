// Manifest → the five tables (plan 07, "Data model"), one session at a time so the raw records of only one
// session are in memory at once. Determinism 1: a run reads a manifest, not a directory. Each file is read
// up to the manifest's size (the ingest store is append-only, so a file may have grown since) and its
// sha256 must match, else the run fails. Parse errors are counted here because Tables.counts has no field
// for them; report.json shows them in its `excluded` block.
//
// The tables are cached as JSONL next to the manifest, in `<manifest>.tables/<key>/`, keyed by the manifest
// hash, METRIC_VERSION, the price table version and the era config. A warm run returns exactly what a cold
// run built (counts and parse stats included), so the report does not depend on the cache.
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { type Manifest, manifestFilePath, readManifest } from './corpus/manifest.ts';
import { parseJsonl } from './corpus/read.ts';
import { CATALOG, CONSTANTS, METRIC_VERSION } from './metrics/catalog.ts';
import { PRICE_TABLE_VERSION } from './model/pricing.ts';
import {
  buildSessionTables,
  DEFAULT_ERA_CONFIG,
  type EraConfig,
  emptyCounts,
  groupBySession,
  type InputFile,
  mergeCounts,
  type Tables,
} from './model/session.ts';
import { type BaselineDiff, buildReport, type Report, summarizeTables } from './report/json.ts';
import { buildUnits } from './units/index.ts';

/** Bump when model/session.ts changes a row's shape or meaning: the cache key does not cover that code. */
export const TABLES_CACHE_SCHEMA = 'ghx-eval/tables@1';
const TABLE_NAMES = ['sessions', 'agents', 'turns', 'api_calls', 'tool_calls'] as const;

/** What reading the manifest's files turned up; counted, never dropped silently (determinism 6). */
export interface ParseStats {
  /** Manifest files read. */
  files: number;
  /** JSONL lines that are not JSON. */
  error_lines: number;
  error_files: number;
  /** Bytes after a file's last newline (a partial last line), never parsed. */
  trailing_bytes: number;
  trailing_files: number;
  /** .json files (agent meta, skill-fork markers) that are not JSON. */
  json_errors: number;
  /** Manifest files that belong to no session (not under <project>/<session>...). */
  outside_sessions: number;
}

export function emptyParseStats(): ParseStats {
  return {
    files: 0,
    error_lines: 0,
    error_files: 0,
    trailing_bytes: 0,
    trailing_files: 0,
    json_errors: 0,
    outside_sessions: 0,
  };
}

export interface Corpus {
  manifest: Manifest;
  tables: Tables;
  parse: ParseStats;
  /** Where the tables were cached, and whether this run read them from there. */
  cache: { dir: string; hit: boolean } | null;
}

export interface LoadOptions {
  era?: EraConfig;
  /** Part of the cache key; the caller passes the catalog's METRIC_VERSION. */
  metricVersion: string;
  /** false: neither read nor write the cache (tests, golden runs). Default true. */
  cache?: boolean;
  /** Override the cache directory (default `<manifest dir>/<manifest name>.tables`). */
  cacheRoot?: string;
}

/** Reads the first `size` bytes of a manifest file and checks them against its sha256. */
export function readFrozen(rootDir: string, file: Manifest['files'][number]): Buffer {
  const path = manifestFilePath(rootDir, file);
  const fd = openSync(path, 'r');
  let buf: Buffer;
  try {
    buf = Buffer.allocUnsafe(file.size);
    let pos = 0;
    while (pos < file.size) {
      const n = readSync(fd, buf, pos, file.size - pos, pos);
      if (n === 0) break;
      pos += n;
    }
    if (pos !== file.size) throw new Error(`${file.path}: ${pos} bytes on disk, manifest says ${file.size}`);
  } finally {
    closeSync(fd);
  }
  const sha = createHash('sha256').update(buf).digest('hex');
  if (sha !== file.sha256) throw new Error(`${file.path}: sha256 ${sha} does not match the manifest`);
  return buf;
}

/** Decodes one file: JSONL to the last newline (rule 10), .json as one record. Updates `parse`. */
export function decodeFile(path: string, buf: Buffer, parse: ParseStats): InputFile {
  parse.files++;
  if (path.endsWith('.jsonl')) {
    const { entries, stats } = parseJsonl(buf);
    if (stats.errors > 0) {
      parse.error_lines += stats.errors;
      parse.error_files++;
    }
    if (stats.trailing > 0) {
      parse.trailing_bytes += stats.trailing;
      parse.trailing_files++;
    }
    const records: unknown[] = [];
    for (const e of entries) if (e.ok) records.push(e.record);
    return { path, records };
  }
  try {
    return { path, records: [JSON.parse(buf.toString('utf8'))] };
  } catch {
    parse.json_errors++;
    return { path, records: [] };
  }
}

/** Builds the tables for a manifest, session by session, with no cache. */
export function buildFromManifest(
  manifest: Manifest,
  rootDir: string,
  era: EraConfig = DEFAULT_ERA_CONFIG,
): { tables: Tables; parse: ParseStats } {
  const parse = emptyParseStats();
  const tables: Tables = { sessions: [], agents: [], turns: [], api_calls: [], tool_calls: [], counts: emptyCounts() };
  const byPath = new Map(manifest.files.map((f) => [f.path, f]));
  const groups = groupBySession(manifest.files.map((f) => f.path));
  const grouped = new Set(groups.flatMap((g) => g.paths));
  for (const f of manifest.files) {
    if (grouped.has(f.path)) continue;
    // Still verified, so a report never rests on a file that changed.
    readFrozen(rootDir, f);
    parse.files++;
    parse.outside_sessions++;
  }
  for (const { paths } of groups) {
    const input = paths.map((p) =>
      decodeFile(p, readFrozen(rootDir, byPath.get(p) as Manifest['files'][number]), parse),
    );
    const t = buildSessionTables(input, { era });
    for (const name of TABLE_NAMES) {
      const into = tables[name] as unknown[];
      for (const row of t[name]) into.push(row);
    }
    tables.counts = mergeCounts(tables.counts, t.counts);
  }
  tables.counts = mergeCounts(tables.counts, emptyCounts());
  return { tables, parse };
}

/** The cache key: everything the tables depend on besides the code itself. */
export function cacheKey(manifestHash: string, metricVersion: string, era: EraConfig): string {
  const eraCanon = {
    adoptions: Object.fromEntries(Object.entries(era.adoptions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    devProjectMarkers: [...era.devProjectMarkers],
  };
  const text = JSON.stringify({
    schema: TABLES_CACHE_SCHEMA,
    manifest: manifestHash,
    metric: metricVersion,
    prices: PRICE_TABLE_VERSION,
    era: eraCanon,
  });
  return `${manifestHash.slice(0, 12)}-${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
}

function writeJsonl(path: string, rows: readonly unknown[]): void {
  const fd = openSync(path, 'w');
  try {
    let chunk: string[] = [];
    let size = 0;
    for (const r of rows) {
      const line = `${JSON.stringify(r)}\n`;
      chunk.push(line);
      size += line.length;
      if (size > 1 << 22) {
        writeSync(fd, chunk.join(''));
        chunk = [];
        size = 0;
      }
    }
    if (chunk.length) writeSync(fd, chunk.join(''));
  } finally {
    closeSync(fd);
  }
}

function readJsonlRows(path: string): unknown[] {
  const buf = readFileSync(path);
  const rows: unknown[] = [];
  let start = 0;
  for (;;) {
    const nl = buf.indexOf(0x0a, start);
    if (nl === -1) break;
    if (nl > start) rows.push(JSON.parse(buf.toString('utf8', start, nl)));
    start = nl + 1;
  }
  return rows;
}

/** Writes the tables to `dir` (atomically: a temp dir renamed into place, `key.json` written last). */
export function writeTablesCache(dir: string, key: string, tables: Tables, parse: ParseStats): void {
  const tmp = `${dir}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  for (const name of TABLE_NAMES) writeJsonl(join(tmp, `${name}.jsonl`), tables[name]);
  writeFileSync(join(tmp, 'counts.json'), `${JSON.stringify(tables.counts)}\n`);
  writeFileSync(join(tmp, 'parse.json'), `${JSON.stringify(parse)}\n`);
  writeFileSync(join(tmp, 'key.json'), `${JSON.stringify({ schema: TABLES_CACHE_SCHEMA, key })}\n`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  renameSync(tmp, dir);
}

/** Reads cached tables, or null when `dir` holds no complete cache for `key`. */
export function readTablesCache(dir: string, key: string): { tables: Tables; parse: ParseStats } | null {
  const keyFile = join(dir, 'key.json');
  if (!existsSync(keyFile)) return null;
  const k = JSON.parse(readFileSync(keyFile, 'utf8')) as { schema?: string; key?: string };
  if (k.schema !== TABLES_CACHE_SCHEMA || k.key !== key) return null;
  const tables = { counts: JSON.parse(readFileSync(join(dir, 'counts.json'), 'utf8')) } as Tables;
  for (const name of TABLE_NAMES)
    (tables as unknown as Record<string, unknown[]>)[name] = readJsonlRows(join(dir, `${name}.jsonl`));
  const parse = JSON.parse(readFileSync(join(dir, 'parse.json'), 'utf8')) as ParseStats;
  return { tables, parse };
}

/** Manifest file → verified, decoded, modelled corpus; from the cache when it holds this key. */
export function loadCorpus(manifestPath: string, opts: LoadOptions): Corpus {
  const { manifest, rootDir } = readManifest(manifestPath);
  const era = opts.era ?? DEFAULT_ERA_CONFIG;
  if (opts.cache === false) return { manifest, ...buildFromManifest(manifest, rootDir, era), cache: null };
  const key = cacheKey(manifest.hash, opts.metricVersion, era);
  const root = opts.cacheRoot ?? join(dirname(manifestPath), `${basename(manifestPath, '.json')}.tables`);
  const dir = join(root, key);
  const cached = readTablesCache(dir, key);
  if (cached) return { manifest, ...cached, cache: { dir, hit: true } };
  const built = buildFromManifest(manifest, rootDir, era);
  writeTablesCache(dir, key, built.tables, built.parse);
  return { manifest, ...built, cache: { dir, hit: false } };
}

const EraConfigSchema = z.object({
  adoptions: z.record(z.string(), z.string()),
  devProjectMarkers: z.array(z.string()),
});

/** An era config file: `{ "adoptions": { "<project slug>": "<ISO time>" }, "devProjectMarkers": [...] }`. */
export function readEraConfig(path: string): EraConfig {
  const cfg = EraConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  for (const [k, t] of Object.entries(cfg.adoptions)) {
    if (Number.isNaN(Date.parse(t))) throw new Error(`era config: adoption time for ${k} is not ISO-8601: ${t}`);
  }
  return cfg;
}

export interface ObserveOptions {
  era?: EraConfig;
  cache?: boolean;
  cacheRoot?: string;
  baseline?: (report: Report) => BaselineDiff;
}

/** Tier 1 end to end: manifest → tables → units → report.json (plan 07 "observe"). */
export function observe(manifestPath: string, opts: ObserveOptions = {}): { report: Report; corpus: Corpus } {
  const era = opts.era ?? DEFAULT_ERA_CONFIG;
  const corpus = loadCorpus(manifestPath, {
    era,
    metricVersion: METRIC_VERSION,
    ...(opts.cache !== undefined ? { cache: opts.cache } : {}),
    ...(opts.cacheRoot !== undefined ? { cacheRoot: opts.cacheRoot } : {}),
  });
  const units = buildUnits(corpus.tables, { era });
  const report = buildReport({
    manifest: corpus.manifest,
    corpus: summarizeTables(corpus.tables),
    counts: corpus.tables.counts,
    parse: corpus.parse,
    units,
    definitions: { metricVersion: METRIC_VERSION, constants: CONSTANTS, catalog: CATALOG },
    era,
  });
  if (opts.baseline) report.baseline = opts.baseline(report);
  return { report, corpus };
}
