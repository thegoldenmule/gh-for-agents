// `timeout-minutes` per job from a workflow file (03 M4.5, Q6): a line scanner, not a YAML parser.
// It reads only block-style `jobs.<id>.{timeout-minutes,name,strategy,uses}` at the job's own indent,
// so step-level timeouts never leak in. An expression, a flow-style mapping or anything unresolvable
// gives null, and the caller falls back to GitHub's own default of 360 minutes.

export const DEFAULT_TIMEOUT_MINUTES = 360;

export interface JobTimeoutEntry {
  id: string;
  /** The literal `name:`, which may contain `${{ }}` expressions. */
  name: string | null;
  /** A literal integer; null when absent or an expression. */
  timeoutMinutes: number | null;
  matrix: boolean;
  /** A reusable-workflow call: its jobs' limits live in the called file. */
  uses: boolean;
}

export interface WorkflowTimeouts {
  jobs: JobTimeoutEntry[];
}

export type TimeoutBasis = 'timeout-minutes' | 'default-360';

const indentOf = (line: string): number => line.length - line.trimStart().length;

function stripComment(line: string): string {
  const m = /(^|\s)#/.exec(line);
  return (m ? line.slice(0, m.index) : line).trimEnd();
}

const unquote = (v: string): string => {
  const t = v.trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t;
};

const KEY = /^([A-Za-z0-9_][\w.-]*|"[^"]+"|'[^']+'):(?:\s+(.*))?$/;

export function scanJobTimeouts(yaml: string): WorkflowTimeouts {
  const lines = yaml
    .split(/\r?\n/)
    .map(stripComment)
    .filter((l) => l.trim() !== '');
  const start = lines.findIndex((l) => /^jobs:$/.test(l));
  if (start < 0) return { jobs: [] };
  const jobs: JobTimeoutEntry[] = [];
  let jobIndent = -1;
  let childIndent = -1;
  let cur: JobTimeoutEntry | undefined;
  for (const raw of lines.slice(start + 1)) {
    const indent = indentOf(raw);
    if (indent === 0) break;
    if (jobIndent < 0) jobIndent = indent;
    const m = KEY.exec(raw.trim());
    if (indent === jobIndent) {
      cur = undefined;
      childIndent = -1;
      if (m?.[1] && !m[2]) {
        cur = { id: unquote(m[1]), name: null, timeoutMinutes: null, matrix: false, uses: false };
        jobs.push(cur);
      }
      continue;
    }
    if (!cur || indent < jobIndent) continue;
    if (childIndent < 0) childIndent = indent;
    if (indent !== childIndent || !m?.[1]) continue;
    const value = m[2] === undefined ? '' : unquote(m[2]);
    switch (unquote(m[1])) {
      case 'timeout-minutes':
        cur.timeoutMinutes = /^\d+$/.test(value) ? Number(value) : null;
        break;
      case 'name':
        cur.name = value || null;
        break;
      case 'strategy':
        cur.matrix = true;
        break;
      case 'uses':
        cur.uses = true;
        break;
    }
  }
  return { jobs };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A display-name matcher for a job: its literal name or id, a matrix suffix, and `${{ }}` as wildcards. */
function displayMatcher(label: string): RegExp {
  const parts = label.split(/\$\{\{.*?\}\}/);
  return new RegExp(`^${parts.map(escapeRe).join('.*?')}(?: \\(.*\\))?$`);
}

function findJob(scan: WorkflowTimeouts, displayName: string): JobTimeoutEntry | undefined {
  const exact = scan.jobs.find((j) => displayName === (j.name ?? j.id) || displayName === j.id);
  if (exact) return exact;
  const loose = scan.jobs.find((j) => displayMatcher(j.name ?? j.id).test(displayName));
  if (loose) return loose;
  // A reusable-workflow job shows as "<caller> / <called job>".
  const caller = displayName.split(' / ')[0];
  return caller !== displayName && caller
    ? scan.jobs.find((j) => j.uses && displayMatcher(j.name ?? j.id).test(caller))
    : undefined;
}

/** The job's limit: a literal `timeout-minutes`, else 360 (GitHub's default, and when the scan cannot tell). */
export function jobTimeoutFor(
  scan: WorkflowTimeouts | null | undefined,
  displayName: string,
): { minutes: number; basis: TimeoutBasis } {
  const j = scan ? findJob(scan, displayName) : undefined;
  if (j && !j.uses && j.timeoutMinutes !== null) return { minutes: j.timeoutMinutes, basis: 'timeout-minutes' };
  return { minutes: DEFAULT_TIMEOUT_MINUTES, basis: 'default-360' };
}
