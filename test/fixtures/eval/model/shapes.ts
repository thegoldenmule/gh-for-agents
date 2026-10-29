// Hand-built Claude Code 2.1.280 transcript records for the eval model tests. Every builder copies the
// field layout of a real record from the 2026-10-29 corpus; all ids, paths, slugs and text are synthetic.

export const PROJECT = '-Users-dev-projects-acme-widgets';
export const SESSION = '0a0a0a0a-1111-4222-8333-444444444444';
export const CWD = '/Users/dev/projects/acme/widgets';

let seq = 0;
/** Deterministic uuid-shaped ids; call resetIds() at the start of each fixture. */
export function uid(): string {
  seq++;
  return `00000000-0000-4000-8000-${seq.toString().padStart(12, '0')}`;
}
export function resetIds(): void {
  seq = 0;
}

export const ts = (minute: number, second = 0): string =>
  `2026-10-24T10:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`;

interface Ctx {
  agentId?: string;
  ts?: string;
}

const common = (c: Ctx) => ({
  parentUuid: null,
  isSidechain: c.agentId !== undefined,
  ...(c.agentId !== undefined ? { agentId: c.agentId } : {}),
  uuid: uid(),
  timestamp: c.ts ?? ts(0),
  userType: 'external',
  entrypoint: 'cli',
  cwd: CWD,
  sessionId: SESSION,
  version: '2.1.280',
  gitBranch: 'main',
});

export interface UsageSpec {
  input?: number;
  cacheRead?: number;
  write1h?: number;
  write5m?: number;
  output?: number;
  thinking?: number;
  iterations?: Record<string, unknown>[];
  /** Override the top-level cache_creation split (real multi-iteration records carry the first iteration's). */
  split?: { ephemeral_1h_input_tokens: number; ephemeral_5m_input_tokens: number };
}

export function usage(u: UsageSpec): Record<string, unknown> {
  const w1h = u.write1h ?? 0;
  const w5m = u.write5m ?? 0;
  return {
    input_tokens: u.input ?? 2,
    cache_creation_input_tokens: w1h + w5m,
    cache_read_input_tokens: u.cacheRead ?? 0,
    output_tokens: u.output ?? 0,
    output_tokens_details: { thinking_tokens: u.thinking ?? 0 },
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: 'standard',
    cache_creation: u.split ?? { ephemeral_1h_input_tokens: w1h, ephemeral_5m_input_tokens: w5m },
    inference_geo: 'global',
    ...(u.iterations ? { iterations: u.iterations } : {}),
    speed: 'standard',
  };
}

export function iteration(type: 'message' | 'advisor_message', u: UsageSpec, model?: string): Record<string, unknown> {
  const w1h = u.write1h ?? 0;
  const w5m = u.write5m ?? 0;
  return {
    input_tokens: u.input ?? 0,
    output_tokens: u.output ?? 0,
    cache_read_input_tokens: u.cacheRead ?? 0,
    cache_creation_input_tokens: w1h + w5m,
    cache_creation: { ephemeral_5m_input_tokens: w5m, ephemeral_1h_input_tokens: w1h },
    type,
    ...(model ? { model } : {}),
  };
}

export const thinking = (): Record<string, unknown> => ({ type: 'thinking', thinking: '', signature: 'c2lnbmF0dXJl' });
export const text = (t: string): Record<string, unknown> => ({ type: 'text', text: t });
export const toolUse = (id: string, name: string, input: Record<string, unknown>): Record<string, unknown> => ({
  type: 'tool_use',
  id,
  name,
  input,
  caller: { type: 'direct' },
});
export const bash = (id: string, command: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  toolUse(id, 'Bash', { command, description: 'Run a command', ...extra });

export interface AssistantSpec extends Ctx {
  id: string;
  content: Record<string, unknown>[];
  usage: Record<string, unknown>;
  stop?: string | null;
  model?: string;
}

/** One assistant record (one content block per record in real transcripts; pass one block). */
export function assistant(a: AssistantSpec): Record<string, unknown> {
  return {
    ...common(a),
    message: {
      model: a.model ?? 'claude-opus-5-5',
      id: a.id,
      type: 'message',
      role: 'assistant',
      content: a.content,
      container: null,
      stop_reason: a.stop === undefined ? 'tool_use' : a.stop,
      stop_sequence: null,
      stop_details: null,
      usage: a.usage,
      input_transformations: [],
      diagnostics: null,
      context_management: null,
    },
    requestId: `req_${a.id.slice(4)}`,
    type: 'assistant',
    apiBlockIndex: 0,
    effort: 'high',
    perTurnEffort: 'high',
  };
}

/** Real records split a response over records, one block each, with the usage repeated. */
export function response(a: AssistantSpec): Record<string, unknown>[] {
  return a.content.map((b) => assistant({ ...a, content: [b] }));
}

export function synthetic(c: Ctx = {}): Record<string, unknown> {
  return {
    ...common(c),
    type: 'assistant',
    message: {
      id: uid(),
      container: null,
      model: '<synthetic>',
      role: 'assistant',
      stop_details: null,
      stop_reason: 'stop_sequence',
      stop_sequence: '',
      type: 'message',
      usage: { ...usage({ input: 0 }), iterations: null, output_tokens_details: null, service_tier: null },
      content: [text('API Error: rate limited')],
      context_management: null,
    },
    error: 'rate_limit',
    isApiErrorMessage: true,
    apiErrorStatus: 429,
  };
}

export interface PromptSpec extends Ctx {
  promptId?: string;
  origin?: string | null;
  promptSource?: string | null;
  turnOrigin?: string | null;
  isMeta?: boolean;
}

export function prompt(content: string, p: PromptSpec = {}): Record<string, unknown> {
  return {
    ...common(p),
    ...(p.promptId !== undefined ? { promptId: p.promptId } : {}),
    type: 'user',
    message: { role: 'user', content },
    permissionMode: 'auto',
    ...(p.isMeta ? { isMeta: true } : {}),
    ...(p.origin ? { origin: { kind: p.origin } } : {}),
    ...(p.promptSource ? { promptSource: p.promptSource } : {}),
    ...(p.turnOrigin ? { turnOrigin: p.turnOrigin } : {}),
  };
}

export const humanPrompt = (content: string, promptId: string, c: Ctx = {}) =>
  prompt(content, { ...c, promptId, origin: 'human', promptSource: 'typed', turnOrigin: 'human' });

export interface ResultSpec extends Ctx {
  promptId?: string;
  isError?: boolean;
  toolUseResult?: unknown;
  toolDenialKind?: string;
}

export function toolResult(toolUseId: string, content: unknown, r: ResultSpec = {}): Record<string, unknown> {
  return {
    ...common(r),
    ...(r.promptId !== undefined ? { promptId: r.promptId } : {}),
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content, is_error: r.isError ?? false }] },
    ...(r.toolUseResult !== undefined ? { toolUseResult: r.toolUseResult } : {}),
    ...(r.toolDenialKind !== undefined ? { toolDenialKind: r.toolDenialKind } : {}),
    sourceToolAssistantUUID: uid(),
  };
}

export const bashResult = (stdout: string) => ({
  stdout,
  stderr: '',
  interrupted: false,
  isImage: false,
  noOutputExpected: false,
});

export interface NotificationSpec {
  taskId: string;
  toolUseId?: string;
  status: string;
  summary: string;
}

export function notificationText(n: NotificationSpec): string {
  return [
    '<task-notification>',
    `<task-id>${n.taskId}</task-id>`,
    ...(n.toolUseId ? [`<tool-use-id>${n.toolUseId}</tool-use-id>`] : []),
    `<output-file>/private/tmp/claude-501/${PROJECT}/${SESSION}/tasks/${n.taskId}.output</output-file>`,
    `<status>${n.status}</status>`,
    `<summary>${n.summary}</summary>`,
    '</task-notification>',
  ].join('\n');
}

export function queueOperation(operation: string, content: string | undefined, at: string): Record<string, unknown> {
  return {
    type: 'queue-operation',
    operation,
    timestamp: at,
    sessionId: SESSION,
    ...(content !== undefined ? { content } : {}),
  };
}

export function queuedCommand(promptText: string, c: Ctx = {}): Record<string, unknown> {
  return {
    ...common(c),
    attachment: {
      type: 'queued_command',
      prompt: promptText,
      source_uuid: uid(),
      commandMode: 'prompt',
      origin: { kind: 'task-notification' },
      timestamp: c.ts ?? ts(0),
      isMeta: true,
    },
    type: 'attachment',
  };
}

export function hookAttachment(toolUseId: string, decision: string, reason: string, c: Ctx = {}) {
  return {
    ...common(c),
    attachment: {
      type: 'hook_success',
      hookName: 'PreToolUse:Bash',
      toolUseID: toolUseId,
      hookEvent: 'PreToolUse',
      content: '',
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
      }),
      stderr: '',
      exitCode: 0,
      command: 'node /opt/ghx/bin/ghx.js hook claude-pretooluse',
      durationMs: 60,
    },
    type: 'attachment',
  };
}

export function compactBoundary(c: Ctx = {}): Record<string, unknown> {
  return {
    ...common(c),
    logicalParentUuid: uid(),
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    level: 'info',
    compactMetadata: { trigger: 'auto', preTokens: 180000, postTokens: 9000 },
  };
}

export interface CostStateSpec {
  startTime: number;
  total: number;
  modelUsage: Record<string, { costUSD: number }>;
}

export function costState(c: CostStateSpec): Record<string, unknown> {
  const modelUsage: Record<string, unknown> = {};
  for (const [m, u] of Object.entries(c.modelUsage)) {
    modelUsage[m] = {
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: u.costUSD,
    };
  }
  return {
    type: 'cost-state',
    sessionId: SESSION,
    totalCostUSD: c.total,
    totalAPIDuration: 1000,
    totalAPIDurationWithoutRetries: 1000,
    totalToolDuration: 1000,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    totalDuration: 5000,
    startTime: c.startTime,
    modelUsage,
    hasUnknownModelCost: false,
  };
}

export const aiTitle = (t: string) => ({ type: 'ai-title', aiTitle: t, sessionId: SESSION });
export const prLink = (n: number) => ({
  type: 'pr-link',
  sessionId: SESSION,
  prNumber: n,
  prUrl: `https://github.com/acme/widgets/pull/${n}`,
  prRepository: 'acme/widgets',
  timestamp: ts(30),
});

export function agentMeta(m: Record<string, unknown>): Record<string, unknown> {
  return { agentType: 'general-purpose', description: 'Do a task', spawnDepth: 1, requestShape: 'background', requestNonInteractive: true, ...m };
}

/** Paths in the ~/.claude/projects layout, relative to the projects root. */
export const mainPath = (session = SESSION, project = PROJECT) => `${project}/${session}.jsonl`;
export const agentPath = (agentId: string, ext = '.jsonl', session = SESSION, project = PROJECT) =>
  `${project}/${session}/subagents/agent-${agentId}${ext}`;
