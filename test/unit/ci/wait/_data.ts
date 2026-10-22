// Builders for the ci wait pure-module tests: checks, Actions jobs and times relative to a FakeClock origin.
import type { ActionsJob } from '../../../../src/ci/github.ts';
import type { Check } from '../../../../src/schemas/ci.ts';

/** FakeClock's default epoch (2026-10-22T12:00:00Z). */
export const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
export const MIN = 60_000;
export const SEC = 1_000;

export const iso = (ms: number): string => new Date(ms).toISOString();
/** ISO time `m` minutes after T0. */
export const at = (m: number): string => iso(T0 + m * MIN);

export function check(name: string, o: Partial<Check> = {}): Check {
  const pending = o.bucket === undefined || o.bucket === 'pending';
  return {
    name,
    workflow: 'CI',
    kind: 'actions',
    bucket: 'pending',
    status: pending ? 'in_progress' : 'completed',
    conclusion: null,
    required: false,
    runId: 1,
    jobId: null,
    attempt: null,
    url: 'https://github.com/o/r/actions/runs/1',
    startedAt: at(0),
    completedAt: null,
    ...o,
  };
}

export const passed = (name: string, completedMin = 5, o: Partial<Check> = {}): Check =>
  check(name, { bucket: 'pass', status: 'completed', conclusion: 'success', completedAt: at(completedMin), ...o });

export function job(id: number, name: string, o: Partial<ActionsJob> = {}): ActionsJob {
  return {
    id,
    run_id: 1,
    run_attempt: 1,
    name,
    status: 'in_progress',
    conclusion: null,
    created_at: at(0),
    started_at: at(0),
    completed_at: null,
    html_url: null,
    workflow_name: 'CI',
    head_sha: 'a'.repeat(40),
    head_branch: 'feat',
    runner_id: 7,
    runner_name: 'GitHub Actions 7',
    steps: [],
    ...o,
  };
}
