// Shared-with-main (02 §1.5; 03 M2.5): one definition for ci why, ci wait, pr status and pr merge.
//
// - The comparison branch is the repo default branch, never the PR base (stacked PRs, §4.1).
// - The comparison run is the latest completed `push` run of the same workflow there whose head_sha
//   differs from the PR head.
// - A failing PR job is shared only if that run has a same-named job that concluded `failure` and
//   either the PR's failing tests are non-empty and a subset of main's (`same-tests`), or neither side
//   yields test names and the failing step names are equal (`same-step`). A job-name match alone never
//   counts (§4.3, §7 #3246).
// - A main run without a same-named job, or whose job did not fail or pass, is `different`.
import { z } from 'zod';
import type { ArtifactStore } from '../core/artifacts.ts';
import type { Clock } from '../core/clock.ts';
import type { Gh } from '../gh/index.ts';
import type { RepoRef } from '../gh/types.ts';
import { CI_CAPS, type SameOnMain } from '../schemas/ci.ts';
import { type JsonCache, repoCache } from './cache.ts';
import { type ActionsJob, type ActionsRun, fetchRun, listRunJobs, listWorkflowRuns } from './github.ts';
import { analyzeJob } from './logs/analyze.ts';

/** How long a "latest main run for this workflow" lookup is reused. */
export const MAIN_RUN_TTL_MS = 5 * 60_000;

export interface FailingJobFacts {
  /** The job name, as both the rollup and the jobs API show it. */
  name: string;
  /** The PR job's run (to find the workflow when `workflowId` is unknown). */
  runId: number;
  /** The workflow id, when the snapshot already knows it (CiSnapshot.runs). */
  workflowId?: number | null;
  tests: readonly string[];
  step: { number: number; name: string } | null;
}

export interface MainSide {
  run: Pick<ActionsRun, 'id' | 'head_sha' | 'created_at' | 'run_started_at'> | null;
  /** The same-named job on that run, if any. */
  job: { conclusion: string | null; tests: readonly string[]; step: { number: number; name: string } | null } | null;
}

const cap = (xs: readonly string[]): string[] => xs.slice(0, CI_CAPS.tests);

/** `not-compared`: a non-Actions check, or comparison disabled (--no-compare-main). */
export function notCompared(mainBranch: string): SameOnMain {
  return {
    verdict: 'not-compared',
    mainBranch,
    mainRunId: null,
    mainSha: null,
    mainRunAt: null,
    prTests: [],
    mainTests: [],
    newTests: [],
  };
}

/** The verdict from both sides (pure). */
export function compareVerdict(
  pr: Pick<FailingJobFacts, 'tests' | 'step'>,
  main: MainSide,
  mainBranch: string,
): SameOnMain {
  const base = {
    mainBranch,
    mainRunId: main.run?.id ?? null,
    mainSha: main.run?.head_sha ?? null,
    mainRunAt: main.run ? (main.run.run_started_at ?? main.run.created_at) : null,
    prTests: cap(pr.tests),
  };
  if (!main.run) return { ...base, verdict: 'no-main-run', mainTests: [], newTests: [] };
  const mainTests = main.job?.tests ?? [];
  const onMain = new Set(mainTests);
  const newTests = pr.tests.filter((t) => !onMain.has(t));
  const out = { ...base, mainTests: cap(mainTests), newTests: cap(newTests) };
  if (!main.job) return { ...out, verdict: 'different' };
  if (main.job.conclusion === 'success') return { ...out, verdict: 'main-green' };
  if (main.job.conclusion !== 'failure') return { ...out, verdict: 'different' };
  if (pr.tests.length > 0 && newTests.length === 0) return { ...out, verdict: 'same-tests' };
  if (
    pr.tests.length === 0 &&
    mainTests.length === 0 &&
    pr.step !== null &&
    main.job.step !== null &&
    pr.step.name === main.job.step.name
  ) {
    return { ...out, verdict: 'same-step' };
  }
  return { ...out, verdict: 'different' };
}

const CachedRun = z
  .object({ id: z.number(), head_sha: z.string(), created_at: z.string(), run_started_at: z.string().nullish() })
  .nullable();
const CachedTests = z.object({
  tests: z.array(z.string()),
  step: z.object({ number: z.number(), name: z.string() }).nullable(),
});

export interface MainComparerOptions {
  gh: Gh;
  artifacts: ArtifactStore;
  clock: Clock;
  repo: RepoRef;
  /** CiSnapshot.defaultBranch: the repo default branch, not the PR base. */
  defaultBranch: string;
  prHeadSha: string;
  logPatterns?: readonly string[];
  warn?: (w: { code: string; message: string }) => void;
}

export interface MainComparer {
  compare(job: FailingJobFacts): Promise<SameOnMain>;
  /** The latest completed push run of a workflow on the default branch (cached). */
  mainRun(workflowId: number): Promise<MainSide['run']>;
  /** The jobs of a main run (memoized per invocation). */
  mainJobs(runId: number): Promise<ActionsJob[]>;
  /** Parsed failing tests and step of a job (disk-cached by job id; logs are immutable). */
  jobTests(job: ActionsJob): Promise<{ tests: string[]; step: { number: number; name: string } | null }>;
}

export function createMainComparer(o: MainComparerOptions): MainComparer {
  let cacheP: Promise<JsonCache> | undefined;
  const cache = (): Promise<JsonCache> => {
    cacheP ??= repoCache({ artifacts: o.artifacts, repo: o.repo, clock: o.clock, ns: 'compare-main' });
    return cacheP;
  };
  const workflowOf = new Map<number, Promise<number>>();
  const runs = new Map<number, Promise<MainSide['run']>>();
  const jobs = new Map<number, Promise<ActionsJob[]>>();

  const workflowId = (j: FailingJobFacts): Promise<number> => {
    if (j.workflowId != null) return Promise.resolve(j.workflowId);
    let p = workflowOf.get(j.runId);
    if (!p) {
      p = fetchRun({ gh: o.gh, repo: o.repo, runId: j.runId }).then((r) => r.workflow_id);
      workflowOf.set(j.runId, p);
    }
    return p;
  };

  const mainRun = (wf: number): Promise<MainSide['run']> => {
    let p = runs.get(wf);
    if (!p) {
      p = (async () => {
        const c = await cache();
        const key = `main-run:${wf}:${o.defaultBranch}:${o.prHeadSha}`;
        const hit = c.get(key, CachedRun);
        if (hit !== undefined) return hit;
        const list = await listWorkflowRuns({
          gh: o.gh,
          repo: o.repo,
          workflowId: wf,
          fields: { branch: o.defaultBranch, event: 'push', status: 'completed', per_page: 10 },
        });
        const r = list.find((x) => x.head_sha !== o.prHeadSha) ?? null;
        const run = r
          ? { id: r.id, head_sha: r.head_sha, created_at: r.created_at, run_started_at: r.run_started_at ?? null }
          : null;
        c.set(key, run, MAIN_RUN_TTL_MS);
        return run;
      })();
      runs.set(wf, p);
    }
    return p;
  };

  const mainJobs = (runId: number): Promise<ActionsJob[]> => {
    let p = jobs.get(runId);
    if (!p) {
      p = listRunJobs({ gh: o.gh, repo: o.repo, runId });
      jobs.set(runId, p);
    }
    return p;
  };

  const jobTests = async (job: ActionsJob) => {
    const c = await cache();
    const key = `tests:job-${job.id}`;
    const hit = c.get(key, CachedTests);
    if (hit) return hit;
    const a = await analyzeJob({
      gh: o.gh,
      artifacts: o.artifacts,
      repo: o.repo,
      jobId: job.id,
      job,
      ...(o.logPatterns ? { logPatterns: o.logPatterns } : {}),
    });
    for (const w of a.warnings) o.warn?.({ code: w.code, message: `${o.defaultBranch} comparison: ${w.message}` });
    const value = { tests: a.tests, step: a.step };
    // Only a parsed log is immutable; a not-ready or expired log is not cached.
    if (a.logPath !== null) c.set(key, value, null);
    return value;
  };

  return {
    mainRun,
    mainJobs,
    jobTests,
    async compare(j) {
      const run = await mainRun(await workflowId(j));
      if (!run) return compareVerdict(j, { run: null, job: null }, o.defaultBranch);
      const same = (await mainJobs(run.id)).find((x) => x.name === j.name) ?? null;
      if (same?.conclusion !== 'failure') {
        return compareVerdict(
          j,
          { run, job: same ? { conclusion: same.conclusion, tests: [], step: null } : null },
          o.defaultBranch,
        );
      }
      const parsed = await jobTests(same);
      return compareVerdict(j, { run, job: { conclusion: 'failure', ...parsed } }, o.defaultBranch);
    },
  };
}
