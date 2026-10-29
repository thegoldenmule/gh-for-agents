// Scenario builders for the M2 unit tests: a transcript is a list of API calls (each with its tool calls and
// results), human prompts, task notifications and compactions, in the record shapes of
// test/fixtures/eval/model/shapes.ts. All ids, paths and text are synthetic.
import type { InputFile } from '../../../../scripts/eval/model/session.ts';
import * as S from '../model/shapes.ts';

export { S };

export const TASKS = `/private/tmp/claude-501/${S.PROJECT}/${S.SESSION}/tasks`;

export interface ToolSpec {
  id: string;
  /** Bash unless given. */
  name?: string;
  command?: string;
  input?: Record<string, unknown>;
  result: string;
  isError?: boolean;
  /** Run in the background as this task id (Bash) or a Monitor task. */
  bgTask?: string;
}

export interface CallSpec {
  msg: string;
  at: string;
  tools: ToolSpec[];
  usage?: S.UsageSpec;
  model?: string;
  /** Seconds after `at` the results arrive. */
  resultAfter?: number;
}

const shift = (iso: string, seconds: number): string => new Date(Date.parse(iso) + seconds * 1000).toISOString();

/** One API call with its tool uses, then one user record per result. */
export function call(c: CallSpec, agentId?: string): Record<string, unknown>[] {
  const ctx = agentId !== undefined ? { agentId } : {};
  const blocks = c.tools.map((t) => {
    const name = t.name ?? 'Bash';
    const input = t.input ?? {
      command: t.command ?? '',
      description: 'Run a command',
      ...(t.bgTask !== undefined && name === 'Bash' ? { run_in_background: true } : {}),
    };
    return S.toolUse(t.id, name, input);
  });
  const out = S.response({
    ...ctx,
    id: c.msg,
    ts: c.at,
    content: blocks,
    usage: S.usage(c.usage ?? { input: 2, cacheRead: 20_000, write1h: 500, output: 40 }),
    ...(c.model ? { model: c.model } : {}),
  });
  const rts = shift(c.at, c.resultAfter ?? 2);
  for (const t of c.tools) {
    const name = t.name ?? 'Bash';
    let tur: unknown = S.bashResult(t.result);
    let text = t.result;
    if (t.bgTask !== undefined && name === 'Bash') {
      text = `Command running in background with ID: ${t.bgTask}. Output is being written to: ${TASKS}/${t.bgTask}.output`;
      tur = { ...S.bashResult(''), backgroundTaskId: t.bgTask };
    } else if (t.bgTask !== undefined && name === 'Monitor') {
      tur = { taskId: t.bgTask };
    }
    out.push(S.toolResult(t.id, text, { ...ctx, ts: rts, isError: t.isError ?? false, toolUseResult: tur }));
  }
  return out;
}

/** A Bash call running `command` with result `result`. */
export const bash = (msg: string, at: string, id: string, command: string, result = 'ok', agentId?: string) =>
  call({ msg, at, tools: [{ id, command, result }] }, agentId);

export interface NotifySpec {
  taskId: string;
  toolUseId: string;
  status: string;
  summary: string;
  at: string;
  /** All three copies (queue-operation, queued_command attachment, user record), as real transcripts have. */
  triple?: boolean;
  promptId?: string;
}

/** A task notification. In a main thread the user record starts a turn (pass promptId). */
export function notify(n: NotifySpec, agentId?: string): Record<string, unknown>[] {
  const text = S.notificationText({ taskId: n.taskId, toolUseId: n.toolUseId, status: n.status, summary: n.summary });
  const ctx = agentId !== undefined ? { agentId } : {};
  const user = S.prompt(text, {
    ...ctx,
    ts: shift(n.at, 1),
    origin: 'task-notification',
    ...(n.promptId ? { promptId: n.promptId } : {}),
  });
  if (!n.triple) return [user];
  return [S.queueOperation('enqueue', text, n.at), S.queuedCommand(text, { ...ctx, ts: shift(n.at, 1) }), user];
}

export const human = (text: string, promptId: string, at: string) => [S.humanPrompt(text, promptId, { ts: at })];

export const main = (records: Record<string, unknown>[][]): InputFile => ({
  path: S.mainPath(),
  records: records.flat(),
});

export const sub = (agentId: string, records: Record<string, unknown>[][]): InputFile => ({
  path: S.agentPath(agentId),
  records: records.flat(),
});

/** A ghx pr status result naming a head SHA. */
export const ghxStatus = (pr: number, sha: string): string =>
  JSON.stringify({ pr: { number: pr, headSha: sha, state: 'OPEN' }, ci: { state: 'pending' } });
