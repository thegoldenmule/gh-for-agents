// The diagnosis engine (02 §11.4, §12; 03 M3.1): given failing Actions checks, produce FailingJob[]
// for at most `maxJobs` of them within a budget, marking `partial` when the budget runs out. ci why
// calls diagnose() once; ci wait keeps one Diagnoser per head SHA and calls job() as each failure
// lands, then compactDiagnosis()/eventDiagnosis() for its summary and `diagnosis` events.
//
// A job starts as a complete FailingJob built from its check alone; log analysis, then the main
// comparison, then the flake signals overwrite its fields as they land, so a budget overrun
// still returns everything finished. A gh failure in one stage degrades that job (warning
// DIAGNOSIS_INCOMPLETE); control flow (TIMEOUT, INTERRUPTED, aborts) always propagates.
import type { ArtifactStore } from '../core/artifacts.ts';
import type { Clock } from '../core/clock.ts';
import { rethrowControlFlow } from '../core/control-flow.ts';
import type { Gh } from '../gh/index.ts';
import type { RepoRef } from '../gh/types.ts';
import { type Check, CI_CAPS, type CompactDiagnosis, type DiagnosisJob, type FailingJob } from '../schemas/ci.ts';
import type { WorkflowRunInfo } from './checks.ts';
import {
  createMainComparer,
  type FailingJobFacts,
  failingJobFacts,
  type MainComparer,
  notCompared,
} from './compare-main.ts';
import { assessFlake, type KnownFlakyRule, scoreFlake } from './flake.ts';
import { analyzeJob, type JobAnalysis } from './logs/analyze.ts';
import { capLine } from './logs/extract/index.ts';

/** 02 §11.4: at most 5 jobs, all under a 60 s deadline. */
export const DIAGNOSIS_MAX_JOBS = 5;
export const DIAGNOSIS_BUDGET_MS = 60_000;
/** 02 §11.4: each log fetch attempt is capped at 20 s. */
export const DIAGNOSIS_LOG_TIMEOUT_MS = 20_000;

export interface DiagnosisWarning {
  code: string;
  message: string;
}

/** The ci.* config keys the engine reads. */
export interface DiagnosisConfig {
  logPatterns?: readonly string[] | undefined;
  knownFlaky?: readonly KnownFlakyRule[] | undefined;
  infraPatterns?: readonly string[] | undefined;
}

export interface DiagnoserOptions {
  gh: Gh;
  artifacts: ArtifactStore;
  clock: Clock;
  repo: RepoRef;
  headSha: string;
  /** The repo default branch (CiSnapshot.defaultBranch), not the PR base. */
  defaultBranch: string;
  /** Workflow ids by run id (CiSnapshot.runs), so the comparison needs no extra run lookups. */
  runs?: Readonly<Record<string, Pick<WorkflowRunInfo, 'workflowId'>>>;
  config?: DiagnosisConfig;
  /** false: sameOnMain is `not-compared` and main-intermittent is not checked (--no-compare-main). */
  compareMain?: boolean;
  /** Excerpt lines (default 20, cap 60). */
  excerptLines?: number;
  logTimeoutMs?: number;
  warn?: (w: DiagnosisWarning) => void;
  /** Reuse a comparer (its per-workflow memo and disk cache); one is created otherwise. */
  comparer?: MainComparer;
}

export interface DiagnoseOptions {
  maxJobs?: number;
  budgetMs?: number;
  /** Aborting it kills the stages' gh children and rejects with its reason. */
  signal?: AbortSignal;
}

export interface JobOptions {
  /** Default: no budget (the caller bounds it). On expiry: DIAGNOSIS_PARTIAL, and what landed in time. */
  budgetMs?: number;
  /** Aborting it kills the stages' gh children and rejects with its reason. */
  signal?: AbortSignal;
}

export interface Diagnosis {
  /** In diagnosis order: required checks first, then rollup order. */
  jobs: FailingJob[];
  /** Diagnosable checks beyond maxJobs. */
  omitted: number;
  /** The budget ran out before every stage finished. */
  partial: boolean;
}

export interface Diagnoser {
  /** Diagnose up to maxJobs of `checks` within the budget. */
  diagnose(checks: readonly Check[], o?: DiagnoseOptions): Promise<Diagnosis>;
  /**
   * One job, for ci wait's immediate diagnosis. With no budget the caller bounds it. When `budgetMs`
   * expires, the stages' gh children are killed, DIAGNOSIS_PARTIAL is warned, and the job carries what
   * landed in time. A shared `comparer` is never aborted: its in-flight call (capped at 20 s) finishes.
   */
  job(check: Check, o?: JobOptions): Promise<FailingJob>;
  readonly comparer: MainComparer;
}

/** A red Actions check with the ids the jobs API needs. */
export function isDiagnosable(c: Check): c is Check & { jobId: number; runId: number } {
  return (
    c.kind === 'actions' && c.jobId !== null && c.runId !== null && (c.bucket === 'fail' || c.bucket === 'cancelled')
  );
}

/** Required checks first; otherwise the input order is kept. */
export function diagnosisOrder<T extends Pick<Check, 'required'>>(checks: readonly T[]): T[] {
  return [...checks.filter((c) => c.required), ...checks.filter((c) => !c.required)];
}

/** The FailingJob a check yields before any stage has run. */
export function skeletonJob(c: Check & { jobId: number; runId: number }, defaultBranch: string): FailingJob {
  return {
    workflow: c.workflow ?? '',
    job: c.name,
    jobId: c.jobId,
    runId: c.runId,
    attempt: c.attempt ?? 1,
    url: c.url,
    conclusion: c.conclusion ?? (c.bucket === 'cancelled' ? 'cancelled' : 'failure'),
    required: c.required,
    step: null,
    tests: [],
    errors: [],
    exitLine: null,
    excerpt: '',
    logPath: null,
    logBytes: null,
    sameOnMain: notCompared(defaultBranch),
    flake: scoreFlake([]),
  };
}

/**
 * The PR side of the main comparison. A log cut by the 8 MB cap (LOG_TRUNCATED) lost its head, so its
 * test list is incomplete and must never prove `same-tests`, just like a list cut by the test cap.
 */
export function comparisonFacts(
  a: Parameters<typeof failingJobFacts>[0] & Pick<JobAnalysis, 'warnings'>,
  workflowId: number | null,
): FailingJobFacts {
  const facts = failingJobFacts(a, workflowId);
  return a.warnings.some((w) => w.code === 'LOG_TRUNCATED') ? { ...facts, testsTruncated: true } : facts;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createDiagnoser(o: DiagnoserOptions): Diagnoser {
  const compare = o.compareMain !== false;
  const comparer =
    o.comparer ??
    createMainComparer({
      gh: o.gh,
      artifacts: o.artifacts,
      clock: o.clock,
      repo: o.repo,
      defaultBranch: o.defaultBranch,
      prHeadSha: o.headSha,
      ...(o.config?.logPatterns ? { logPatterns: o.config.logPatterns } : {}),
      ...(o.warn ? { warn: o.warn } : {}),
    });
  const warn = (w: DiagnosisWarning): void => o.warn?.(w);
  const incomplete = (job: string, stage: string, e: unknown): void =>
    warn({ code: 'DIAGNOSIS_INCOMPLETE', message: capLine(`${job}: ${stage} failed: ${messageOf(e)}`) });

  /**
   * Runs the stages, writing into `out` as each one lands. Never rejects except for control flow. The
   * stages' own gh calls run under `signal`, so aborting it kills their children (finding: leftover gh
   * children kept the process alive after a budget overrun); comparer calls stop at the next step.
   */
  async function stages(
    c: Check & { jobId: number; runId: number },
    out: FailingJob,
    signal: AbortSignal,
  ): Promise<void> {
    const gh = o.gh.withSignal?.(signal) ?? o.gh;
    let analysis: Awaited<ReturnType<typeof analyzeJob>>;
    try {
      analysis = await analyzeJob({
        gh,
        artifacts: o.artifacts,
        repo: o.repo,
        jobId: c.jobId,
        ...(o.config?.logPatterns ? { logPatterns: o.config.logPatterns } : {}),
        ...(o.excerptLines !== undefined ? { excerptLines: o.excerptLines } : {}),
        timeoutMs: o.logTimeoutMs ?? DIAGNOSIS_LOG_TIMEOUT_MS,
      });
    } catch (e) {
      rethrowControlFlow(e);
      incomplete(c.name, 'log analysis', e);
      return;
    }
    for (const w of analysis.warnings) warn({ code: w.code, message: `${c.name}: ${w.message}` });
    const attempt = analysis.job.run_attempt ?? c.attempt ?? 1;
    Object.assign(out, {
      workflow: c.workflow ?? analysis.job.workflow_name ?? '',
      attempt,
      conclusion: c.conclusion ?? analysis.job.conclusion ?? out.conclusion,
      step: analysis.step,
      tests: analysis.tests,
      errors: analysis.errors,
      exitLine: analysis.exitLine,
      excerpt: analysis.excerpt,
      logPath: analysis.logPath,
      logBytes: analysis.logBytes,
    } satisfies Partial<FailingJob>);
    const workflowId = o.runs?.[String(c.runId)]?.workflowId ?? null;
    // Sequential, not concurrent: both may parse the same main job's log (comparer.jobTests), and the
    // second call must hit the comparer's disk cache rather than race the first on the same log file.
    if (compare) {
      try {
        out.sameOnMain = await comparer.compare(
          { ...comparisonFacts(analysis, workflowId), name: c.name, runId: c.runId },
          { signal },
        );
      } catch (e) {
        rethrowControlFlow(e);
        incomplete(c.name, `${o.defaultBranch} comparison`, e);
      }
    }
    try {
      signal.throwIfAborted();
      out.flake = await assessFlake({
        gh,
        signal,
        repo: o.repo,
        job: { name: c.name, jobId: c.jobId, runId: c.runId, attempt, headSha: o.headSha, workflowId },
        tests: analysis.tests,
        lines: analysis.lines,
        ...(o.config?.knownFlaky ? { knownFlaky: o.config.knownFlaky } : {}),
        ...(o.config?.infraPatterns ? { infraPatterns: o.config.infraPatterns } : {}),
        ...(compare ? { main: { comparer, defaultBranch: o.defaultBranch } } : {}),
      });
    } catch (e) {
      rethrowControlFlow(e);
      incomplete(c.name, 'flake check', e);
    }
  }

  /**
   * Run the stages for `picked` under one controller, racing the budget. On expiry the controller is
   * aborted (killing the stages' gh children) and `partial` is true. A caller abort rejects.
   */
  async function bounded(
    picked: readonly (Check & { jobId: number; runId: number })[],
    budgetMs: number | undefined,
    caller: AbortSignal | undefined,
  ): Promise<{ outs: FailingJob[]; partial: boolean }> {
    caller?.throwIfAborted();
    const ctrl = new AbortController();
    let forward = (): void => {};
    const callerAbort = new Promise<never>((_, reject) => {
      forward = () => {
        ctrl.abort(caller?.reason);
        reject(caller?.reason);
      };
    });
    callerAbort.catch(() => {});
    caller?.addEventListener('abort', forward, { once: true });
    const outs = picked.map((c) => skeletonJob(c, o.defaultBranch));
    const work = Promise.all(picked.map((c, i) => stages(c, outs[i] as FailingJob, ctrl.signal)));
    const timer = new AbortController();
    const budget =
      budgetMs === undefined
        ? new Promise<never>(() => {})
        : o.clock.sleep(Math.max(0, budgetMs), timer.signal).then(
            () => 'expired' as const,
            () => 'cancelled' as const,
          );
    let partial = false;
    try {
      const first = await Promise.race([work.then(() => 'done' as const), budget, callerAbort]);
      if (first === 'expired') {
        partial = true;
        // Kill what is still running; its rejection is the abort we just caused, so it is dropped.
        work.catch(() => {});
        ctrl.abort(new DOMException('The diagnosis budget ran out.', 'AbortError'));
        warn({
          code: 'DIAGNOSIS_PARTIAL',
          message: `The diagnosis budget (${Math.round((budgetMs ?? 0) / 1000)} s) ran out; unfinished jobs carry only what was read in time.`,
        });
      }
    } finally {
      timer.abort();
      caller?.removeEventListener('abort', forward);
    }
    // Copies, so stages finishing after an overrun cannot change what the caller already returned.
    return { outs: outs.map((j) => structuredClone(j)), partial };
  }

  return {
    comparer,
    async job(c, jo = {}) {
      if (!isDiagnosable(c)) throw new Error(`diagnose: ${c.name} is not a red Actions check with a job id`);
      const { outs } = await bounded([c], jo.budgetMs, jo.signal);
      return outs[0] as FailingJob;
    },
    async diagnose(checks, d = {}) {
      const all = diagnosisOrder(checks.filter(isDiagnosable));
      const picked = all.slice(0, d.maxJobs ?? DIAGNOSIS_MAX_JOBS);
      const { outs, partial } = await bounded(picked, d.budgetMs ?? DIAGNOSIS_BUDGET_MS, d.signal);
      return { jobs: outs, omitted: all.length - picked.length, partial };
    },
  };
}

/** Lines and chars of an excerpt, from the top (where the failure is). */
export function clipExcerpt(text: string, maxLines: number, maxChars: number): string {
  const out: string[] = [];
  let chars = 0;
  for (const line of text === '' ? [] : text.split('\n').slice(0, maxLines)) {
    const add = line.length + (out.length > 0 ? 1 : 0);
    if (chars + add > maxChars) break;
    out.push(line);
    chars += add;
  }
  return out.join('\n');
}

/** A FailingJob cut to the `diagnosis` event caps (02 §11.4: ≤10 tests, ≤5 errors, ≤10 lines or 1,500 chars). */
export function eventDiagnosis(j: FailingJob): DiagnosisJob {
  return {
    ...j,
    tests: j.tests.slice(0, CI_CAPS.eventTests),
    errors: j.errors.slice(0, CI_CAPS.eventErrors),
    excerpt: clipExcerpt(j.excerpt, CI_CAPS.eventExcerptLines, CI_CAPS.eventExcerptChars),
  };
}

/** The ci wait summary's per-job form (02 §11.9). The first error falls back to the exit line. */
export function compactDiagnosis(j: FailingJob): CompactDiagnosis {
  return {
    job: j.job,
    workflow: j.workflow,
    jobId: j.jobId,
    step: j.step?.name ?? null,
    tests: j.tests.slice(0, CI_CAPS.compactTests),
    firstError: j.errors[0] ?? j.exitLine ?? null,
    logPath: j.logPath,
    sameOnMain: j.sameOnMain.verdict,
    flake: j.flake.score,
  };
}
