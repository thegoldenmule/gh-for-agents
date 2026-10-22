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
//
// A raw log over LOG_CAP_BYTES (8 MB, 02 §11.4/§12) keeps only its tail, because failures are at the
// end; the result then carries the warning LOG_TRUNCATED.
import { rmSync, statSync } from 'node:fs';
import type { ArtifactStore } from '../../core/artifacts.ts';
import { type Gh, GhFailure } from '../../gh/index.ts';
import type { RepoRef } from '../../gh/types.ts';
import { createSegmenter, type LogSegment } from './steps.ts';
import { stripLogFile } from './strip.ts';

/** The per-log cap (02 §11.4): past it only the last 8 MB of the raw log are kept. */
export const LOG_CAP_BYTES = 8 * 1024 * 1024;

export interface JobLog {
  jobId: number;
  /** The cleaned log (no BOM, timestamps or ANSI). */
  path: string;
  bytes: number;
  lines: number;
  segments: LogSegment[];
  /** Raw bytes dropped from the head of the log by the cap (0 when the whole log was kept). */
  omittedBytes: number;
  /** LOG_TRUNCATED when the cap applied. */
  warning: LogWarning | null;
}

export interface LogWarning {
  code: 'LOGS_NOT_READY' | 'LOGS_UNAVAILABLE' | 'LOG_TRUNCATED';
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
  /** The per-log cap; default LOG_CAP_BYTES. */
  maxBytes?: number;
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
    const cap = o.maxBytes ?? LOG_CAP_BYTES;
    const size = statSync(raw).size;
    const start = size > cap ? size - cap : 0;
    const r = await stripLogFile(raw, path, (text, i, ts) => seg.push(text, i, ts), { start });
    const warning: LogWarning | null =
      start > 0
        ? {
            code: 'LOG_TRUNCATED',
            message: `The log for job ${o.jobId} is ${mb(size)}; only its last ${mb(cap)} were kept (failures are at the end).`,
          }
        : null;
    return {
      ok: true,
      log: {
        jobId: o.jobId,
        path,
        bytes: r.bytes,
        lines: r.lines,
        segments: seg.finish(),
        omittedBytes: start,
        warning,
      },
    };
  } finally {
    rmSync(raw, { force: true });
  }
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
