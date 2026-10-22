// Rollup contexts → Check (02 §1.5; 03 M2.2): CheckRun and StatusContext normalisation, bucket
// mapping, collapse to the latest attempt per (workflow, name), and ci.ignore matching.
import { z } from 'zod';
import type { IgnoredCheck } from '../config/sections/ci.ts';
import { DEFAULT_HOST, type RepoRef } from '../gh/types.ts';
import type { Bucket, Check } from '../schemas/ci.ts';
import { matchesGlob } from '../util/glob.ts';

// ── GraphQL shapes (statusCheckRollup.contexts.nodes) ───────────────────────
// Enum-like fields stay strings, never a parse failure: an unknown future status maps to `pending`, an
// unknown conclusion to `fail` (both fail closed).
export const RollupCheckRun = z.object({
  __typename: z.literal('CheckRun'),
  databaseId: z.number().int().nullable(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  detailsUrl: z.string().nullable(),
  isRequired: z.boolean().nullable(),
  checkSuite: z
    .object({
      app: z.object({ slug: z.string() }).nullable(),
      workflowRun: z
        .object({
          databaseId: z.number().int().nullable(),
          event: z.string().nullable(),
          file: z.object({ path: z.string() }).nullable(),
          workflow: z.object({ databaseId: z.number().int().nullable(), name: z.string() }),
        })
        .nullable(),
    })
    .nullable(),
});

export const RollupStatusContext = z.object({
  __typename: z.literal('StatusContext'),
  context: z.string(),
  state: z.string(),
  targetUrl: z.string().nullable(),
  createdAt: z.string(),
  isRequired: z.boolean().nullable(),
});

export const RollupContext = z.discriminatedUnion('__typename', [RollupCheckRun, RollupStatusContext]);

export type RollupCheckRun = z.infer<typeof RollupCheckRun>;
export type RollupStatusContext = z.infer<typeof RollupStatusContext>;
export type RollupContext = z.infer<typeof RollupContext>;

/** One ci.ignore entry (config/sections/ci.ts). */
export type IgnoreRule = z.infer<typeof IgnoredCheck>;

/** The workflow behind an Actions check, keyed by run id in the snapshot (compare-main needs the id/path). */
export interface WorkflowRunInfo {
  runId: number;
  workflowId: number | null;
  workflowName: string;
  workflowPath: string | null;
  event: string | null;
}

// ── Mapping ─────────────────────────────────────────────────────────────────
const FAIL_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED']);

/** gh's `pr checks` buckets. `cancelled` is its own bucket and counts as red in the summary. */
export function checkRunBucket(status: string, conclusion: string | null): Bucket {
  if (status.toUpperCase() !== 'COMPLETED' || conclusion === null) return 'pending';
  const c = conclusion.toUpperCase();
  if (c === 'SUCCESS') return 'pass';
  if (FAIL_CONCLUSIONS.has(c)) return 'fail';
  if (c === 'CANCELLED') return 'cancelled';
  if (c === 'SKIPPED') return 'skipped';
  // NEUTRAL, and STALE (GitHub gave up on an incomplete run): neither passed nor failed.
  if (c === 'NEUTRAL' || c === 'STALE') return 'neutral';
  // A conclusion this ghx doesn't know fails closed: never a pass by accident.
  return 'fail';
}

export function checkRunStatus(status: string): Check['status'] {
  switch (status.toUpperCase()) {
    case 'COMPLETED':
      return 'completed';
    case 'IN_PROGRESS':
      return 'in_progress';
    case 'WAITING':
      return 'waiting';
    default:
      // QUEUED, REQUESTED, PENDING.
      return 'queued';
  }
}

export function statusContextBucket(state: string): Bucket {
  switch (state.toUpperCase()) {
    case 'SUCCESS':
      return 'pass';
    case 'FAILURE':
    case 'ERROR':
      return 'fail';
    default:
      return 'pending';
  }
}

function webBase(repo: RepoRef): string {
  return `https://${repo.host || DEFAULT_HOST}/${repo.owner}/${repo.name}`;
}

/** Check.url is never null: a context without a link falls back to the commit's checks page. */
export function fallbackCheckUrl(repo: RepoRef, headSha: string): string {
  return `${webBase(repo)}/commit/${headSha}/checks`;
}

function absoluteUrl(u: string | null, fallback: string): string {
  if (!u) return fallback;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? u : fallback;
  } catch {
    return fallback;
  }
}

/** A normalised check plus the ordering key used to pick the latest attempt. */
export interface RankedCheck {
  check: Check;
  /** CheckRun.databaseId (monotonic: a re-run gets a larger id); for a StatusContext, createdAt in ms. */
  rank: number;
}

export function normaliseContext(node: RollupContext, o: { repo: RepoRef; headSha: string }): RankedCheck {
  const fallback = fallbackCheckUrl(o.repo, o.headSha);
  if (node.__typename === 'StatusContext') {
    const bucket = statusContextBucket(node.state);
    const state = node.state.toUpperCase();
    const done = bucket !== 'pending';
    return {
      rank: Date.parse(node.createdAt) || 0,
      check: {
        name: node.context,
        workflow: null,
        kind: 'status',
        bucket,
        status: done ? 'completed' : state === 'EXPECTED' ? 'expected' : 'in_progress',
        conclusion: done ? node.state.toLowerCase() : null,
        required: node.isRequired === true,
        runId: null,
        jobId: null,
        attempt: null,
        url: absoluteUrl(node.targetUrl, fallback),
        startedAt: node.createdAt,
        completedAt: done ? node.createdAt : null,
      },
    };
  }
  const run = node.checkSuite?.workflowRun ?? null;
  const actions = run !== null;
  return {
    rank: node.databaseId ?? 0,
    check: {
      name: node.name,
      workflow: run?.workflow.name ?? null,
      kind: actions ? 'actions' : 'app',
      bucket: checkRunBucket(node.status, node.conclusion),
      status: checkRunStatus(node.status),
      conclusion: node.conclusion === null ? null : node.conclusion.toLowerCase(),
      required: node.isRequired === true,
      runId: run?.databaseId ?? null,
      // Only an Actions check run's id is a job id; an app's check-run id is not.
      jobId: actions ? node.databaseId : null,
      // GraphQL exposes no run attempt; the jobs API (run_attempt) supplies it where it matters.
      attempt: null,
      url: absoluteUrl(node.detailsUrl, fallback),
      startedAt: node.startedAt,
      completedAt: node.completedAt,
    },
  };
}

const keyOf = (c: Check): string => `${c.kind}\u0000${c.workflow ?? ''}\u0000${c.name}`;

/** Duplicate re-run rows collapse to the latest attempt per (workflow, name) (§6). Order is kept. */
export function collapseLatest(ranked: readonly RankedCheck[]): Check[] {
  const best = new Map<string, RankedCheck>();
  for (const r of ranked) {
    const k = keyOf(r.check);
    const cur = best.get(k);
    if (!cur || r.rank > cur.rank) best.set(k, r);
  }
  const keep = new Set(best.values());
  return ranked.filter((r) => keep.has(r)).map((r) => r.check);
}

function globOrEqual(value: string, pattern: string): boolean {
  return value === pattern || matchesGlob(value, pattern);
}

/** The ci.ignore rule that matches this check, if any. A string rule matches the name (exact or glob). */
export function ignoreRuleFor(check: Pick<Check, 'name' | 'workflow'>, rules: readonly IgnoreRule[]) {
  return rules.find((r) => {
    if (typeof r === 'string') return globOrEqual(check.name, r);
    if (!globOrEqual(check.name, r.name)) return false;
    return r.workflow === undefined || (check.workflow !== null && globOrEqual(check.workflow, r.workflow));
  });
}

export interface NormalisedRollup {
  /** Considered checks: latest attempt only, ignored ones removed. */
  checks: Check[];
  /** Names of ignored checks (counted in counts.ignored). */
  ignored: string[];
  runs: Record<string, WorkflowRunInfo>;
}

/** normalise → collapse to the latest attempt → drop ci.ignore matches. */
export function normaliseRollup(
  nodes: readonly RollupContext[],
  o: { repo: RepoRef; headSha: string; ignore?: readonly IgnoreRule[] },
): NormalisedRollup {
  const runs: Record<string, WorkflowRunInfo> = {};
  for (const n of nodes) {
    const run = n.__typename === 'CheckRun' ? n.checkSuite?.workflowRun : null;
    if (run?.databaseId != null) {
      runs[String(run.databaseId)] = {
        runId: run.databaseId,
        workflowId: run.workflow.databaseId,
        workflowName: run.workflow.name,
        workflowPath: run.file?.path ?? null,
        event: run.event,
      };
    }
  }
  const latest = collapseLatest(nodes.map((n) => normaliseContext(n, o)));
  const checks: Check[] = [];
  const ignored: string[] = [];
  for (const c of latest) {
    if (ignoreRuleFor(c, o.ignore ?? [])) ignored.push(c.name);
    else checks.push(c);
  }
  return { checks, ignored, runs };
}
