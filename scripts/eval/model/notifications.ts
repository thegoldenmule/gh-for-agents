// Task notifications and background Bash results (findings §1.5), shared by the acceptance scorer
// (scripts/acceptance/score.ts) and the eval tables (session.ts). These are the parsing primitives only:
// each caller keeps its own policy for which copy of a notification counts (score.ts: queue-operation
// enqueues; eval: dedupe.ts rule 3).

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The text blocks of a message content, joined with newlines; non-text blocks are dropped. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (isObject(c) && typeof c.text === 'string' ? c.text : '')).join('\n');
  }
  return '';
}

export interface ParsedNotification {
  taskId: string;
  /** The background tool_use that started the task, when the notification names it. */
  toolUseId: string | null;
  /** `<status>`, or 'unknown' (Monitor events carry none). */
  status: string;
  /** The first `exit code N` in `<summary>`; else 0 for `completed`; else null. */
  exitCode: number | null;
  /** Monitor's `script failed (exit N)` / `ended without producing output (exit N)`. */
  scriptExit: number | null;
  summary: string;
  outputFile: string | null;
  /** A Monitor `<event>`: one line of output, not the end of the task. */
  event: boolean;
  /** The task is over: a terminal status, a Monitor stream end or script failure, or expiry. */
  terminal: boolean;
  /** The notification from `<task-notification>` on, without any `[SYSTEM NOTIFICATION …]` preamble. */
  body: string;
}

const TERMINAL_STATUS = new Set(['completed', 'failed', 'killed', 'stopped']);
const TERMINAL_SUMMARY =
  /stream ended<\/summary>|script failed \(exit|ended without producing output|" stopped<\/summary>|\[Monitor expired/;

/** Parse one `<task-notification>` from a queue-operation, a queued_command attachment or a user record. */
export function parseNotification(text: string): ParsedNotification | undefined {
  const at = text.indexOf('<task-notification>');
  if (at === -1) return undefined;
  const taskId = /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1];
  if (!taskId) return undefined;
  const statusTag = /<status>([^<]+)<\/status>/.exec(text)?.[1];
  const status = statusTag ?? 'unknown';
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1] ?? '';
  const code = /exit code (\d+)/.exec(summary)?.[1];
  const script = /\(exit (\d+)\)/.exec(summary)?.[1];
  const body = text.slice(at);
  return {
    taskId,
    toolUseId: /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(text)?.[1] ?? null,
    status,
    exitCode: code !== undefined ? Number(code) : status === 'completed' ? 0 : null,
    scriptExit: script !== undefined ? Number(script) : null,
    summary,
    outputFile: /<output-file>([^<]+)<\/output-file>/.exec(text)?.[1] ?? null,
    event: body.includes('<event>'),
    terminal: (statusTag !== undefined && TERMINAL_STATUS.has(statusTag)) || TERMINAL_SUMMARY.test(body),
    body,
  };
}

/** The placeholder a background Bash call returns instead of its output. */
export const BACKGROUND_RESULT = 'Command running in background';

/** A background Bash call's `toolUseResult.backgroundTaskId`. */
export function backgroundTaskIdOf(toolUseResult: unknown): string | undefined {
  const id = isObject(toolUseResult) ? toolUseResult.backgroundTaskId : undefined;
  return typeof id === 'string' ? id : undefined;
}

/** A Monitor call's `toolUseResult.taskId`. */
export function monitorTaskIdOf(toolUseResult: unknown): string | undefined {
  const id = isObject(toolUseResult) ? toolUseResult.taskId : undefined;
  return typeof id === 'string' ? id : undefined;
}

/** The task id in a background placeholder: `Command running in background with ID: b1x2y3`. */
export function backgroundTaskIdFromText(text: string): string | undefined {
  return /running in background with ID: (\w+)/.exec(text)?.[1];
}
