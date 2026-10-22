// One failed job, diagnosed (02 §12 steps 1–5): jobs-API row → log fetch and clean → step
// attribution → extraction over the failing step's lines → excerpt. ci why builds FailingJob from
// this; compare-main and flake use its test lists. Expired or not-ready logs degrade to warnings with
// `logPath: null`; the step still comes from the API.
import { readFileSync } from 'node:fs';
import type { ArtifactStore } from '../../core/artifacts.ts';
import type { Gh } from '../../gh/index.ts';
import type { RepoRef } from '../../gh/types.ts';
import { type ActionsJob, failingStep, fetchJob } from '../github.ts';
import { excerpt, extractFailures } from './extract/index.ts';
import { fetchJobLog, type LogWarning } from './fetch.ts';
import { attributeSteps, spansFor } from './steps.ts';

export interface JobAnalysis {
  job: ActionsJob;
  /** From the jobs API, never "UNKNOWN STEP". */
  step: { number: number; name: string } | null;
  tests: string[];
  errors: string[];
  exitLine: string | null;
  excerpt: string;
  runners: string[];
  logPath: string | null;
  logBytes: number | null;
  /** The cleaned lines the extractors read (the failing step, or the whole log). Not for output. */
  lines: string[];
  warnings: LogWarning[];
}

export interface AnalyzeJobOptions {
  gh: Gh;
  artifacts: ArtifactStore;
  repo: RepoRef;
  jobId: number;
  /** The jobs-API row, when the caller already has it. */
  job?: ActionsJob;
  logPatterns?: readonly string[];
  excerptLines?: number;
  timeoutMs?: number;
}

export async function analyzeJob(o: AnalyzeJobOptions): Promise<JobAnalysis> {
  const job = o.job ?? (await fetchJob({ gh: o.gh, repo: o.repo, jobId: o.jobId }));
  const steps = job.steps ?? [];
  const step = failingStep(steps);
  const fetched = await fetchJobLog({
    gh: o.gh,
    artifacts: o.artifacts,
    repo: o.repo,
    jobId: o.jobId,
    ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
  });
  if (!fetched.ok) {
    return {
      job,
      step,
      tests: [],
      errors: [],
      exitLine: null,
      excerpt: '',
      runners: [],
      logPath: null,
      logBytes: null,
      lines: [],
      warnings: [fetched.warning],
    };
  }
  const all = readFileSync(fetched.log.path, 'utf8').split('\n');
  if (all.at(-1) === '') all.pop();
  const own = step ? spansFor(attributeSteps(fetched.log.segments, steps, step), step.number) : [];
  const lines = own.length > 0 ? own.flatMap((s) => all.slice(s.startLine, s.endLine + 1)) : all;
  const f = extractFailures(lines, { ...(o.logPatterns ? { logPatterns: o.logPatterns } : {}) });
  return {
    job,
    step,
    tests: f.tests,
    errors: f.errors,
    exitLine: f.exitLine,
    excerpt: excerpt(lines, f.firstLine, { ...(o.excerptLines !== undefined ? { maxLines: o.excerptLines } : {}) }),
    runners: f.runners,
    logPath: fetched.log.path,
    logBytes: fetched.log.bytes,
    lines,
    warnings: fetched.log.warning ? [fetched.log.warning] : [],
  };
}
