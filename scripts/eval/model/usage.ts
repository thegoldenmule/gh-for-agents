// Per-call token accounting (findings §1.3 and §2): context size, advisor iterations, result size, and the
// recovery of subagent output tokens that the transcript only records as stream-start placeholders.
import type { Iteration, Usage } from './records.ts';

/** Characters per token for tool results, fitted on the corpus (gh, ghx and Bash results, Opus 5.x). */
export const CHARS_PER_TOKEN = 2.2;
/** Fitted per-result overhead in tokens (tool_result framing). */
export const RESULT_OVERHEAD = 70;
/** A recovered output is used only when it is at least this share of the visible-character estimate. */
export const RECOVERY_MIN_SHARE = 0.5;

const n = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function lastMessageIteration(u: Usage): Usage | Iteration {
  const its = (u.iterations ?? []).filter((i) => i.type === 'message');
  return its.at(-1) ?? u;
}

/** Context size: the last `message` iteration's input + cache_creation + cache_read (top level without iterations). */
export function contextTokens(u: Usage | null | undefined): number {
  if (!u) return 0;
  const x = lastMessageIteration(u);
  return n(x.input_tokens) + n(x.cache_creation_input_tokens) + n(x.cache_read_input_tokens);
}

export interface AdvisorTokens {
  model: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** `iterations[type=advisor_message]`: advisor calls exist only here, at their own model. */
export function advisorIterations(u: Usage | null | undefined): AdvisorTokens[] {
  return (u?.iterations ?? [])
    .filter((i) => i.type === 'advisor_message')
    .map((i) => ({
      model: i.model ?? null,
      input: n(i.input_tokens),
      output: n(i.output_tokens),
      cacheRead: n(i.cache_read_input_tokens),
      cacheCreation: n(i.cache_creation_input_tokens),
    }));
}

/** Estimated tokens a tool result adds to context: chars / 2.2 + 70. */
export function resultTokenEstimate(chars: number): number {
  return chars / CHARS_PER_TOKEN + RESULT_OVERHEAD;
}

/** Length in Unicode code points (Python's `len`), so character counts match the prototype. */
export function codePointLength(s: string): number {
  let surrogates = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        surrogates++;
        i++;
      }
    }
  }
  return s.length - surrogates;
}

/** Python's `json.dumps(v)` (ensure_ascii, `', '` and `': '` separators), for prototype-equal char counts. */
export function pyJsonDumps(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string')
    return JSON.stringify(v).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  if (typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(pyJsonDumps).join(', ')}]`;
  if (typeof v === 'object') {
    return `{${Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${pyJsonDumps(k)}: ${pyJsonDumps(x)}`)
      .join(', ')}}`;
  }
  return 'null';
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Rule 5: what the model saw of a tool result, from `tool_result.content` (never `toolUseResult.stdout`,
 * which holds up to 30 KB where a persisted output showed a 2 KB preview). Text blocks contribute their
 * text, other non-image blocks their JSON, images nothing.
 */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const b of content) {
    if (!isObject(b)) continue;
    if (b.type === 'text') out += typeof b.text === 'string' ? b.text : '';
    else if (b.type !== 'image') out += pyJsonDumps(b);
  }
  return out;
}

/** A persisted (large) output: the model saw a preview and a path under tool-results/. */
export function isPersisted(text: string): boolean {
  return text.includes('<persisted-output>');
}

/** Index of the first call whose first record comes after `recordIndex` (bisect right), or null. */
export function nextCallAfter(callFirstRecords: readonly number[], recordIndex: number): number | null {
  let lo = 0;
  let hi = callFirstRecords.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((callFirstRecords[mid] as number) <= recordIndex) lo = mid + 1;
    else hi = mid;
  }
  return lo < callFirstRecords.length ? lo : null;
}

export type OutSrc = 'final' | 'recovered' | 'visible_est';

export interface RecoveryCall {
  model: string | null;
  stopReason: string | null;
  usage: Usage | null;
  /** Code points of the call's text blocks plus Python-JSON length of each tool_use input. */
  visibleChars: number;
  /** Per tool_use: its result's chars (null without a result) and the index of the call after the result. */
  toolUses: readonly { resultChars: number | null; nextCall: number | null }[];
}

export interface RecoveredOutput {
  outputTokens: number;
  /** The output_tokens the transcript recorded. */
  outLogged: number;
  outSrc: OutSrc;
}

/**
 * Output tokens from the context delta to the next call: Δcontext − Σ result estimates. Null when the next
 * call is missing or on another model, a tool result lands after some other call, or context shrank.
 */
export function recoverOutput(calls: readonly RecoveryCall[], i: number): number | null {
  const c = calls[i];
  const nx = calls[i + 1];
  if (!c || !nx || nx.model !== c.model) return null;
  if (c.toolUses.some((t) => t.nextCall !== i + 1)) return null;
  const d = contextTokens(nx.usage) - contextTokens(c.usage);
  if (d < 0) return null;
  let results = 0;
  for (const t of c.toolUses) results += resultTokenEstimate(t.resultChars ?? 0);
  return d - results;
}

/**
 * Rule 3: a call with `stop_reason: null` recorded a stream-start usage snapshot (input final, output about
 * 2% of the truth). Replace its output with the recovered value when that is at least half the
 * visible-character estimate, else with the visible estimate; never below what was logged. Calls of one
 * transcript file, in file order.
 */
export function recoverOutputs(calls: readonly RecoveryCall[]): RecoveredOutput[] {
  return calls.map((c, i) => {
    const outLogged = n(c.usage?.output_tokens);
    if (c.stopReason !== null) return { outputTokens: outLogged, outLogged, outSrc: 'final' };
    const visible = c.visibleChars / CHARS_PER_TOKEN;
    const r = recoverOutput(calls, i);
    const [est, outSrc]: [number, OutSrc] =
      r !== null && r >= visible * RECOVERY_MIN_SHARE ? [r, 'recovered'] : [visible, 'visible_est'];
    return { outputTokens: Math.trunc(Math.max(outLogged, est)), outLogged, outSrc };
  });
}
