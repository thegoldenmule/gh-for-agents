// Workflow runs GitHub rejected before any job ran (02 §1.5). A workflow file that fails validation
// still gets a run, but it completes `failure` or `startup_failure` with zero jobs, so no check run
// exists: read raw, that is "no checks". ghx reports each such run as one red Actions check (named for
// its workflow file, `jobId: null`, `url` the run page), so pr status, ci why, ci wait and pr merge see red.
//
// No API returns the validation message: the run, its check suite and its (empty) jobs carry none, and
// `display_title` is the commit subject. The run page shows it, so the warning and `next` point there.
// Sources: a commit's GraphQL check suites (CI_COMMIT_FIELDS) and REST run rows with no job.
import { z } from 'zod';
import type { RepoRef } from '../gh/types.ts';
import type { Check } from '../schemas/ci.ts';
import type { RollupCheckRun } from './checks.ts';

/** Run conclusions that, with no job, mean GitHub refused the workflow. Not `action_required` or `cancelled`. */
const INVALID_CONCLUSIONS: ReadonlySet<string> = new Set(['failure', 'startup_failure']);

/** The reason a ci wait ends on such a run. */
export const WORKFLOW_INVALID_REASON = 'workflow-invalid';

export interface InvalidRun {
  runId: number;
  workflowId: number | null;
  /** The workflow's name; GitHub names a run it could not parse after its file. */
  workflow: string;
  /** The workflow file, e.g. `.github/workflows/ci.yml`. */
  path: string | null;
  /** The run page, where GitHub shows the error. */
  url: string;
  /** Lower case: `failure` or `startup_failure`. */
  conclusion: string;
  event: string | null;
  /** When the run was created (it completes at once). */
  at: string | null;
}

/** A completed run that failed without a single job: GitHub rejected its workflow. */
export function isInvalidRun(status: string | null | undefined, conclusion: string | null | undefined, jobs: number) {
  return (
    jobs === 0 && status?.toLowerCase() === 'completed' && INVALID_CONCLUSIONS.has(conclusion?.toLowerCase() ?? '')
  );
}

export function runPageUrl(repo: RepoRef, runId: number): string {
  return `https://${repo.host}/${repo.owner}/${repo.name}/actions/runs/${runId}`;
}

/** The synthetic rollup node for one rejected run; checks.ts normalises it into a red Actions check. */
export function invalidRunNode(r: InvalidRun): RollupCheckRun {
  return {
    __typename: 'CheckRun',
    // No job, so no check-run id: the check's jobId is null, which is what marks it (isInvalidRunCheck).
    databaseId: null,
    name: r.path ?? r.workflow,
    status: 'COMPLETED',
    conclusion: r.conclusion.toUpperCase(),
    startedAt: r.at,
    completedAt: r.at,
    detailsUrl: r.url,
    isRequired: false,
    checkSuite: {
      app: { slug: 'github-actions' },
      workflowRun: {
        databaseId: r.runId,
        event: r.event,
        file: r.path ? { path: r.path } : null,
        workflow: { databaseId: r.workflowId, name: r.workflow },
      },
    },
  };
}

/**
 * A check made by invalidRunNode. Every real Actions check is a job with an id; only a run GitHub
 * rejected before any job ran is an Actions check with a run and no job.
 */
export function isInvalidRunCheck(c: Pick<Check, 'kind' | 'jobId' | 'runId'>): boolean {
  return c.kind === 'actions' && c.jobId === null && c.runId !== null;
}

// ── GraphQL: a commit's check suites (inside CI_COMMIT_FIELDS) ───────────────────────────────────
/** Suites read per commit. Actions makes one per workflow run; other apps' suites are skipped. */
export const SUITES_PER_COMMIT = 50;

export const CHECK_SUITE_FIELDS =
  `checkSuites(first:${SUITES_PER_COMMIT}){nodes{status conclusion checkRuns(first:0){totalCount} ` +
  'workflowRun{databaseId url createdAt event file{path} workflow{databaseId name}}}}';

export const RollupSuite = z.object({
  status: z.string(),
  conclusion: z.string().nullable(),
  checkRuns: z.object({ totalCount: z.number().int() }).nullable(),
  workflowRun: z
    .object({
      databaseId: z.number().int().nullable(),
      url: z.string().nullable(),
      createdAt: z.string().nullable(),
      event: z.string().nullable(),
      file: z.object({ path: z.string() }).nullable(),
      workflow: z.object({ databaseId: z.number().int().nullable(), name: z.string() }),
    })
    .nullable(),
});
export type RollupSuite = z.infer<typeof RollupSuite>;

/** The rejected runs among a commit's check suites. */
export function invalidFromSuites(nodes: readonly (RollupSuite | null)[] | undefined, repo: RepoRef): InvalidRun[] {
  const out: InvalidRun[] = [];
  for (const s of nodes ?? []) {
    const run = s?.workflowRun;
    if (!s || !run || run.databaseId === null || s.checkRuns === null) continue;
    if (!isInvalidRun(s.status, s.conclusion, s.checkRuns.totalCount)) continue;
    out.push({
      runId: run.databaseId,
      workflowId: run.workflow.databaseId,
      workflow: run.workflow.name,
      path: run.file?.path ?? null,
      url: run.url ?? runPageUrl(repo, run.databaseId),
      conclusion: (s.conclusion ?? 'failure').toLowerCase(),
      event: run.event,
      at: run.createdAt,
    });
  }
  return out;
}

// ── REST: a run row (actions/runs, actions/runs/{id}) ────────────────────────────────────────────
export interface RestRunRow {
  id: number;
  name?: string | null | undefined;
  path?: string | null | undefined;
  html_url?: string | null | undefined;
  conclusion: string | null;
  workflow_id: number;
  event?: string | null | undefined;
  created_at?: string | null | undefined;
}

/** A REST run row already known to be rejected (isInvalidRun) as an InvalidRun. */
export function invalidFromRun(run: RestRunRow, repo: RepoRef): InvalidRun {
  // A dynamic run's path carries `@ref`; the file is what to fix.
  const path = run.path ? run.path.replace(/@.*$/, '') : null;
  return {
    runId: run.id,
    workflowId: run.workflow_id,
    workflow: run.name ?? path ?? String(run.workflow_id),
    path,
    url: run.html_url ?? runPageUrl(repo, run.id),
    conclusion: (run.conclusion ?? 'failure').toLowerCase(),
    event: run.event ?? null,
    at: run.created_at ?? null,
  };
}

// ── What a reader says about them ────────────────────────────────────────────────────────────────
type Rejected = Pick<Check, 'name' | 'runId' | 'url' | 'conclusion'>;

/** WORKFLOW_INVALID, one per rejected run. */
export function invalidRunWarning(c: Rejected): { code: string; message: string } {
  return {
    code: 'WORKFLOW_INVALID',
    message:
      `GitHub rejected ${c.name} before any job ran (run ${c.runId} concluded ${c.conclusion ?? 'failure'} with no ` +
      `jobs), usually an invalid workflow file. The API returns no error text; the run page shows it: ${c.url}`,
  };
}

/** `next` for rejected runs: fix each file and push. Never a re-wait or a rerun: neither can change it. */
export function invalidRunNext(checks: readonly Rejected[]): string[] {
  return checks.map(
    (c) => `Fix ${c.name}: GitHub rejected it before any job ran. Read the error on ${c.url}, then commit and push.`,
  );
}
