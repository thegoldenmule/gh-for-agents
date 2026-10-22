// Step attribution (02 §12 step 3; 03 §5.1). The runner opens each step with a `##[group]Run …` header
// (post steps with `Post job cleanup.`, the last step with `Cleaning up orphan processes`). Segments
// between headers are matched to the jobs-API step list by timestamp, falling back to order when the
// log has no timestamps. The failing step is always named from the API, never "UNKNOWN STEP" (§6).
import type { ActionsStep } from '../github.ts';

export interface LogSegment {
  /** The header text that opened the segment (null for the lines before the first header). */
  header: string | null;
  /** 0-based line range in the cleaned log, inclusive. */
  startLine: number;
  endLine: number;
  /** Runner timestamp of the segment's first line, when the log had them. */
  ts: string | null;
}

export interface StepSpan {
  number: number;
  name: string;
  startLine: number;
  endLine: number;
}

const STEP_HEADER = /^##\[group\](Run .*)$/;
const POST_HEADER = /^Post job cleanup\.$/;
const COMPLETE_HEADER = /^Cleaning up orphan processes$/;
/** Newer runners mark step ends; they carry no attribution of their own. */
export const END_ACTION = /^##\[end-action\b/;

export function stepHeader(line: string): string | null {
  const m = STEP_HEADER.exec(line);
  if (m) return m[1] ?? null;
  if (POST_HEADER.test(line) || COMPLETE_HEADER.test(line)) return line;
  return null;
}

/** Collect segments one cleaned line at a time (fed by stripLogFile's onLine). */
export function createSegmenter(): {
  push(text: string, index: number, ts: string | null): void;
  finish(): LogSegment[];
} {
  const segments: LogSegment[] = [];
  let cur: LogSegment | undefined;
  return {
    push(text, index, ts) {
      const h = stepHeader(text);
      if (!cur || h !== null) {
        cur = { header: h, startLine: index, endLine: index, ts };
        segments.push(cur);
      } else {
        cur.endLine = index;
        cur.ts ??= ts;
      }
    },
    finish: () => segments,
  };
}

export function segmentLines(lines: readonly string[], ts: readonly (string | null)[] = []): LogSegment[] {
  const s = createSegmenter();
  for (const [i, l] of lines.entries()) s.push(l, i, ts[i] ?? null);
  return s.finish();
}

const sec = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
};

/** Steps that produced log output, in order (skipped steps write nothing). */
function executed(steps: readonly ActionsStep[]): ActionsStep[] {
  return [...steps]
    .filter((s) => s.conclusion !== 'skipped' && s.status !== 'queued')
    .sort((a, b) => a.number - b.number);
}

function byTimestamp(segments: readonly LogSegment[], steps: readonly ActionsStep[]): (ActionsStep | null)[] {
  let pointer = 0;
  return segments.map((seg) => {
    const t = sec(seg.ts);
    if (t === null) return steps[pointer] ?? null;
    const candidates = steps
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => {
        if (i < pointer) return false;
        const start = sec(s.started_at);
        const end = sec(s.completed_at);
        return start !== null && start <= t && (end === null || end >= t);
      });
    let pick = candidates[0];
    if (candidates.length > 1) {
      pick =
        candidates.find(({ s }) => seg.header !== null && s.name === seg.header) ??
        (seg.header !== null ? candidates.find(({ i }) => i > pointer) : undefined) ??
        candidates[0];
    }
    if (!pick) {
      // Outside every window (clock skew): the latest step that started at or before t.
      const started = steps
        .map((s, i) => ({ s, i }))
        .filter(({ s, i }) => i >= pointer && (sec(s.started_at) ?? Infinity) <= t);
      pick = started.at(-1);
    }
    if (!pick) return steps[pointer] ?? null;
    pointer = pick.i;
    return pick.s;
  });
}

function byOrder(segments: readonly LogSegment[], steps: readonly ActionsStep[]): (ActionsStep | null)[] {
  let i = 0;
  return segments.map((seg, k) => {
    if (k > 0 && seg.header !== null) i = Math.min(i + 1, steps.length - 1);
    return steps[i] ?? null;
  });
}

/**
 * Attribute segments to API steps. With no step headers at all, the whole log goes to `fallback`
 * (normally the failing step from the API).
 */
export function attributeSteps(
  segments: readonly LogSegment[],
  apiSteps: readonly ActionsStep[],
  fallback?: { number: number; name: string } | null,
): StepSpan[] {
  if (segments.length === 0) return [];
  const last = segments.at(-1)?.endLine ?? 0;
  if (!segments.some((s) => s.header !== null)) {
    return fallback ? [{ number: fallback.number, name: fallback.name, startLine: 0, endLine: last }] : [];
  }
  const steps = executed(apiSteps);
  if (steps.length === 0) return [];
  const timed = segments.some((s) => s.ts !== null) && steps.some((s) => s.started_at);
  const owners = timed ? byTimestamp(segments, steps) : byOrder(segments, steps);
  const spans: StepSpan[] = [];
  segments.forEach((seg, k) => {
    const owner = owners[k];
    if (!owner) return;
    const prev = spans.at(-1);
    if (prev && prev.number === owner.number) prev.endLine = seg.endLine;
    else spans.push({ number: owner.number, name: owner.name, startLine: seg.startLine, endLine: seg.endLine });
  });
  return spans;
}

/** Every span belonging to step `number` (a step may be split by another step's output in odd logs). */
export function spansFor(spans: readonly StepSpan[], number: number): StepSpan[] {
  return spans.filter((s) => s.number === number);
}
