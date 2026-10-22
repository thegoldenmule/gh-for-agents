// Misleading green (02 §12 `suspicious`, §6; 03 M3.2): a job that concluded success although one of its
// `ci.keySteps` steps was skipped (for example a test step behind an `if:` that is false on PRs). Read
// from actions/runs/{id}/jobs, and only when ci.keySteps is configured, so the default costs no call.
// Step names match exactly, as in src/policy/key-steps.ts (KEY_STEP_SKIPPED).
// `no-tests-ran` is in the output enum, but neither plan defines how to detect it, so nothing produces it.
import { z } from 'zod';
import { rethrowControlFlow } from '../core/control-flow.ts';
import type { Gh } from '../gh/index.ts';
import type { RepoRef } from '../gh/types.ts';
import { type ActionsJob, listRunJobs } from './github.ts';

export const Suspicious = z.object({
  workflow: z.string(),
  job: z.string(),
  jobId: z.number().int(),
  step: z.string(),
  reason: z.enum(['key-step-skipped', 'no-tests-ran']),
});
export type Suspicious = z.infer<typeof Suspicious>;

/** Green jobs whose key step was skipped (pure). */
export function keyStepSkipped(jobs: readonly ActionsJob[], keySteps: readonly string[]): Suspicious[] {
  if (keySteps.length === 0) return [];
  const wanted = new Set(keySteps);
  return jobs.flatMap((j) =>
    j.conclusion === 'success'
      ? (j.steps ?? [])
          .filter((s) => wanted.has(s.name) && s.conclusion === 'skipped')
          .map((s) => ({
            workflow: j.workflow_name ?? '',
            job: j.name,
            jobId: j.id,
            step: s.name,
            reason: 'key-step-skipped' as const,
          }))
      : [],
  );
}

/**
 * The suspicious jobs across `runIds` (the Actions runs on the head). A run whose jobs cannot be read
 * is skipped with the warning KEY_STEPS_UNCHECKED; `jobsByRun` supplies lists the caller already has.
 */
export async function findSuspicious(o: {
  gh: Gh;
  repo: RepoRef;
  runIds: readonly number[];
  keySteps: readonly string[];
  jobsByRun?: ReadonlyMap<number, readonly ActionsJob[]>;
  warn?: (w: { code: string; message: string }) => void;
}): Promise<Suspicious[]> {
  if (o.keySteps.length === 0) return [];
  const out: Suspicious[] = [];
  for (const runId of o.runIds) {
    let jobs = o.jobsByRun?.get(runId);
    if (!jobs) {
      try {
        jobs = await listRunJobs({ gh: o.gh, repo: o.repo, runId });
      } catch (e) {
        rethrowControlFlow(e);
        o.warn?.({
          code: 'KEY_STEPS_UNCHECKED',
          message: `ci.keySteps not checked for run ${runId}: ${e instanceof Error ? e.message : String(e)}`,
        });
        continue;
      }
    }
    out.push(...keyStepSkipped(jobs, o.keySteps));
  }
  return out;
}
