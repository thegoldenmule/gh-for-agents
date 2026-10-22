// KEY_STEP_SKIPPED facts (02 §8.2 row 12, §6's misleading green): a `ci.keySteps` step that was skipped in
// a job that still concluded success. The caller fetches the jobs (actions/runs/{id}/jobs); this stays pure.

export interface KeyStepJob {
  name: string;
  conclusion: string | null;
  steps?: readonly { name: string; conclusion: string | null }[] | null;
}

export interface SkippedKeyStep {
  job: string;
  step: string;
}

export function skippedKeySteps(jobs: readonly KeyStepJob[], keySteps: readonly string[]): SkippedKeyStep[] {
  if (keySteps.length === 0) return [];
  const wanted = new Set(keySteps);
  return jobs.flatMap((j) =>
    j.conclusion === 'success'
      ? (j.steps ?? [])
          .filter((s) => wanted.has(s.name) && s.conclusion === 'skipped')
          .map((s) => ({ job: j.name, step: s.name }))
      : [],
  );
}
