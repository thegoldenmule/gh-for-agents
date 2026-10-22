// Job-log fetch (02 §12 steps 1, 2 and 5; 03 M2.3, spike §3.3). Logs come only from the jobs API,
// which serves a finished job's log even while its run is still in progress; `gh run view --log` is
// never called. The raw body streams to a file, is cleaned line by line (strip.ts) into
// <root>/<host>/<owner>/<repo>/logs/job-<jobId>.log, and is segmented by step on the way.
//
// Outcomes:
// - 200: the cleaned log path, size and step segments.
// - Azure blob 404 (job running or skipped): warning LOGS_NOT_READY; not an error.
// - 410 (past retention): warning LOGS_UNAVAILABLE; not an error and never retried.
// - GitHub JSON 404 (no such job): RUN_NOT_FOUND is thrown.
import { rmSync } from 'node:fs';
import type { ArtifactStore } from '../../core/artifacts.ts';
import { type Gh, GhFailure } from '../../gh/index.ts';
import type { RepoRef } from '../../gh/types.ts';
import { createSegmenter, type LogSegment } from './steps.ts';
import { stripLogFile } from './strip.ts';

export interface JobLog {
  jobId: number;
  /** The cleaned log (no BOM, timestamps or ANSI). */
  path: string;
  bytes: number;
  lines: number;
  segments: LogSegment[];
}

export interface LogWarning {
  code: 'LOGS_NOT_READY' | 'LOGS_UNAVAILABLE';
  message: string;
}

export type JobLogResult = { ok: true; log: JobLog } | { ok: false; warning: LogWarning };

export interface FetchJobLogOptions {
  gh: Gh;
  artifacts: ArtifactStore;
  repo: RepoRef;
  jobId: number;
  /** Per-attempt gh timeout (ci wait's diagnosis budget passes 20 s). */
  timeoutMs?: number;
}

export function jobLogsPath(jobId: number): string {
  return `repos/{owner}/{repo}/actions/jobs/${jobId}/logs`;
}

export async function fetchJobLog(o: FetchJobLogOptions): Promise<JobLogResult> {
  const raw = await o.artifacts.pathFor('logs', `job-${o.jobId}.raw`, o.repo);
  const path = await o.artifacts.pathFor('logs', `job-${o.jobId}.log`, o.repo);
  try {
    await o.gh.apiText(
      { path: jobLogsPath(o.jobId), repo: o.repo, toFile: raw },
      { notFound: 'RUN_NOT_FOUND', ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}) },
    );
  } catch (e) {
    rmSync(raw, { force: true });
    if (e instanceof GhFailure && e.failure.code === 'GH_LOGS_NOT_READY') {
      return {
        ok: false,
        warning: {
          code: 'LOGS_NOT_READY',
          message: `The log for job ${o.jobId} is not available yet (the job is still running or was skipped).`,
        },
      };
    }
    if (e instanceof GhFailure && e.failure.code === 'GH_LOGS_GONE') {
      return {
        ok: false,
        warning: {
          code: 'LOGS_UNAVAILABLE',
          message: `The log for job ${o.jobId} has expired (past the repository's log retention).`,
        },
      };
    }
    throw e;
  }
  const seg = createSegmenter();
  try {
    const r = await stripLogFile(raw, path, (text, i, ts) => seg.push(text, i, ts));
    return { ok: true, log: { jobId: o.jobId, path, bytes: r.bytes, lines: r.lines, segments: seg.finish() } };
  } finally {
    rmSync(raw, { force: true });
  }
}
