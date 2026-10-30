// The five tables of plan 07 (sessions, agents, turns, api_calls, tool_calls), built from already-decoded
// corpus files. Pure: the caller reads the files (scripts/eval/model/read.ts) and passes their records;
// the path says what each file is (records.ts fileKind). Files are processed in path order and records in
// file order; timestamps are values only, never structure.
import { type CommandCli, classifyCommand, type Glue } from '../classify/command.ts';
import { classifyResult, type ErrorKind, type Failure, type GhxOutcome, type Refusal } from '../classify/errors.ts';
import { commandIntent, type Intent } from '../classify/intent.ts';
import {
  type AssistantGroup,
  dedupeNotifications,
  groupAssistantRecords,
  lastOfType,
  type NotificationSighting,
  ownersByMessageId,
} from './dedupe.ts';
import {
  backgroundTaskIdFromText,
  backgroundTaskIdOf,
  monitorTaskIdOf,
  parseNotification,
  textOf,
} from './notifications.ts';
import { advisorCost, callCost, executorInput } from './pricing.ts';
import {
  type AgentMeta,
  AgentMetaSchema,
  type AssistantRecord,
  type Block,
  type CostStateRecord,
  type FileInfo,
  fileKind,
  type ParsedRecord,
  parseRecord,
  type UserRecord,
} from './records.ts';
import {
  type AdvisorTokens,
  advisorIterations,
  codePointLength,
  contextTokens,
  isPersisted,
  nextCallAfter,
  type OutSrc,
  pyJsonDumps,
  type RecoveryCall,
  recoverOutputs,
  resultText,
} from './usage.ts';

// ---------------------------------------------------------------------------------------------- config

export type Era = 'gh-pre' | 'ghx-post' | 'dogfood-dev' | 'never-adopted';
/** Comparison buckets: an era, with raw gh after adoption split out as gh-post. */
export type Bucket = Era | 'gh-post';

export interface EraConfig {
  /** Project slug (cwd slug under ~/.claude/projects) → adoption time (ISO-8601 UTC). */
  adoptions: Readonly<Record<string, string>>;
  /** A project whose slug contains one of these is ghx's own development (this repo, spike directories). */
  devProjectMarkers: readonly string[];
}

/**
 * Defaults for the 2026-10-29 corpus. powerhouse got `.github/ghx.json` (and the hook, CLAUDE.md block and
 * memory) on 2026-10-23; the time is its first non-meta ghx call (episodes/report-gap10.md). This repo and
 * the hook-spike directories are dogfood-dev.
 */
export const DEFAULT_ERA_CONFIG: EraConfig = {
  adoptions: { '-Users-benjaminjordan-projects-powerhouse-powerhouse': '2026-10-23T18:39:39.227Z' },
  devProjectMarkers: ['gh-for-agents', 'ghx-spike', 'hookspike'],
};

export function isDevProject(project: string, cfg: EraConfig = DEFAULT_ERA_CONFIG): boolean {
  return cfg.devProjectMarkers.some((m) => project.includes(m));
}

/** The era of work in `project` at `ts` (null ts: before adoption is unknowable, so gh-pre). */
export function eraAt(project: string, ts: string | null, cfg: EraConfig = DEFAULT_ERA_CONFIG): Era {
  if (isDevProject(project, cfg)) return 'dogfood-dev';
  const adopted = cfg.adoptions[project];
  if (adopted === undefined) return 'never-adopted';
  if (ts === null) return 'gh-pre';
  return Date.parse(ts) >= Date.parse(adopted) ? 'ghx-post' : 'gh-pre';
}

/** The comparison bucket of a GitHub call: raw gh in the ghx era is gh-post. */
export function bucketOf(era: Era, cli: CommandCli | null): Bucket {
  return era === 'ghx-post' && cli === 'gh' ? 'gh-post' : era;
}

// ---------------------------------------------------------------------------------------------- rows

export interface PrLink {
  number: number | null;
  repo: string | null;
  url: string | null;
}

export interface CostStateSummary {
  total_usd: number;
  start_time: number | null;
  n_records: number;
  n_starts: number;
  /** Assistant records after the last cost-state: a later process that never wrote one. */
  trailing_assistant_records: number;
  /**
   * Not one process from start to end: several start times, a total that went down, a process that started
   * well after the session's first record, or calls after the last cost-state.
   */
  resumed: boolean;
  model_usage: Record<
    string,
    { cost_usd: number; input: number; output: number; cache_read: number; cache_creation: number }
  >;
}

export interface SessionRow {
  session_id: string;
  project: string;
  cwd: string | null;
  version: string | null;
  versions: string[];
  entrypoint: string | null;
  first_ts: string | null;
  last_ts: string | null;
  title: string | null;
  agent_name: string | null;
  n_compactions: number;
  pr_links: PrLink[];
  era: Era;
  is_dev: boolean;
  has_main_file: boolean;
  n_files: number;
  n_agents: number;
  n_turns: number;
  n_human_turns: number;
  n_api_calls: number;
  n_tool_calls: number;
  cost_usd: number;
  cost_state: CostStateSummary | null;
}

export interface AgentRow {
  agent_id: string;
  session_id: string;
  file: string | null;
  /** The agent whose file holds the spawning tool_use; null for the main thread or when unlinked. */
  parent_agent_id: string | null;
  spawn_tool_use_id: string | null;
  spawn_tool: string | null;
  linked_via: 'tool_use_id' | 'skill_result' | null;
  /** meta.parentAgentId disagreed with the file holding the tool_use (the file wins). */
  parent_mismatch: boolean;
  agent_type: string | null;
  description: string | null;
  request_shape: string | null;
  spawn_depth: number | null;
  model: string | null;
  is_fork: boolean;
  skill_fork: boolean;
  has_meta: boolean;
  n_api_calls: number;
}

export type StarterKind =
  | 'human'
  | 'task_notification'
  | 'peer'
  | 'sdk'
  | 'auto_continuation'
  | 'scheduled'
  | 'coordinator'
  | 'command'
  | 'interrupt'
  | 'meta'
  | 'spawn'
  | 'other';

export interface TurnRow {
  turn_id: string;
  session_id: string;
  agent_id: string | null;
  file: string;
  prompt_id: string | null;
  starter_kind: StarterKind;
  is_human: boolean;
  start_ts: string | null;
  end_ts: string | null;
  interrupted: boolean;
  n_api_calls: number;
}

export interface ApiCallRow {
  message_id: string;
  session_id: string;
  agent_id: string | null;
  file: string;
  turn_id: string | null;
  /** Position among the file's calls (copies included), file order. */
  call_index: number;
  model: string | null;
  ts: string | null;
  last_ts: string | null;
  n_records: number;
  stop_reason: string | null;
  input: number;
  cache_read: number;
  cache_creation: number;
  cache_creation_1h: number;
  cache_creation_5m: number;
  context_tokens: number;
  output_tokens: number;
  out_logged: number;
  out_src: OutSrc;
  thinking_tokens: number | null;
  /** Advisor iterations, each priced at its own model. */
  advisor: (AdvisorTokens & { cost_usd: number })[];
  advisor_input: number;
  advisor_output: number;
  cost_usd: number;
  cost_output_usd: number;
  cost_advisor_usd: number;
  unpriced: boolean;
  after_compaction: boolean;
  text_chars: number;
  visible_chars: number;
  n_tool_uses: number;
  service_tier: string | null;
  effort: string | null;
  version: string | null;
}

export interface ToolCallRow {
  tool_use_id: string;
  message_id: string;
  session_id: string;
  agent_id: string | null;
  file: string;
  turn_id: string | null;
  call_index: number;
  name: string;
  /** Python-JSON length of the input (the prototype's in_chars). */
  input_chars: number;
  command: string | null;
  description: string | null;
  file_path: string | null;
  /** TaskStop/TaskOutput/BashOutput: the task they name. */
  task_ref: string | null;
  cli: CommandCli | null;
  subcommand: string | null;
  n_invocations: number;
  intent: Intent | null;
  intents: Intent[];
  passthrough: boolean;
  meta_only: boolean;
  glue: Glue | null;
  run_in_background: boolean;
  /** The call ran detached: a background placeholder result, a background task id, or Monitor. */
  background: boolean;
  background_task_id: string | null;
  call_ts: string | null;
  result_ts: string | null;
  has_result: boolean;
  is_error: boolean;
  exit_code: number | null;
  effective_exit: number | null;
  error_kind: ErrorKind | null;
  ghx_error_code: string | null;
  ghx_error_codes: string[];
  ghx_outcome: GhxOutcome | null;
  refusal: Refusal | null;
  /** Whose failure it is (classify/errors.ts Failure): mistake, outcome or denial; null when it did not fail. */
  failure: Failure | null;
  /** The ghx error code, `exit:N`, an error kind, or `gh:…`/`glue:…` for a text match; null when it did not fail. */
  failure_reason: string | null;
  /** A gh/ghx invocation passed --dry-run. */
  dry_run: boolean;
  tool_denial_kind: string | null;
  result_chars: number;
  result_bytes: number;
  persisted: boolean;
  /** The PreToolUse hook's permissionDecision (allow, ask, deny), when one was recorded. */
  hook_decision: string | null;
  notif_ts: string | null;
  notif_status: string | null;
  notif_exit: number | null;
  notif_count: number;
  notif_events: number;
  output_file_read_bytes: number;
  /** Index (in this file) of the API call after the result. */
  next_call_index: number | null;
  /** Agent or Skill (forked) results name the agent they started. */
  spawned_agent_id: string | null;
  /**
   * Index (in this file) of the API call after each of this call's notifications, ascending and unique: the
   * call a notification woke or fed. From the first copy of each notification in this file.
   */
  notif_wake_call_indexes: number[];
  /** `owner/repo#n` for each github.com pull URL in the result, in order of appearance (M2: PR of a create). */
  result_pr_refs: string[];
  /** Head SHAs in the result: `headRefOid`/`headSha`/`headOid` JSON values, or bare hex when the command asked for one. */
  result_head_shas: string[];
  /** Paths the result says output went to: `saved to`/`written to` text and ghx `logPath` values. */
  result_paths: string[];
}

export interface Counts {
  files_by_kind: Record<string, number>;
  records_by_type: Record<string, number>;
  unknown_types: Record<string, number>;
  invalid_records: Record<string, number>;
  /** `<synthetic>` assistant records (API errors), excluded. */
  synthetic_records: number;
  /** Assistant records folded into an earlier record of the same message.id (rule 1). */
  duplicate_assistant_records: number;
  /** API calls dropped because another file owns their message.id (rule 2). */
  fork_copied_calls: number;
  fork_copied_turns: number;
  notification_sightings: number;
  notifications: number;
  unlinked_agents: number;
  parent_mismatches: number;
  dev_sessions: number;
}

export interface Tables {
  sessions: SessionRow[];
  agents: AgentRow[];
  turns: TurnRow[];
  api_calls: ApiCallRow[];
  tool_calls: ToolCallRow[];
  counts: Counts;
}

export interface InputFile {
  path: string;
  /** Decoded JSONL records in file order; a .json file is one record. */
  records: readonly unknown[];
}

export interface BuildOptions {
  era?: EraConfig;
}

// ---------------------------------------------------------------------------------------------- helpers

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const byPath = (a: { path: string }, b: { path: string }): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function pushTo<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

function bump(m: Record<string, number>, k: string, by = 1): void {
  m[k] = (m[k] ?? 0) + by;
}

function sortedRecord(m: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(m).sort()) out[k] = m[k] as number;
  return out;
}

export function emptyCounts(): Counts {
  return {
    files_by_kind: {},
    records_by_type: {},
    unknown_types: {},
    invalid_records: {},
    synthetic_records: 0,
    duplicate_assistant_records: 0,
    fork_copied_calls: 0,
    fork_copied_turns: 0,
    notification_sightings: 0,
    notifications: 0,
    unlinked_agents: 0,
    parent_mismatches: 0,
    dev_sessions: 0,
  };
}

/** Sum two Counts; record-valued fields come back with sorted keys. */
export function mergeCounts(a: Counts, b: Counts): Counts {
  const rec = (x: Record<string, number>, y: Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = { ...x };
    for (const [k, v] of Object.entries(y)) bump(out, k, v);
    return sortedRecord(out);
  };
  return {
    files_by_kind: rec(a.files_by_kind, b.files_by_kind),
    records_by_type: rec(a.records_by_type, b.records_by_type),
    unknown_types: rec(a.unknown_types, b.unknown_types),
    invalid_records: rec(a.invalid_records, b.invalid_records),
    synthetic_records: a.synthetic_records + b.synthetic_records,
    duplicate_assistant_records: a.duplicate_assistant_records + b.duplicate_assistant_records,
    fork_copied_calls: a.fork_copied_calls + b.fork_copied_calls,
    fork_copied_turns: a.fork_copied_turns + b.fork_copied_turns,
    notification_sightings: a.notification_sightings + b.notification_sightings,
    notifications: a.notifications + b.notifications,
    unlinked_agents: a.unlinked_agents + b.unlinked_agents,
    parent_mismatches: a.parent_mismatches + b.parent_mismatches,
    dev_sessions: a.dev_sessions + b.dev_sessions,
  };
}

function userText(u: UserRecord): string {
  return textOf(u.message.content ?? '');
}

function hasToolResult(u: UserRecord): boolean {
  const c = u.message.content;
  return Array.isArray(c) && c.some((b) => b.type === 'tool_result');
}

const NOT_A_PROMPT = /^\s*(?:<command-name>|<local-command-|\[Request interrupted)/;
const HUMAN_SOURCES = new Set(['typed', 'suggestion_accepted', 'queued']);

/**
 * Findings §1.4: a prompt a person typed. Main file, a user record that is not meta, not a compact summary,
 * not all tool results, from origin human or a typed/accepted/queued prompt source, and not a slash
 * command, local command output or interruption marker.
 */
export function isHumanPrompt(u: UserRecord, main: boolean): boolean {
  if (!main || u.isMeta === true || u.isCompactSummary === true) return false;
  const c = u.message.content;
  if (Array.isArray(c) && c.length > 0 && c.every((b) => b.type === 'tool_result')) return false;
  if (u.origin?.kind !== 'human' && !HUMAN_SOURCES.has(u.promptSource ?? '')) return false;
  return !NOT_A_PROMPT.test(userText(u));
}

const ORIGIN_KIND: Readonly<Record<string, StarterKind>> = {
  human: 'human',
  task_notification: 'task_notification',
  'task-notification': 'task_notification',
  peer: 'peer',
  sdk: 'sdk',
  auto_continuation: 'auto_continuation',
  'auto-continuation': 'auto_continuation',
  scheduled: 'scheduled',
  coordinator: 'coordinator',
};

/** What started a turn: turnOrigin, then origin.kind, then promptSource, then the text. */
export function starterKind(u: UserRecord, firstInFile: boolean, main: boolean): StarterKind {
  const k = ORIGIN_KIND[u.turnOrigin ?? ''] ?? ORIGIN_KIND[u.origin?.kind ?? ''] ?? ORIGIN_KIND[u.promptSource ?? ''];
  if (k) return k;
  if (main && HUMAN_SOURCES.has(u.promptSource ?? '')) return 'human';
  const t = userText(u).trimStart();
  if (t.startsWith('<command-name>') || t.startsWith('<local-command-')) return 'command';
  if (t.startsWith('[Request interrupted')) return 'interrupt';
  if (!main && firstInFile) return 'spawn';
  if (u.isMeta === true) return 'meta';
  return 'other';
}

function hookDecision(stdout: string | null | undefined): string | null {
  if (!stdout?.includes('permissionDecision')) return null;
  try {
    const j = JSON.parse(stdout) as unknown;
    const d = isObject(j) && isObject(j.hookSpecificOutput) ? j.hookSpecificOutput.permissionDecision : undefined;
    return typeof d === 'string' ? d : null;
  } catch {
    return /"permissionDecision"\s*:\s*"(\w+)"/.exec(stdout)?.[1] ?? null;
  }
}

// ---------------------------------------------------------------------------------------------- per file

interface ToolResultInfo {
  index: number;
  ts: string | null;
  text: string;
  isError: boolean;
  toolUseResult: unknown;
  denialKind: string | null;
}

interface RawTurn {
  starter: UserRecord;
  starterIndex: number;
  firstInFile: boolean;
  startTs: string | null;
  endTs: string | null;
  interrupted: boolean;
  hasAssistant: boolean;
}

interface FileModel {
  path: string;
  info: FileInfo;
  main: boolean;
  agentId: string | null;
  parsed: ParsedRecord[];
  groups: AssistantGroup[];
  /** Turn index per record index (-1 before the first turn). */
  turnOf: Int32Array;
  turns: RawTurn[];
  results: Map<string, ToolResultInfo>;
  hooks: Map<string, string>;
  compactAfter: Set<number>;
  nCompactions: number;
  sightings: Omit<NotificationSighting, 'order'>[];
}

function modelFile(path: string, info: FileInfo, records: readonly unknown[], counts: Counts): FileModel {
  const main = info.kind === 'main';
  const parsed = records.map(parseRecord);
  const assistants: { index: number; record: AssistantRecord }[] = [];
  const results = new Map<string, ToolResultInfo>();
  const hooks = new Map<string, string>();
  const turnOf = new Int32Array(parsed.length).fill(-1);
  const turns: RawTurn[] = [];
  const sightings: Omit<NotificationSighting, 'order'>[] = [];
  const compactions: number[] = [];
  let promptId: string | null = null;
  let cur: RawTurn | null = null;

  const sight = (text: string, ts: string | null, source: NotificationSighting['source'], index: number): void => {
    const n = parseNotification(text);
    if (n) sightings.push({ notification: n, ts, file: path, source, index });
  };

  for (const [i, p] of parsed.entries()) {
    bump(
      counts.records_by_type,
      p.type === 'unknown' || p.type === 'invalid' || p.type === 'ignored' ? p.rawType : p.type,
    );
    if (p.type === 'unknown') bump(counts.unknown_types, p.rawType);
    if (p.type === 'invalid') bump(counts.invalid_records, p.rawType);
    let ts: string | null = null;
    if (p.type === 'user') {
      const u = p.record;
      ts = u.timestamp ?? null;
      const toolResult = hasToolResult(u);
      const startsTurn = main
        ? typeof u.promptId === 'string' && u.promptId !== promptId
        : !toolResult && (cur === null || cur.hasAssistant);
      if (startsTurn) {
        if (main) promptId = u.promptId ?? null;
        cur = {
          starter: u,
          starterIndex: i,
          firstInFile: turns.length === 0,
          startTs: null,
          endTs: null,
          interrupted: false,
          hasAssistant: false,
        };
        turns.push(cur);
      }
      if (/^\s*\[Request interrupted/.test(userText(u)) && cur) cur.interrupted = true;
      const c = u.message.content;
      if (typeof c === 'string') sight(c, ts, 'user', i);
      else if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'tool_result' && b.tool_use_id) {
            results.set(b.tool_use_id, {
              index: i,
              ts,
              text: resultText(b.content),
              isError: b.is_error === true,
              toolUseResult: u.toolUseResult,
              denialKind: u.toolDenialKind ?? null,
            });
          } else if (b.type === 'text' && typeof b.text === 'string') sight(b.text, ts, 'user', i);
        }
      }
    } else if (p.type === 'assistant') {
      ts = p.record.timestamp ?? null;
      assistants.push({ index: i, record: p.record });
      if (cur) cur.hasAssistant = true;
    } else if (p.type === 'attachment') {
      ts = p.record.timestamp ?? null;
      const a = p.record.attachment;
      if (a.type === 'queued_command') {
        sight(typeof a.prompt === 'string' ? a.prompt : textOf(a.prompt), ts, 'attachment', i);
      }
      if (a.hookEvent === 'PreToolUse' && a.toolUseID) {
        const d = hookDecision(a.stdout);
        if (d) hooks.set(a.toolUseID, d);
      }
    } else if (p.type === 'queue-operation') {
      ts = p.record.timestamp ?? null;
      const c = p.record.content;
      sight(typeof c === 'string' ? c : textOf(c), ts, 'queue', i);
    } else if (p.type === 'system') {
      ts = p.record.timestamp ?? null;
      if (p.record.subtype === 'compact_boundary') compactions.push(i);
    }
    if (cur) {
      turnOf[i] = turns.length - 1;
      if (ts) {
        cur.startTs ??= ts;
        cur.endTs = ts;
      }
    }
  }

  const { calls: groups, synthetic } = groupAssistantRecords(assistants);
  counts.synthetic_records += synthetic;
  for (const g of groups) counts.duplicate_assistant_records += g.nRecords - 1;
  const compactAfter = new Set<number>();
  const firsts = groups.map((g) => g.first);
  for (const c of compactions) {
    const k = nextCallAfter(firsts, c);
    if (k !== null) compactAfter.add(k);
  }
  return {
    path,
    info,
    main,
    agentId: info.agentId,
    parsed,
    groups,
    turnOf,
    turns,
    results,
    hooks,
    compactAfter,
    nCompactions: compactions.length,
    sightings,
  };
}

function toolUses(g: AssistantGroup): Block[] {
  return g.blocks.filter((b) => b.type === 'tool_use' && typeof b.id === 'string');
}

function textChars(g: AssistantGroup): number {
  let n = 0;
  for (const b of g.blocks) if (b.type === 'text' && typeof b.text === 'string') n += codePointLength(b.text);
  return n;
}

// ---------------------------------------------------------------------------------------------- build

/** Session key `<project>/<sessionId>` for a corpus path, or null for files outside a session. */
export function sessionKeyOf(path: string): string | null {
  const info = fileKind(path);
  return info.sessionId ? `${info.project}/${info.sessionId}` : null;
}

/** Group paths by session, sessions and paths sorted. Lets a caller build one session at a time. */
export function groupBySession(paths: readonly string[]): { session: string; paths: string[] }[] {
  const by = new Map<string, string[]>();
  for (const p of [...paths].sort()) {
    const k = sessionKeyOf(p);
    if (k === null) continue;
    pushTo(by, k, p);
  }
  return [...by.keys()].sort().map((session) => ({ session, paths: by.get(session) as string[] }));
}

/** Build every table for a set of files, session by session. */
export function buildTables(files: readonly InputFile[], opts: BuildOptions = {}): Tables {
  const bySession = new Map<string, InputFile[]>();
  const out: Tables = { sessions: [], agents: [], turns: [], api_calls: [], tool_calls: [], counts: emptyCounts() };
  for (const f of [...files].sort(byPath)) {
    const k = sessionKeyOf(f.path);
    if (k === null) {
      bump(out.counts.files_by_kind, 'other');
      continue;
    }
    pushTo(bySession, k, f);
  }
  for (const k of [...bySession.keys()].sort()) {
    const t = buildSessionTables(bySession.get(k) as InputFile[], opts);
    out.sessions.push(...t.sessions);
    out.agents.push(...t.agents);
    out.turns.push(...t.turns);
    out.api_calls.push(...t.api_calls);
    out.tool_calls.push(...t.tool_calls);
    out.counts = mergeCounts(out.counts, t.counts);
  }
  out.counts = mergeCounts(out.counts, emptyCounts());
  return out;
}

/** Build the tables for the files of one session (main thread, subagents, meta and skill-fork files). */
export function buildSessionTables(input: readonly InputFile[], opts: BuildOptions = {}): Tables {
  const cfg = opts.era ?? DEFAULT_ERA_CONFIG;
  const counts = emptyCounts();
  const files = [...input].sort(byPath);
  const metas = new Map<string, AgentMeta>();
  const skillMarked = new Set<string>();
  const models: FileModel[] = [];
  let project = '';
  let sessionId = '';
  for (const f of files) {
    const info = fileKind(f.path);
    bump(counts.files_by_kind, info.kind);
    project ||= info.project;
    sessionId ||= info.sessionId;
    if (info.kind === 'agent_meta' && info.agentId) {
      const m = AgentMetaSchema.safeParse(f.records[0]);
      if (m.success) metas.set(info.agentId, m.data);
      else bump(counts.invalid_records, 'agent-meta');
    } else if ((info.kind === 'skill_fork' || info.kind === 'skill_fork_marker') && info.agentId) {
      skillMarked.add(info.agentId);
    } else if (info.kind === 'main' || info.kind === 'subagent') {
      models.push(modelFile(f.path, info, f.records, counts));
    }
  }

  // Skill forks are linked only through the Skill tool result (toolUseResult.status 'forked').
  const skillResults = new Map<string, { file: FileModel; toolUseId: string }[]>();
  for (const fm of models) {
    for (const [toolUseId, r] of fm.results) {
      const tur = r.toolUseResult;
      if (isObject(tur) && tur.status === 'forked' && typeof tur.agentId === 'string') {
        pushTo(skillResults, tur.agentId, { file: fm, toolUseId });
      }
    }
  }
  const isSkillFork = (agentId: string): boolean => skillMarked.has(agentId) || skillResults.has(agentId);
  const isFork = (fm: FileModel): boolean =>
    fm.agentId !== null && (metas.get(fm.agentId)?.isFork === true || isSkillFork(fm.agentId));
  const depthOf = (fm: FileModel): number => (fm.agentId === null ? 0 : (metas.get(fm.agentId)?.spawnDepth ?? 1));

  // Rule 2: one owner per message.id across the session's files.
  const owner = ownersByMessageId(
    models.map((fm) => ({
      file: fm.path,
      fork: isFork(fm),
      depth: depthOf(fm),
      messageIds: fm.groups.map((g) => g.messageId),
    })),
  );
  const owned = (fm: FileModel, g: AssistantGroup): boolean => owner.get(g.messageId) === fm.path;
  const toolUseOwner = new Map<string, { file: FileModel; block: Block }>();
  for (const fm of models) {
    for (const g of fm.groups) {
      if (!owned(fm, g)) {
        counts.fork_copied_calls++;
        continue;
      }
      for (const b of toolUses(g))
        if (!toolUseOwner.has(b.id as string)) toolUseOwner.set(b.id as string, { file: fm, block: b });
    }
  }

  // Agents: meta.toolUseId → the file holding that tool_use (the file wins over parentAgentId); skill forks
  // through the Skill result.
  const agentIds = new Set<string>([...metas.keys()]);
  for (const fm of models) if (fm.agentId) agentIds.add(fm.agentId);
  const agents: AgentRow[] = [];
  const callsByAgent = new Map<string | null, number>();
  for (const fm of models) {
    let n = 0;
    for (const g of fm.groups) if (owned(fm, g)) n++;
    callsByAgent.set(fm.agentId, (callsByAgent.get(fm.agentId) ?? 0) + n);
  }
  for (const agentId of [...agentIds].sort()) {
    const meta = metas.get(agentId);
    const fm = models.find((m) => m.agentId === agentId);
    let parent: string | null = null;
    let spawn: string | null = null;
    let spawnTool: string | null = null;
    let via: AgentRow['linked_via'] = null;
    const tid = meta?.toolUseId;
    const loc = tid ? toolUseOwner.get(tid) : undefined;
    if (tid && loc) {
      parent = loc.file.agentId;
      spawn = tid;
      spawnTool = loc.block.name ?? null;
      via = 'tool_use_id';
    } else {
      const candidates = skillResults.get(agentId) ?? [];
      const hit = candidates.find((c) => toolUseOwner.get(c.toolUseId)?.file === c.file) ?? candidates[0];
      if (hit) {
        parent = hit.file.agentId;
        spawn = hit.toolUseId;
        spawnTool = toolUseOwner.get(hit.toolUseId)?.block.name ?? 'Skill';
        via = 'skill_result';
      }
    }
    if (via === null) counts.unlinked_agents++;
    const mismatch = via === 'tool_use_id' && (meta?.parentAgentId ?? null) !== parent;
    if (mismatch) counts.parent_mismatches++;
    agents.push({
      agent_id: agentId,
      session_id: sessionId,
      file: fm?.path ?? null,
      parent_agent_id: parent,
      spawn_tool_use_id: spawn,
      spawn_tool: spawnTool,
      linked_via: via,
      parent_mismatch: mismatch,
      agent_type: meta?.agentType ?? null,
      description: meta?.description ?? null,
      request_shape: meta?.requestShape ?? null,
      spawn_depth: meta?.spawnDepth ?? null,
      model: meta?.model ?? null,
      is_fork: meta?.isFork === true,
      skill_fork: isSkillFork(agentId),
      has_meta: meta !== undefined,
      n_api_calls: callsByAgent.get(agentId) ?? 0,
    });
  }

  // Rule 3: notifications across the session, earliest copy of each.
  const allSightings: NotificationSighting[] = [];
  for (const fm of models) for (const s of fm.sightings) allSightings.push({ ...s, order: allSightings.length });
  const notifs = dedupeNotifications(allSightings);
  counts.notification_sightings += allSightings.length;
  counts.notifications += notifs.length;
  const notifByToolUse = new Map<string, NotificationSighting[]>();
  const notifByTask = new Map<string, NotificationSighting[]>();
  for (const s of notifs) {
    if (s.notification.toolUseId) pushTo(notifByToolUse, s.notification.toolUseId, s);
    else pushTo(notifByTask, s.notification.taskId, s);
  }

  const turns: TurnRow[] = [];
  const apiCalls: ApiCallRow[] = [];
  const toolCalls: ToolCallRow[] = [];
  const agentKey = (fm: FileModel): string => fm.agentId ?? 'main';
  for (const fm of models) {
    // Turns: drop a turn whose calls are all copies owned by another file (a fork's copied history).
    const ownedPerTurn = new Array<number>(fm.turns.length).fill(0);
    const callsPerTurn = new Array<number>(fm.turns.length).fill(0);
    for (const g of fm.groups) {
      const t = fm.turnOf[g.first] as number;
      if (t < 0) continue;
      callsPerTurn[t] = (callsPerTurn[t] as number) + 1;
      if (owned(fm, g)) ownedPerTurn[t] = (ownedPerTurn[t] as number) + 1;
    }
    const turnIds: (string | null)[] = [];
    let k = 0;
    for (const [ti, t] of fm.turns.entries()) {
      if ((callsPerTurn[ti] as number) > 0 && ownedPerTurn[ti] === 0) {
        counts.fork_copied_turns++;
        turnIds.push(null);
        continue;
      }
      const id = `${sessionId}:${agentKey(fm)}:${k++}`;
      turnIds.push(id);
      turns.push({
        turn_id: id,
        session_id: sessionId,
        agent_id: fm.agentId,
        file: fm.path,
        prompt_id: fm.main ? (t.starter.promptId ?? null) : null,
        starter_kind: starterKind(t.starter, t.firstInFile, fm.main),
        is_human: isHumanPrompt(t.starter, fm.main),
        start_ts: t.startTs,
        end_ts: t.endTs,
        interrupted: t.interrupted,
        n_api_calls: ownedPerTurn[ti] as number,
      });
    }
    const turnIdAt = (recordIndex: number): string | null => {
      const t = fm.turnOf[recordIndex] as number;
      return t < 0 ? null : (turnIds[t] ?? null);
    };

    // Output recovery runs over the file's own call sequence (copies included), as the prototype does.
    const firsts = fm.groups.map((g) => g.first);
    const recovery: RecoveryCall[] = fm.groups.map((g) => {
      let visible = textChars(g);
      const tus = toolUses(g).map((b) => {
        visible += pyJsonDumps(b.input ?? {}).length;
        const r = fm.results.get(b.id as string);
        return {
          resultChars: r ? codePointLength(r.text) : null,
          nextCall: r ? nextCallAfter(firsts, r.index) : null,
        };
      });
      return { model: g.model, stopReason: g.stopReason, usage: g.usage, visibleChars: visible, toolUses: tus };
    });
    const outputs = recoverOutputs(recovery);

    // Later reads of a background task's output file, by task id.
    const fileToolCalls: ToolCallRow[] = [];
    for (const [ci, g] of fm.groups.entries()) {
      if (!owned(fm, g)) continue;
      const usage = g.usage ?? {};
      const out = outputs[ci] as (typeof outputs)[number];
      const cost = callCost(g.model, usage, out.outputTokens);
      const inp = executorInput(usage);
      const advIts = (usage.iterations ?? []).filter((it) => it.type === 'advisor_message');
      const adv = advisorIterations(usage).map((a, j) => ({ ...a, cost_usd: advisorCost(advIts[j] ?? {}) ?? 0 }));
      const tus = toolUses(g);
      apiCalls.push({
        message_id: g.messageId,
        session_id: sessionId,
        agent_id: fm.agentId,
        file: fm.path,
        turn_id: turnIdAt(g.first),
        call_index: ci,
        model: g.model,
        ts: g.firstTs,
        last_ts: g.lastTs,
        n_records: g.nRecords,
        stop_reason: g.stopReason,
        input: inp.input,
        cache_read: inp.cacheRead,
        cache_creation: inp.cacheWrite1h + inp.cacheWrite5m,
        cache_creation_1h: inp.cacheWrite1h,
        cache_creation_5m: inp.cacheWrite5m,
        context_tokens: contextTokens(usage),
        output_tokens: out.outputTokens,
        out_logged: out.outLogged,
        out_src: out.outSrc,
        thinking_tokens: usage.output_tokens_details?.thinking_tokens ?? null,
        advisor: adv,
        advisor_input: adv.reduce((s, a) => s + a.input + a.cacheRead + a.cacheCreation, 0),
        advisor_output: adv.reduce((s, a) => s + a.output, 0),
        cost_usd: cost.total,
        cost_output_usd: cost.output,
        cost_advisor_usd: cost.advisor,
        unpriced: cost.unpriced,
        after_compaction: fm.compactAfter.has(ci),
        text_chars: textChars(g),
        visible_chars: (recovery[ci] as RecoveryCall).visibleChars,
        n_tool_uses: tus.length,
        service_tier: usage.service_tier ?? null,
        effort: g.head.effort ?? null,
        version: g.head.version ?? null,
      });
      for (const b of tus) {
        const id = b.id as string;
        if (toolUseOwner.get(id)?.file !== fm) continue;
        fileToolCalls.push(
          toolCallRow(fm, g, ci, b, turnIdAt(g.first), sessionId, firsts, notifByToolUse, notifByTask),
        );
      }
    }
    // output_file_read_bytes: later calls in the same file that name `<task>.output` or the task id.
    for (const [i, t] of fileToolCalls.entries()) {
      const task = t.background_task_id;
      if (!task) continue;
      let bytes = 0;
      for (const later of fileToolCalls.slice(i + 1)) {
        const ref = `${later.file_path ?? ''} ${later.command ?? ''}`;
        if (ref.includes(`${task}.output`) || later.task_ref === task) bytes += later.result_bytes;
      }
      t.output_file_read_bytes = bytes;
    }
    toolCalls.push(...fileToolCalls);
  }

  // Session row.
  const mainFile = models.find((m) => m.main);
  const allTs: string[] = [];
  for (const fm of models) {
    for (const p of fm.parsed) {
      const ts =
        'record' in p && isObject(p.record) && typeof p.record.timestamp === 'string' ? p.record.timestamp : null;
      if (ts) allTs.push(ts);
    }
  }
  allTs.sort((a, b) => Date.parse(a) - Date.parse(b) || (a < b ? -1 : a > b ? 1 : 0));
  const first = allTs[0] ?? null;
  const last = allTs.at(-1) ?? null;
  const mainRecords = mainFile ? mainFile.parsed.flatMap((p) => ('record' in p ? [p] : [])) : [];
  const meta = { cwd: null as string | null, version: null as string | null, entrypoint: null as string | null };
  const versions: string[] = [];
  for (const p of mainRecords) {
    const r = p.record as Record<string, unknown>;
    if (typeof r.cwd === 'string') meta.cwd ??= r.cwd;
    if (typeof r.entrypoint === 'string') meta.entrypoint ??= r.entrypoint;
    if (typeof r.version === 'string') {
      meta.version ??= r.version;
      if (!versions.includes(r.version)) versions.push(r.version);
    }
  }
  const prLinks: PrLink[] = [];
  const seenPr = new Set<string>();
  for (const p of mainRecords) {
    if (p.type !== 'pr-link') continue;
    const r = p.record;
    const key = r.prUrl ?? `${r.prRepository ?? ''}#${r.prNumber ?? ''}`;
    if (seenPr.has(key)) continue;
    seenPr.add(key);
    prLinks.push({ number: r.prNumber ?? null, repo: r.prRepository ?? null, url: r.prUrl ?? null });
  }
  const mainParsed = mainFile?.parsed ?? [];
  const title = lastOfType(mainParsed, 'ai-title')?.record.aiTitle ?? null;
  const agentName = lastOfType(mainParsed, 'agent-name')?.record.agentName ?? null;
  const era = eraAt(project, first, cfg);
  if (era === 'dogfood-dev') counts.dev_sessions++;
  const sessionTurns = turns;
  const session: SessionRow = {
    session_id: sessionId,
    project,
    cwd: meta.cwd,
    version: meta.version,
    versions,
    entrypoint: meta.entrypoint,
    first_ts: first,
    last_ts: last,
    title,
    agent_name: agentName,
    n_compactions: models.filter((fm) => !isFork(fm)).reduce((s, fm) => s + fm.nCompactions, 0),
    pr_links: prLinks,
    era,
    is_dev: era === 'dogfood-dev',
    has_main_file: mainFile !== undefined,
    n_files: files.length,
    n_agents: agents.length,
    n_turns: sessionTurns.length,
    n_human_turns: sessionTurns.filter((t) => t.is_human).length,
    n_api_calls: apiCalls.length,
    n_tool_calls: toolCalls.length,
    cost_usd: apiCalls.reduce((s, c) => s + c.cost_usd, 0),
    cost_state: summarizeCostState(mainParsed, first),
  };
  return {
    sessions: [session],
    agents,
    turns,
    api_calls: apiCalls,
    tool_calls: toolCalls,
    counts: mergeCounts(counts, emptyCounts()),
  };
}

const notifKey = (s: Omit<NotificationSighting, 'order'>): string =>
  `${s.notification.taskId}\u0000${s.notification.body.trimEnd()}`;

/** The API call after the first copy, in this file, of each notification. */
function wakeCallIndexes(fm: FileModel, own: readonly NotificationSighting[], firsts: readonly number[]): number[] {
  if (own.length === 0) return [];
  const keys = new Set(own.map(notifKey));
  const seen = new Set<string>();
  const out = new Set<number>();
  for (const s of fm.sightings) {
    const k = notifKey(s);
    if (!keys.has(k) || seen.has(k) || s.index === undefined) continue;
    seen.add(k);
    const next = nextCallAfter(firsts, s.index);
    if (next !== null) out.add(next);
  }
  return [...out].sort((a, b) => a - b);
}

const uniq = (xs: Iterable<string>): string[] => [...new Set(xs)];

export function prRefsIn(text: string): string[] {
  return uniq(
    [...text.matchAll(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g)].map((m) => `${m[1]}/${m[2]}#${m[3]}`),
  );
}

const SHA_FIELD = /"(?:headSha|headRefOid|headOid)"\s*:\s*"([0-9a-f]{7,40})"/g;
const SHA_ASKED = /\b(?:headSha|headRefOid|headOid)\b/;
const BARE_SHA = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{40}\b/g;

/** Head SHAs: JSON field values, else (when the command asked for a head SHA field) bare 40-hex tokens. */
export function headShasIn(text: string, command: string | null): string[] {
  const fields = [...text.matchAll(SHA_FIELD)].map((m) => m[1] as string);
  if (fields.length > 0 || command === null || !SHA_ASKED.test(command)) return uniq(fields);
  return uniq([...text.matchAll(BARE_SHA)].map((m) => m[0]));
}

/** `saved to /path`, `written to: /path` and ghx `"logPath": "/path"`. */
export function pathsIn(text: string): string[] {
  const said = [...text.matchAll(/(?:saved to|written to):?\s*(\/[^\s"]+)/g)].map((m) => m[1] as string);
  const logs = [...text.matchAll(/"logPath"\s*:\s*"(\/[^"]+)"/g)].map((m) => m[1] as string);
  return uniq([...said.slice(0, 3), ...logs]);
}

function toolCallRow(
  fm: FileModel,
  g: AssistantGroup,
  callIndex: number,
  b: Block,
  turnId: string | null,
  sessionId: string,
  firsts: readonly number[],
  notifByToolUse: ReadonlyMap<string, NotificationSighting[]>,
  notifByTask: ReadonlyMap<string, NotificationSighting[]>,
): ToolCallRow {
  const id = b.id as string;
  const name = b.name ?? '';
  const input = isObject(b.input) ? b.input : {};
  const shell = name === 'Bash' || name === 'Monitor';
  const command = shell && typeof input.command === 'string' ? input.command : null;
  const r = fm.results.get(id);
  const text = r?.text ?? '';
  const cls = command !== null ? classifyCommand(command) : null;
  const runInBackground = input.run_in_background === true || input.run_in_background === 'true';
  let task: string | null = null;
  if (name === 'Bash') task = backgroundTaskIdOf(r?.toolUseResult) ?? backgroundTaskIdFromText(text) ?? null;
  else if (name === 'Monitor') task = monitorTaskIdOf(r?.toolUseResult) ?? null;
  else if (isObject(r?.toolUseResult) && typeof r.toolUseResult.agentId === 'string' && name === 'Agent') {
    task = r.toolUseResult.agentId;
  }
  const background = name === 'Monitor' || (name === 'Bash' && task !== null);
  const own = [...(notifByToolUse.get(id) ?? []), ...(task ? (notifByTask.get(task) ?? []) : [])].sort(
    (x, y) => x.order - y.order,
  );
  const terminal = own.find((s) => s.notification.terminal);
  const notifExit = terminal ? (terminal.notification.exitCode ?? terminal.notification.scriptExit) : null;
  const intent = cls ? commandIntent(cls, command ?? '', { background, monitor: name === 'Monitor' }) : null;
  const res = classifyResult({
    toolName: name,
    isError: r?.isError === true,
    text,
    toolDenialKind: r?.denialKind ?? null,
    cli: cls?.cli ?? null,
    background,
    notifExit,
    subcommands: cls?.invocations.map((i) => `${i.cli} ${i.subcommand}`.trimEnd()) ?? [],
  });
  const tur = r?.toolUseResult;
  const spawned =
    isObject(tur) && typeof tur.agentId === 'string' && (name === 'Agent' || name === 'Task' || tur.status === 'forked')
      ? tur.agentId
      : null;
  return {
    tool_use_id: id,
    message_id: g.messageId,
    session_id: sessionId,
    agent_id: fm.agentId,
    file: fm.path,
    turn_id: turnId,
    call_index: callIndex,
    name,
    input_chars: pyJsonDumps(b.input ?? {}).length,
    command,
    description: typeof input.description === 'string' ? input.description : null,
    file_path: typeof input.file_path === 'string' ? input.file_path : null,
    task_ref: [input.task_id, input.shell_id, input.bash_id].find((x): x is string => typeof x === 'string') ?? null,
    cli: cls?.cli ?? null,
    subcommand: cls?.subcommand ?? null,
    n_invocations: cls?.invocations.length ?? 0,
    intent: intent?.intent ?? null,
    intents: intent?.intents ?? [],
    passthrough: intent?.passthrough ?? false,
    meta_only: intent?.metaOnly ?? false,
    glue: cls?.glue ?? null,
    run_in_background: runInBackground,
    background,
    background_task_id: task,
    call_ts: g.firstTs,
    result_ts: r?.ts ?? null,
    has_result: r !== undefined,
    is_error: r?.isError === true,
    exit_code: res.exitCode,
    effective_exit: res.effectiveExit,
    error_kind: res.errorKind,
    ghx_error_code: res.ghxErrorCode,
    ghx_error_codes: res.ghxErrorCodes,
    ghx_outcome: res.ghxOutcome,
    refusal: res.refusal,
    failure: res.failure,
    failure_reason: res.failureReason,
    dry_run: cls?.invocations.some((i) => i.args.includes('--dry-run')) ?? false,
    tool_denial_kind: r?.denialKind ?? null,
    result_chars: codePointLength(text),
    result_bytes: Buffer.byteLength(text, 'utf8'),
    persisted: isPersisted(text),
    hook_decision: fm.hooks.get(id) ?? null,
    notif_ts: terminal?.ts ?? null,
    notif_status: terminal?.notification.status ?? null,
    notif_exit: notifExit,
    notif_count: own.length,
    notif_events: own.filter((s) => s.notification.event).length,
    output_file_read_bytes: 0,
    next_call_index: r ? nextCallAfter(firsts, r.index) : null,
    spawned_agent_id: spawned,
    notif_wake_call_indexes: wakeCallIndexes(fm, own, firsts),
    result_pr_refs: prRefsIn(text),
    result_head_shas: headShasIn(text, command),
    result_paths: pathsIn(text),
  };
}

/** Grace between the session's first record and a cost-state process start before it counts as a resume. */
export const RESUME_GRACE_MS = 5 * 60 * 1000;

/** Rule 4 (last record wins) and rule 9 (per process, resets on resume) for a main file's `cost-state`. */
export function summarizeCostState(
  mainRecords: readonly ParsedRecord[],
  firstTs: string | null,
): CostStateSummary | null {
  const records: CostStateRecord[] = [];
  let trailing = 0;
  for (const p of mainRecords) {
    if (p.type === 'cost-state') {
      records.push(p.record);
      trailing = 0;
    } else if (p.type === 'assistant') trailing++;
  }
  const last = records.at(-1);
  if (!last) return null;
  const starts = new Set(records.map((r) => r.startTime ?? null));
  let decreasing = false;
  for (let i = 1; i < records.length; i++) {
    if ((records[i]?.totalCostUSD ?? 0) < (records[i - 1]?.totalCostUSD ?? 0)) decreasing = true;
  }
  const start = last.startTime ?? null;
  const lateStart = start !== null && firstTs !== null && start - Date.parse(firstTs) > RESUME_GRACE_MS;
  const modelUsage: CostStateSummary['model_usage'] = {};
  for (const k of Object.keys(last.modelUsage ?? {}).sort()) {
    const m = last.modelUsage?.[k];
    if (!m) continue;
    modelUsage[k] = {
      cost_usd: m.costUSD ?? 0,
      input: m.inputTokens ?? 0,
      output: m.outputTokens ?? 0,
      cache_read: m.cacheReadInputTokens ?? 0,
      cache_creation: m.cacheCreationInputTokens ?? 0,
    };
  }
  return {
    total_usd: last.totalCostUSD ?? 0,
    start_time: start,
    n_records: records.length,
    n_starts: starts.size,
    trailing_assistant_records: trailing,
    resumed: starts.size > 1 || decreasing || lateStart || trailing > 0,
    model_usage: modelUsage,
  };
}

export interface CostCheckRow {
  model: string;
  cost_state_usd: number;
  computed_usd: number;
  /** (computed − cost-state) / cost-state. */
  delta: number;
}

/**
 * Rule 9: compare computed cost with `cost-state`, per model, only for an unresumed session. Advisor cost
 * goes to the advisor's model. Models the transcript never shows (haiku title/classifier calls) are left out.
 */
export function costStateCheck(
  session: SessionRow,
  calls: readonly ApiCallRow[],
): { usable: false; reason: string } | { usable: true; rows: CostCheckRow[] } {
  const cs = session.cost_state;
  if (!cs) return { usable: false, reason: 'no cost-state record' };
  if (cs.resumed) return { usable: false, reason: 'resumed: cost-state covers only the last process' };
  const computed = new Map<string, number>();
  const add = (m: string | null, v: number): void => {
    if (m) computed.set(m, (computed.get(m) ?? 0) + v);
  };
  for (const c of calls) {
    if (c.session_id !== session.session_id) continue;
    add(c.model, c.cost_usd - c.cost_advisor_usd);
    for (const a of c.advisor) add(a.model, a.cost_usd);
  }
  const rows: CostCheckRow[] = [];
  for (const model of Object.keys(cs.model_usage).sort()) {
    const got = computed.get(model);
    if (got === undefined) continue;
    const want = (cs.model_usage[model] as { cost_usd: number }).cost_usd;
    rows.push({ model, cost_state_usd: want, computed_usd: got, delta: want === 0 ? 0 : (got - want) / want });
  }
  return { usable: true, rows };
}
