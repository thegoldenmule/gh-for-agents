// Shared-with-main (02 §1.5; 03 M2.5): one definition for ci why, ci wait, pr status and pr merge.
//
// - The comparison branch is the repo default branch, never the PR base (stacked PRs, §4.1).
// - The comparison run is the latest completed `push` run of the same workflow there whose head_sha
//   differs from the PR head.
// - A failing PR job is shared only if that run has a same-named job that concluded `failure` and
//   either the PR's failing tests are non-empty and a subset of main's (`same-tests`), or neither side
//   yields test names and the failing step names are equal (`same-step`). A job-name match alone never
//   counts (§4.3, §7 #3246).
// - A PR test list the cap or the 8 MB log cap cut (`testsTruncated`), or a main log the 8 MB cap cut
//   (`logTruncated`), is never a subset proof. `same-step` needs a parsed log on
//   both sides (`logParsed`): with a missing or not-ready log, "no test names" is not evidence.
// - A main run without a same-named job, or whose job did not fail or pass, is `different`.
import { z } from 'zod';
import type { ArtifactStore } from '../core/artifacts.ts';
import type { Clock } from '../core/clock.ts';
import type { Gh } from '../gh/index.ts';
import type { RepoRef } from '../gh/types.ts';
import { CI_CAPS, type SameOnMain } from '../schemas/ci.ts';
import { type JsonCache, repoCache } from './cache.ts';
import { type ActionsJob, type ActionsRun, fetchRun, listRunJobs, listWorkflowRuns } from './github.ts';
import { analyzeJob, type JobAnalysis } from './logs/analyze.ts';

/** How long a "latest main run for this workflow" lookup is reused. */
export const MAIN_RUN_TTL_MS = 5 * 60_000;
/** The per-fetch cap on a main job's log download (02 §11.4: 20 s per log, under the 60 s budget). */
export const MAIN_LOG_FETCH_TIMEOUT_MS = 20_000;

export interface FailingJobFacts {
  /** The job name, as both the rollup and the jobs API show it. */
  name: string;
  /** The PR job's run (to find the workflow when `workflowId` is unknown). */
  runId: number;
  /** The workflow id, when the snapshot already knows it (CiSnapshot.runs). */
  workflowId?: number | null;
  tests: readonly string[];
  step: { number: number; name: string } | null;
  /**
   * The test cap cut `tests`. When omitted, a list of exactly CI_CAPS.tests entries counts as cut (fails
   * closed: it is then never `same-tests`).
   */
  testsTruncated?: boolean;
  /** The job log was fetched and parsed. Omitted counts as false, so `same-step` cannot match. */
  logParsed?: boolean;
}

const logCut = (warnings: readonly { code: string }[] | undefined): boolean =>
  warnings?.some((w) => w.code === 'LOG_TRUNCATED') ?? false;

/**
 * FailingJobFacts from a JobAnalysis, with both evidence flags set right: a list cut by the test cap or by the
 * 8 MB log cap (LOG_TRUNCATED in `warnings`) is `testsTruncated`. Prefer it to building one by hand.
 */
export function failingJobFacts(
  a: Pick<JobAnalysis, 'job' | 'tests' | 'step' | 'logPath' | 'testsTruncated'> & {
    warnings?: JobAnalysis['warnings'] | undefined;
  },
  workflowId?: number | null,
): FailingJobFacts {
  const cut = logCut(a.warnings) || a.testsTruncated === true;
  return {
    name: a.job.name,
    runId: a.job.run_id,
    workflowId: workflowId ?? null,
    tests: a.tests,
    step: a.step,
    ...(cut || a.testsTruncated !== undefined ? { testsTruncated: cut } : {}),
    logParsed: a.logPath !== null,
  };
}

export interface MainSide {
  run: Pick<ActionsRun, 'id' | 'head_sha' | 'created_at' | 'run_started_at'> | null;
  /** The same-named job on that run, if any. */
  job: {
    conclusion: string | null;
    tests: readonly string[];
    step: { number: number; name: string } | null;
    /** The job log was fetched and parsed. Omitted counts as false, so `same-step` cannot match. */
    logParsed?: boolean;
    /** The 8 MB cap cut the log (LOG_TRUNCATED): then it is never `same-tests`. */
    logTruncated?: boolean;
  } | null;
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
  pr: Pick<FailingJobFacts, 'tests' | 'step' | 'testsTruncated' | 'logParsed'>,
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
  const prTruncated = pr.testsTruncated ?? pr.tests.length === CI_CAPS.tests;
  if (pr.tests.length > 0 && newTests.length === 0 && !prTruncated && main.job.logTruncated !== true) {
    return { ...out, verdict: 'same-tests' };
  }
  if (
    pr.logParsed === true &&
    main.job.logParsed === true &&
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
  testsTruncated: z.boolean().optional(),
  logTruncated: z.boolean().optional(),
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
  /**
   * Parsed failing tests and step of a job (disk-cached by job id; logs are immutable). `logParsed` is false
   * when the log was missing or not ready; `testsTruncated` when the test cap cut the list; `logTruncated`
   * when the 8 MB log cap did. Concurrent calls for one job share a single fetch.
   */
  jobTests(job: ActionsJob): Promise<{
    tests: string[];
    step: { number: number; name: string } | null;
    logParsed?: boolean;
    testsTruncated?: boolean;
    logTruncated?: boolean;
  }>;
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

  type JobTests = Awaited<ReturnType<MainComparer['jobTests']>>;
  const parseJob = async (job: ActionsJob): Promise<JobTests> => {
    const c = await cache();
    const key = `tests:job-${job.id}`;
    const hit = c.get(key, CachedTests);
    // Only a parsed log is cached, so a hit is parsed evidence.
    if (hit) {
      return {
        tests: hit.tests,
        step: hit.step,
        logParsed: true,
        testsTruncated: hit.testsTruncated ?? false,
        logTruncated: hit.logTruncated ?? false,
      };
    }
    const a = await analyzeJob({
      gh: o.gh,
      artifacts: o.artifacts,
      repo: o.repo,
      jobId: job.id,
      job,
      timeoutMs: MAIN_LOG_FETCH_TIMEOUT_MS,
      ...(o.logPatterns ? { logPatterns: o.logPatterns } : {}),
    });
    for (const w of a.warnings) o.warn?.({ code: w.code, message: `${o.defaultBranch} comparison: ${w.message}` });
    const testsTruncated = a.testsTruncated ?? false;
    const logTruncated = logCut(a.warnings);
    // Only a parsed log is immutable; a not-ready or expired log is not cached.
    if (a.logPath !== null) c.set(key, { tests: a.tests, step: a.step, testsTruncated, logTruncated }, null);
    return { tests: a.tests, step: a.step, logParsed: a.logPath !== null, testsTruncated, logTruncated };
  };
  // One fetch per job even under concurrent callers (compare and flake): they would race on one .raw file.
  const parsing = new Map<number, Promise<JobTests>>();
  const jobTests = (job: ActionsJob): Promise<JobTests> => {
    let p = parsing.get(job.id);
    if (!p) {
      p = parseJob(job);
      parsing.set(job.id, p);
      // A failed parse may be retried by a later call.
      p.catch(() => parsing.delete(job.id));
    }
    return p;
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
