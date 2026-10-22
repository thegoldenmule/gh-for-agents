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
