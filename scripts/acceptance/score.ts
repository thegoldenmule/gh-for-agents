#!/usr/bin/env node
// Agent acceptance scorer (03 §8.2, M12.4). v1 acceptance scores the session JSONL of real PRs worked
// on with ghx installed: node scripts/acceptance/score.ts <session.jsonl>… (exit 0 pass, 1 fail, 2 usage).
// Per 03 §3.6 tool_use.input is the pre-hook command, so "in the background" comes from the tool_result
// and toolUseResult.backgroundTaskId. Notifications are counted from queue-operation enqueues: each is
// enqueued once, then delivered as a user turn or absorbed mid-turn as an attachment.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { type Invocation, isCiWait, isGh, isGhx, scanShell } from '../../src/hook/shell.ts';

export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
  line: number;
}

interface ToolResult {
  text: string;
  isError: boolean;
  backgroundTaskId?: string;
  line: number;
}

interface Notification {
  taskId: string;
  status: string;
  exitCode: number | null;
  line: number;
}

export interface WaitReport {
  toolUseId: string;
  command: string;
  /** Tool calls for this wait: 1, or more when an identical re-run resumed after exit 15. */
  calls: number;
  background: boolean;
  taskId: string | null;
  notifications: number;
  violations: string[];
  pass: boolean;
}

interface Metric<T> {
  value: T;
  threshold: string;
  pass: boolean | null;
  examples?: string[];
}

export interface SessionReport {
  path: string;
  pass: boolean;
  waits: WaitReport[];
  metrics: {
    ciWaits: Metric<number>;
    githubCallsToDiagnose: Metric<number | null>;
    githubCallsEndToEnd: Metric<number>;
    rawGh: Metric<number>;
    wrappedGhx: Metric<number>;
    harnessRefusals: Metric<number>;
  };
  unparsedLines: number;
}

export interface Report {
  pass: boolean;
  sessions: SessionReport[];
  notScored: string[];
}

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (isObject(c) && typeof c.text === 'string' ? c.text : '')).join('\n');
  }
  return '';
}

function parseNotification(text: string, line: number): Notification | undefined {
  if (!text.includes('<task-notification>')) return undefined;
  const taskId = /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1];
  if (!taskId) return undefined;
  const status = /<status>([^<]+)<\/status>/.exec(text)?.[1] ?? 'unknown';
  const code = /exit code (\d+)/.exec(/<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1] ?? '')?.[1];
  return { taskId, status, exitCode: code !== undefined ? Number(code) : status === 'completed' ? 0 : null, line };
}

interface Parsed {
  uses: ToolUse[];
  results: Map<string, ToolResult>;
  notifications: Notification[];
  unparsed: number;
}

export function parseSession(jsonl: string): Parsed {
  const uses: ToolUse[] = [];
  const seen = new Set<string>();
  const results = new Map<string, ToolResult>();
  const enqueued: Notification[] = [];
  const delivered: Notification[] = [];
  let sawQueue = false;
  let unparsed = 0;
  const lines = jsonl.split('\n');
  for (const [line, raw] of lines.entries()) {
    if (raw.trim() === '') continue;
    let rec: unknown;
    try {
      rec = JSON.parse(raw);
    } catch {
      unparsed++;
      continue;
    }
    if (!isObject(rec)) continue;
    if (rec.type === 'queue-operation') {
      sawQueue = true;
      if (rec.operation === 'enqueue') {
        const n = parseNotification(textOf(rec.content), line);
        if (n) enqueued.push(n);
      }
      continue;
    }
    if (rec.subtype === 'task_notification' && typeof rec.task_id === 'string') {
      const code = typeof rec.exit_code === 'number' ? rec.exit_code : null;
      delivered.push({ taskId: rec.task_id, status: String(rec.status ?? 'unknown'), exitCode: code, line });
      continue;
    }
    if (isObject(rec.attachment) && rec.attachment.type === 'queued_command') {
      const n = parseNotification(textOf(rec.attachment.prompt), line);
      if (n) delivered.push(n);
      continue;
    }
    const content = isObject(rec.message) ? rec.message.content : undefined;
    if (rec.type === 'user' && typeof content === 'string') {
      const n = parseNotification(content, line);
      if (n) delivered.push(n);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block.type === 'tool_use' && typeof block.id === 'string' && !seen.has(block.id)) {
        seen.add(block.id);
        uses.push({ id: block.id, name: String(block.name), input: isObject(block.input) ? block.input : {}, line });
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const bg = isObject(rec.toolUseResult) ? rec.toolUseResult.backgroundTaskId : undefined;
        results.set(block.tool_use_id, {
          text: textOf(block.content),
          isError: block.is_error === true,
          ...(typeof bg === 'string' ? { backgroundTaskId: bg } : {}),
          line,
        });
      } else if (block.type === 'text' && rec.type === 'user') {
        const n = parseNotification(String(block.text ?? ''), line);
        if (n) delivered.push(n);
      }
    }
  }
  return { uses, results, notifications: sawQueue ? enqueued : delivered, unparsed };
}

const commandOf = (u: ToolUse): string => (typeof u.input.command === 'string' ? u.input.command : '');
const isShell = (u: ToolUse): boolean => u.name === 'Bash' || u.name === 'Monitor';
const clip = (s: string): string => (s.length > 200 ? `${s.slice(0, 197)}...` : s);

/** ghx calls that only describe ghx (no GitHub traffic). */
function isDiscovery(inv: Invocation): boolean {
  const a = inv.argv.slice(1);
  return (
    a.length === 0 ||
    ['help', 'schema', 'version', 'hook'].includes(a[0] as string) ||
    a.some((t) => t === '--help' || t === '-h' || t === '--schema' || t === '--version')
  );
}

const touchesGitHub = (inv: Invocation): boolean => isGh(inv) || (isGhx(inv) && !isDiscovery(inv));
const isGitRemote = (inv: Invocation): boolean =>
  inv.argv[0] === 'git' && ['push', 'pull', 'fetch'].includes(inv.argv[1] as string);

const REFUSAL = [
  /Permission to use \S+ (with command [\s\S]*)?has been denied/i,
  /\bPreToolUse:\S+ hook\b/i,
  /\b(blocked|denied) by (a |the )?(PreToolUse )?hook/i,
  /\bhook (returned|denied|blocked)/i,
  /The user doesn't want to proceed with this tool use/i,
  /\brefused by [\w -]*guard/i,
];

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

function inputFiles(uses: readonly ToolUse[]): Set<string> {
  const out = new Set<string>();
  for (const u of uses.filter(isShell)) {
    for (const inv of scanShell(commandOf(u)).invocations.filter(isGhx)) {
      const i = inv.argv.indexOf('--input');
      const v = i === -1 ? undefined : inv.argv[i + 1];
      if (v && v !== '-') out.add(basename(v));
    }
  }
  return out;
}

/** The first Edit/Write of a source file: not Claude's task or scratch files, and not a ghx --input file. */
function firstSourceEdit(uses: readonly ToolUse[]): number | undefined {
  const inputs = inputFiles(uses);
  for (const [i, u] of uses.entries()) {
    if (!EDIT_TOOLS.has(u.name)) continue;
    const p = String(u.input.file_path ?? u.input.notebook_path ?? '');
    if (p === '' || /\/tmp\/claude-\d+\/|\/scratchpad\/|\/\.claude\//.test(p) || inputs.has(basename(p))) continue;
    return i;
  }
  return undefined;
}

function scoreWaits(p: Parsed): WaitReport[] {
  const waits: (WaitReport & { argv: string; lastExit: number | null })[] = [];
  const { uses, results, notifications } = p;
  for (const [i, u] of uses.entries()) {
    if (!isShell(u)) continue;
    const command = commandOf(u);
    const inv = scanShell(command).invocations.find(isCiWait);
    if (!inv) continue;
    const argv = inv.argv.join(' ');
    const result = results.get(u.id);
    const background = u.name === 'Bash' && (result?.text.includes('Command running in background') ?? false);
    const taskId = result?.backgroundTaskId ?? /running in background with ID: (\w+)/.exec(result?.text ?? '')?.[1];
    const mine = taskId ? notifications.filter((n) => n.taskId === taskId) : [];
    // A foreground call blocks, so only a background wait has a window to watch.
    const end = background ? (mine[0]?.line ?? Number.POSITIVE_INFINITY) : u.line;
    const violations: string[] = [];
    if (u.name === 'Monitor') violations.push('ran under Monitor');
    if (!background) violations.push('not in the background (no "Command running in background" result)');
    if (mine.length !== 1) violations.push(`${mine.length} task notifications (want exactly 1)`);
    for (const v of uses.slice(i + 1)) {
      if (v.line > end) break;
      if (v.name === 'Monitor') violations.push(`Monitor call during the wait: ${clip(commandOf(v))}`);
      const path = String(v.input.file_path ?? '');
      if (v.name === 'Read' && taskId && path.endsWith(`${taskId}.output`)) {
        violations.push(`Read of the task output file ${path}`);
      }
      if ((v.name === 'BashOutput' || v.name === 'TaskOutput') && taskId && JSON.stringify(v.input).includes(taskId)) {
        violations.push(`${v.name} on the waiting task`);
      }
      if (isShell(v)) {
        const scan = scanShell(commandOf(v));
        if (scan.sleep) violations.push(`sleep during the wait: ${clip(commandOf(v))}`);
        if (scan.invocations.some((x) => isCiWait(x) && x.argv.join(' ') === argv)) {
          violations.push('a second identical ghx ci wait before the notification');
        }
      }
    }
    const report = {
      toolUseId: u.id,
      command: clip(command),
      calls: 1,
      background,
      taskId: taskId ?? null,
      notifications: mine.length,
      violations,
      pass: violations.length === 0,
      argv,
      lastExit: mine.at(-1)?.exitCode ?? null,
    };
    // 03 §8.2: an identical re-run after `pending` (exit 15) is part of the same wait.
    const prev = waits.at(-1);
    if (prev && prev.argv === argv && prev.lastExit === 15) {
      prev.calls++;
      prev.violations.push(...violations);
      prev.notifications += mine.length;
      prev.pass = prev.pass && report.pass;
      prev.lastExit = report.lastExit;
      continue;
    }
    waits.push(report);
  }
  return waits.map(({ argv: _a, lastExit: _l, ...w }) => w);
}

export function scoreSession(path: string, jsonl: string): SessionReport {
  const p = parseSession(jsonl);
  const shell = p.uses.filter(isShell).map((u) => ({ u, scan: scanShell(commandOf(u)) }));
  const waits = scoreWaits(p);

  const gh = shell.filter(({ scan }) => scan.invocations.some(isGh));
  const wrapped = shell.filter(({ scan }) => {
    const ghx = scan.invocations.filter(isGhx);
    if (ghx.length === 0) return false;
    const jq = ghx.some((inv) => inv.argv.some((t) => t === '--jq' || t === '-q' || t.startsWith('--jq=')));
    return scan.pipe || scan.sleep || scan.timeout || scan.perlAlarm || jq;
  });
  const refusals = p.uses.filter((u) => {
    const r = p.results.get(u.id);
    return r?.isError === true && REFUSAL.some((re) => re.test(r.text));
  });

  const githubIdx = p.uses
    .map((u, i) => ({ u, i }))
    .filter(({ u }) => isShell(u) && scanShell(commandOf(u)).invocations.some(touchesGitHub))
    .map(({ i }) => i);
  const editAt = firstSourceEdit(p.uses);
  const diagnose = editAt === undefined ? null : githubIdx.filter((i) => i < editAt).length;
  const endToEnd = shell.filter(({ scan }) => scan.invocations.some((x) => touchesGitHub(x) || isGitRemote(x))).length;

  const examples = (xs: { u: ToolUse }[]): string[] => xs.slice(0, 5).map(({ u }) => clip(commandOf(u)));
  const metrics: SessionReport['metrics'] = {
    ciWaits: {
      value: waits.length,
      threshold: 'every wait: 1 background ghx ci wait call, 1 notification, no Monitor/Read/sleep',
      pass: waits.every((w) => w.pass),
    },
    githubCallsToDiagnose: {
      value: diagnose,
      threshold: '<= 1 from the first GitHub call to the first source edit',
      pass: diagnose === null ? null : diagnose <= 1,
    },
    githubCallsEndToEnd: { value: endToEnd, threshold: '<= 5', pass: endToEnd <= 5 },
    rawGh: { value: gh.length, threshold: '0', pass: gh.length === 0, examples: examples(gh) },
    wrappedGhx: {
      value: wrapped.length,
      threshold: '0 ghx calls with |, sleep, timeout, --jq or perl alarm',
      pass: wrapped.length === 0,
      examples: examples(wrapped),
    },
    harnessRefusals: {
      value: refusals.length,
      threshold: '0',
      pass: refusals.length === 0,
      examples: refusals.slice(0, 5).map((u) => clip(commandOf(u) || u.name)),
    },
  };
  const pass = Object.values(metrics).every((m) => m.pass !== false);
  return { path, pass, waits, metrics, unparsedLines: p.unparsed };
}

export const NOT_SCORED = [
  'GitHub outcome: merged with a merge commit, merged_at set, merge pinned to the evaluated head',
  'one call for the full PR state before merging (pr status, or the ci wait --until mergeable summary)',
];

export function score(files: readonly { path: string; content: string }[]): Report {
  const sessions = files.map((f) => scoreSession(f.path, f.content));
  return { pass: sessions.length > 0 && sessions.every((s) => s.pass), sessions, notScored: NOT_SCORED };
}

function main(): void {
  const paths = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  if (paths.length === 0) {
    process.stdout.write(`${JSON.stringify({ error: 'usage: node scripts/acceptance/score.ts <session.jsonl>…' })}\n`);
    process.exitCode = 2;
    return;
  }
  let files: { path: string; content: string }[];
  try {
    files = paths.map((path) => ({ path, content: readFileSync(path, 'utf8') }));
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ error: (e as Error).message })}\n`);
    process.exitCode = 2;
    return;
  }
  const report = score(files);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.pass ? 0 : 1;
}

if (import.meta.main) main();
