// REST shapes for the Actions endpoints the CI core reads (jobs, runs, attempts). Parsed with z.object
// (unknown keys stripped); enum-like fields stay strings so a new GitHub value is never a parse error.
import { z } from 'zod';
import type { Gh } from '../gh/index.ts';
import type { RepoRef } from '../gh/types.ts';

export const ActionsStep = z.object({
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  number: z.number().int(),
  started_at: z.string().nullish(),
  completed_at: z.string().nullish(),
});

export const ActionsJob = z.object({
  id: z.number().int(),
  run_id: z.number().int(),
  run_attempt: z.number().int().nullish(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  created_at: z.string().nullish(),
  started_at: z.string().nullish(),
  completed_at: z.string().nullish(),
  html_url: z.string().nullish(),
  workflow_name: z.string().nullish(),
  head_sha: z.string(),
  head_branch: z.string().nullish(),
  runner_id: z.number().int().nullish(),
  runner_name: z.string().nullish(),
  steps: z.array(ActionsStep).nullish(),
});

export type ActionsStep = z.infer<typeof ActionsStep>;
export type ActionsJob = z.infer<typeof ActionsJob>;

/** GET repos/{o}/{r}/actions/jobs/{id}. A JSON 404 is RUN_NOT_FOUND. */
export async function fetchJob(o: { gh: Gh; repo: RepoRef; jobId: number }): Promise<ActionsJob> {
  const r = await o.gh.api({ path: `repos/{owner}/{repo}/actions/jobs/${o.jobId}`, repo: o.repo }, ActionsJob, {
    notFound: 'RUN_NOT_FOUND',
  });
  if (r.notModified) throw new Error('unreachable: unconditional request returned 304');
  return r.data;
}

const RED_STEP = ['failure', 'timed_out', 'cancelled'];

/** The step that failed, from the jobs API (never "UNKNOWN STEP"): the first failure, else timed out/cancelled. */
export function failingStep(steps: readonly ActionsStep[]): { number: number; name: string } | null {
  const s = steps.find((x) => x.conclusion === 'failure') ?? steps.find((x) => RED_STEP.includes(x.conclusion ?? ''));
  return s ? { number: s.number, name: s.name } : null;
}

export const ActionsRun = z.object({
  id: z.number().int(),
  head_sha: z.string(),
  head_branch: z.string().nullish(),
  event: z.string(),
  status: z.string().nullable(),
  conclusion: z.string().nullable(),
  workflow_id: z.number().int(),
  path: z.string().nullish(),
  run_attempt: z.number().int().nullish(),
  created_at: z.string(),
  run_started_at: z.string().nullish(),
});
export type ActionsRun = z.infer<typeof ActionsRun>;

const RunsPage = z.object({ total_count: z.number().int(), workflow_runs: z.array(ActionsRun) });
const JobsPage = z.object({ total_count: z.number().int(), jobs: z.array(ActionsJob) });

/** GET repos/{o}/{r}/actions/runs/{id}. */
export async function fetchRun(o: { gh: Gh; repo: RepoRef; runId: number }): Promise<ActionsRun> {
  const r = await o.gh.api({ path: `repos/{owner}/{repo}/actions/runs/${o.runId}`, repo: o.repo }, ActionsRun, {
    notFound: 'RUN_NOT_FOUND',
  });
  if (r.notModified) throw new Error('unreachable: unconditional request returned 304');
  return r.data;
}

/** GET repos/{o}/{r}/actions/workflows/{id}/runs with filters (one page, newest first). */
export async function listWorkflowRuns(o: {
  gh: Gh;
  repo: RepoRef;
  workflowId: number;
  fields: Record<string, string | number>;
}): Promise<ActionsRun[]> {
  const r = await o.gh.api(
    { path: `repos/{owner}/{repo}/actions/workflows/${o.workflowId}/runs`, repo: o.repo, fields: o.fields },
    RunsPage,
  );
  if (r.notModified) throw new Error('unreachable: unconditional request returned 304');
  return r.data.workflow_runs;
}

/** The jobs of a run (latest attempt), or of one attempt with `attempt`. Bounded to 3 pages. */
export async function listRunJobs(o: {
  gh: Gh;
  repo: RepoRef;
  runId: number;
  attempt?: number;
}): Promise<ActionsJob[]> {
  const path =
    o.attempt === undefined
      ? `repos/{owner}/{repo}/actions/runs/${o.runId}/jobs`
      : `repos/{owner}/{repo}/actions/runs/${o.runId}/attempts/${o.attempt}/jobs`;
  const r = await o.gh.api({ path, repo: o.repo, paginate: { maxPages: 3, itemsKey: 'jobs' } }, JobsPage, {
    notFound: 'RUN_NOT_FOUND',
  });
  if (r.notModified) throw new Error('unreachable: unconditional request returned 304');
  return r.data.jobs;
}

/** GET repos/{o}/{r}/actions/runs?head_sha=… (one page, newest first): every run on one commit. */
export async function listRunsForSha(o: { gh: Gh; repo: RepoRef; headSha: string }): Promise<ActionsRun[]> {
  const r = await o.gh.api(
    { path: 'repos/{owner}/{repo}/actions/runs', repo: o.repo, fields: { head_sha: o.headSha, per_page: 20 } },
    RunsPage,
  );
  if (r.notModified) throw new Error('unreachable: unconditional request returned 304');
  return r.data.workflow_runs;
}

const WorkflowsPage = z.object({ total_count: z.number().int().min(0) });

/**
 * GET repos/{o}/{r}/actions/workflows (per_page=1): the repo's workflow count, `total_count`. Read-only.
 * CI_NO_CHECKS (02 §8.2 row 10b) auto-passes only when it is 0 (CiFacts.workflowsTotal).
 */
export async function countWorkflows(o: { gh: Gh; repo: RepoRef }): Promise<number> {
  const r = await o.gh.api(
    { path: 'repos/{owner}/{repo}/actions/workflows', repo: o.repo, fields: { per_page: 1 } },
    WorkflowsPage,
  );
  if (r.notModified) throw new Error('unreachable: unconditional request returned 304');
  return r.data.total_count;
}
