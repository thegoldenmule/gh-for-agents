// A projects directory → the five tables → units → report.json (plan 07). Files are read in place, one
// session at a time, so the raw records of only one session are in memory at once. JSONL files are read up
// to their last newline: a session still being written contributes what it has so far. Everything read is
// counted; parse errors are counted here because Tables.counts has no field for them, and report.json shows
// them in its `excluded` block.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { CATALOG, CONSTANTS, METRIC_VERSION } from './metrics/catalog.ts';
import { parseJsonl, walkProjects } from './model/read.ts';
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
import { buildReport, type Report, summarizeTables } from './report/json.ts';
import { buildUnits } from './units/index.ts';

const TABLE_NAMES = ['sessions', 'agents', 'turns', 'api_calls', 'tool_calls'] as const;

/** What reading the projects directory turned up; counted, never dropped silently. */
export interface ParseStats {
  /** Session files read (`*.jsonl`, `*.meta.json`, skill-fork markers). */
  files: number;
  /** Bytes parsed: JSONL up to each file's last newline, .json files whole. */
  bytes: number;
  /** Other files under the directory (persisted tool results and the like), not read. */
  unmatched_files: number;
  /** JSONL lines that are not JSON. */
  error_lines: number;
  error_files: number;
  /** Bytes after a file's last newline (a partial last line), not parsed. */
  trailing_bytes: number;
  trailing_files: number;
  /** .json files (agent meta, skill-fork markers) that are not JSON. */
  json_errors: number;
  /** Session files that belong to no session (not under <project>/<session>...). */
  outside_sessions: number;
}

export function emptyParseStats(): ParseStats {
  return {
    files: 0,
    bytes: 0,
    unmatched_files: 0,
    error_lines: 0,
    error_files: 0,
    trailing_bytes: 0,
    trailing_files: 0,
    json_errors: 0,
    outside_sessions: 0,
  };
}

/** Claude Code's projects directory: `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`. */
export function defaultProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
}

/** Decodes one file: JSONL to the last newline (rule 10), .json as one record. Updates `parse`. */
export function decodeFile(path: string, buf: Buffer, parse: ParseStats): InputFile {
  parse.files++;
  if (path.endsWith('.jsonl')) {
    const { entries, stats } = parseJsonl(buf);
    parse.bytes += stats.end;
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
  parse.bytes += buf.length;
  try {
    return { path, records: [JSON.parse(buf.toString('utf8'))] };
  } catch {
    parse.json_errors++;
    return { path, records: [] };
  }
}

/** Reads every session under `root` and builds the tables, session by session. */
export function loadProjects(root: string, era: EraConfig = DEFAULT_ERA_CONFIG): { tables: Tables; parse: ParseStats } {
  const walked = walkProjects(root);
  const parse = emptyParseStats();
  parse.unmatched_files = walked.unmatched.length;
  const tables: Tables = { sessions: [], agents: [], turns: [], api_calls: [], tool_calls: [], counts: emptyCounts() };
  const absOf = new Map(walked.files.map((f) => [f.path, f.abs]));
  const groups = groupBySession(walked.files.map((f) => f.path));
  const grouped = new Set(groups.flatMap((g) => g.paths));
  for (const f of walked.files) {
    if (grouped.has(f.path)) continue;
    parse.files++;
    parse.outside_sessions++;
  }
  for (const { paths } of groups) {
    const input = paths.map((p) => decodeFile(p, readFileSync(absOf.get(p) as string), parse));
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

/** The whole tool: the sessions under `root` → report.json. */
export function evaluate(root: string, opts: { era?: EraConfig } = {}): Report {
  const era = opts.era ?? DEFAULT_ERA_CONFIG;
  const { tables, parse } = loadProjects(root, era);
  return buildReport({
    corpus: summarizeTables(tables),
    counts: tables.counts,
    parse,
    units: buildUnits(tables, { era }),
    definitions: { metricVersion: METRIC_VERSION, constants: CONSTANTS, catalog: CATALOG },
    era,
  });
}
