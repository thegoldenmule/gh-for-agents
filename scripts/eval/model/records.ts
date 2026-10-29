// Claude Code transcript records (findings §1). Every schema is loose: unknown fields pass through, so a
// new Claude Code version adds columns rather than breaking the parse. A record whose type we don't model
// is counted as unknown, and one that fails its schema is counted as invalid; neither is fatal.
import { z } from 'zod';

const num = z.number().nullish();
const str = z.string().nullish();

export const CacheCreationSchema = z.looseObject({
  ephemeral_1h_input_tokens: num,
  ephemeral_5m_input_tokens: num,
});

/** One `usage.iterations[]` entry: `message` (the executor) or `advisor_message` (priced at its own model). */
export const IterationSchema = z.looseObject({
  type: str,
  model: str,
  input_tokens: num,
  output_tokens: num,
  cache_read_input_tokens: num,
  cache_creation_input_tokens: num,
  cache_creation: CacheCreationSchema.nullish(),
});

export const UsageSchema = z.looseObject({
  input_tokens: num,
  output_tokens: num,
  cache_read_input_tokens: num,
  cache_creation_input_tokens: num,
  cache_creation: CacheCreationSchema.nullish(),
  iterations: z.array(IterationSchema).nullish(),
  output_tokens_details: z.looseObject({ thinking_tokens: num }).nullish(),
  service_tier: str,
});

/** A content block. `type` decides which of the optional fields are set. */
export const BlockSchema = z.looseObject({
  type: z.string(),
  id: str,
  name: str,
  input: z.unknown().optional(),
  tool_use_id: str,
  content: z.unknown().optional(),
  is_error: z.boolean().nullish(),
  text: str,
});

const base = {
  uuid: str,
  parentUuid: str,
  timestamp: str,
  sessionId: str,
  agentId: str,
  isSidechain: z.boolean().nullish(),
  cwd: str,
  version: str,
  entrypoint: str,
  gitBranch: str,
};

export const AssistantRecordSchema = z.looseObject({
  ...base,
  type: z.literal('assistant'),
  requestId: str,
  effort: str,
  advisorModel: str,
  isApiErrorMessage: z.boolean().nullish(),
  message: z.looseObject({
    id: str,
    model: str,
    stop_reason: str,
    content: z.array(BlockSchema).nullish(),
    usage: UsageSchema.nullish(),
  }),
});

export const UserRecordSchema = z.looseObject({
  ...base,
  type: z.literal('user'),
  promptId: str,
  origin: z.looseObject({ kind: str }).nullish(),
  promptSource: str,
  turnOrigin: str,
  isMeta: z.boolean().nullish(),
  isCompactSummary: z.boolean().nullish(),
  toolUseResult: z.unknown().optional(),
  toolDenialKind: str,
  interruptedMessageId: str,
  message: z.looseObject({ content: z.union([z.string(), z.array(BlockSchema)]).nullish() }),
});

export const SystemRecordSchema = z.looseObject({
  ...base,
  type: z.literal('system'),
  subtype: str,
  durationMs: num,
  compactMetadata: z.looseObject({ trigger: str, preTokens: num, postTokens: num }).nullish(),
});

export const AttachmentRecordSchema = z.looseObject({
  ...base,
  type: z.literal('attachment'),
  attachment: z.looseObject({
    type: str,
    prompt: z.unknown().optional(),
    hookEvent: str,
    hookName: str,
    toolUseID: str,
    stdout: str,
  }),
});

export const QueueOperationRecordSchema = z.looseObject({
  type: z.literal('queue-operation'),
  operation: str,
  timestamp: str,
  content: z.unknown().optional(),
});

export const ModelUsageSchema = z.looseObject({
  inputTokens: num,
  outputTokens: num,
  cacheReadInputTokens: num,
  cacheCreationInputTokens: num,
  costUSD: num,
});

/** Cumulative per process; it resets on resume (rule 9). */
export const CostStateRecordSchema = z.looseObject({
  type: z.literal('cost-state'),
  sessionId: str,
  totalCostUSD: num,
  startTime: num,
  modelUsage: z.record(z.string(), ModelUsageSchema).nullish(),
});

export const AiTitleRecordSchema = z.looseObject({ type: z.literal('ai-title'), aiTitle: str });
export const PrLinkRecordSchema = z.looseObject({
  type: z.literal('pr-link'),
  prNumber: num,
  prRepository: str,
  prUrl: str,
  timestamp: str,
});
export const AgentNameRecordSchema = z.looseObject({ type: z.literal('agent-name'), agentName: str });
export const ForkContextRefRecordSchema = z.looseObject({
  type: z.literal('fork-context-ref'),
  agentId: str,
  parentSessionId: str,
});

/** `agent-<id>.meta.json` beside a subagent transcript. */
export const AgentMetaSchema = z.looseObject({
  agentType: str,
  description: str,
  toolUseId: str,
  parentAgentId: str,
  spawnDepth: num,
  requestShape: str,
  model: str,
  isFork: z.boolean().nullish(),
  name: str,
});

export type Block = z.infer<typeof BlockSchema>;
export type Usage = z.infer<typeof UsageSchema>;
export type Iteration = z.infer<typeof IterationSchema>;
export type AssistantRecord = z.infer<typeof AssistantRecordSchema>;
export type UserRecord = z.infer<typeof UserRecordSchema>;
export type SystemRecord = z.infer<typeof SystemRecordSchema>;
export type AttachmentRecord = z.infer<typeof AttachmentRecordSchema>;
export type QueueOperationRecord = z.infer<typeof QueueOperationRecordSchema>;
export type CostStateRecord = z.infer<typeof CostStateRecordSchema>;
export type AiTitleRecord = z.infer<typeof AiTitleRecordSchema>;
export type PrLinkRecord = z.infer<typeof PrLinkRecordSchema>;
export type AgentMeta = z.infer<typeof AgentMetaSchema>;

const SCHEMAS = {
  assistant: AssistantRecordSchema,
  user: UserRecordSchema,
  system: SystemRecordSchema,
  attachment: AttachmentRecordSchema,
  'queue-operation': QueueOperationRecordSchema,
  'cost-state': CostStateRecordSchema,
  'ai-title': AiTitleRecordSchema,
  'pr-link': PrLinkRecordSchema,
  'agent-name': AgentNameRecordSchema,
  'fork-context-ref': ForkContextRefRecordSchema,
} as const;

/** Types seen in the 2026-10-29 corpus that carry nothing the tables use. Counted as known, not unknown. */
export const IGNORED_TYPES: ReadonlySet<string> = new Set([
  'mode',
  'permission-mode',
  'last-prompt',
  'atis-latch',
  'file-history-snapshot',
  'file-history-delta',
  'frame-link',
  'artifact-comment-monitor',
  'artifact-autoreact-ledger',
  'continued-in',
  'custom-title',
  'summary',
]);

type Modeled = keyof typeof SCHEMAS;
export type ParsedRecord =
  | { [K in Modeled]: { type: K; record: z.infer<(typeof SCHEMAS)[K]> } }[Modeled]
  | { type: 'ignored'; rawType: string }
  | { type: 'unknown'; rawType: string }
  | { type: 'invalid'; rawType: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Classify and validate one decoded JSONL value. Never throws. */
export function parseRecord(raw: unknown): ParsedRecord {
  const rawType = isObject(raw) && typeof raw.type === 'string' ? raw.type : '';
  if (Object.hasOwn(SCHEMAS, rawType)) {
    const parsed = SCHEMAS[rawType as Modeled].safeParse(raw);
    if (!parsed.success) return { type: 'invalid', rawType };
    return { type: rawType, record: parsed.data } as ParsedRecord;
  }
  if (IGNORED_TYPES.has(rawType)) return { type: 'ignored', rawType };
  return { type: 'unknown', rawType: rawType || '(none)' };
}

/**
 * Rule 10: decode JSONL up to the last newline only. A live file's final line may be half-written, so
 * whatever follows the last `\n` is left for the next read. `bytes` is the UTF-8 length consumed.
 * (scripts/eval/corpus/read.ts streams files the same way; this is the in-memory form for fixtures.)
 */
export function parseJsonlText(text: string): { records: unknown[]; badLines: number; bytes: number } {
  const end = text.lastIndexOf('\n');
  const complete = end === -1 ? '' : text.slice(0, end + 1);
  const records: unknown[] = [];
  let badLines = 0;
  for (const line of complete.split('\n')) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      badLines++;
    }
  }
  return { records, badLines, bytes: Buffer.byteLength(complete, 'utf8') };
}

export type FileKind =
  | 'main'
  | 'subagent'
  | 'agent_meta'
  | 'skill_fork'
  | 'skill_fork_marker'
  | 'tool_result_file'
  | 'other';

export interface FileInfo {
  kind: FileKind;
  /** The cwd slug directory under ~/.claude/projects. */
  project: string;
  sessionId: string;
  /** For subagent files: the id after `agent-`, as records' `agentId` spells it. */
  agentId: string | null;
}

const AGENT_FILE = /^agent-(.+?)(\.forked-skill\.marker\.json|\.forked-skill\.json|\.meta\.json|\.jsonl)$/;
const AGENT_KIND: Record<string, FileKind> = {
  '.forked-skill.marker.json': 'skill_fork_marker',
  '.forked-skill.json': 'skill_fork',
  '.meta.json': 'agent_meta',
  '.jsonl': 'subagent',
};

/**
 * What a corpus file is, from the layout in findings §1.1 (paths absolute or relative to the projects root):
 * `<slug>/<session>.jsonl` main thread; `<slug>/<session>/subagents/agent-<id>.{jsonl,meta.json,
 * forked-skill.json,forked-skill.marker.json}`; `<slug>/<session>/tool-results/*`.
 */
export function fileKind(path: string): FileInfo {
  const parts = path.split(/[\\/]+/).filter((p) => p !== '');
  const name = parts.at(-1) ?? '';
  const parent = parts.at(-2) ?? '';
  if (parent === 'subagents') {
    const m = AGENT_FILE.exec(name);
    return {
      kind: m ? (AGENT_KIND[m[2] as string] ?? 'other') : 'other',
      project: parts.at(-4) ?? '',
      sessionId: parts.at(-3) ?? '',
      agentId: m ? (m[1] as string) : null,
    };
  }
  if (parent === 'tool-results') {
    return { kind: 'tool_result_file', project: parts.at(-4) ?? '', sessionId: parts.at(-3) ?? '', agentId: null };
  }
  if (name.endsWith('.jsonl')) {
    return { kind: 'main', project: parent, sessionId: name.slice(0, -'.jsonl'.length), agentId: null };
  }
  return { kind: 'other', project: parent, sessionId: '', agentId: null };
}
