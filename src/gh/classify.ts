// (exitCode, stderr, stdout) → internal GhFailure code. Table-driven and ordered (01 §4.3 amended by
// 03 §2 M1.6 from the spike results in 03 §3). First matching row wins.
//
// HTTP 304 is not a failure and never reaches this table: api.ts treats `exit 1 ∧ status 304 ∧
// If-None-Match sent` as notModified before classifying (03 §3.1).
import type { GhFailureCode } from '../core/errors.ts';

export interface ClassifyInput {
  exitCode: number | null;
  stderr: string;
  stdout: string;
  timedOut?: boolean;
  spawnErrorCode?: string | undefined;
  /** Lower-cased response headers when known (api()). */
  headers?: Record<string, string>;
  /** HTTP status when known (api()). */
  status?: number | undefined;
  /** Epoch ms, for x-ratelimit-reset. */
  now?: number;
}

export interface GhFailureInfo {
  code: GhFailureCode;
  transient: boolean;
  retryAfterMs?: number;
  status?: number;
}

interface Row {
  code: GhFailureCode;
  transient: boolean;
  match: (r: ClassifyInput, status: number | undefined) => boolean;
}

const has = (re: RegExp) => (r: ClassifyInput) => re.test(r.stderr);

/** Status from the input, else from gh's stderr forms "HTTP 404" / "(HTTP 410)". */
export function statusOf(r: ClassifyInput): number | undefined {
  if (r.status !== undefined) return r.status;
  const m = /\bHTTP (\d{3})\b/.exec(r.stderr);
  return m ? Number(m[1]) : undefined;
}

function graphqlErrorTypes(stdout: string): string[] {
  const start = stdout.indexOf('{');
  if (start === -1) return [];
  try {
    const j = JSON.parse(stdout.slice(start)) as { errors?: { type?: unknown }[] };
    return (j.errors ?? []).map((e) => String(e.type ?? ''));
  } catch {
    return [];
  }
}

const RATE_LIMIT = /rate limit/i;

export const CLASSIFIER_ROWS: readonly Row[] = [
  { code: 'GH_NOT_INSTALLED', transient: false, match: (r) => r.spawnErrorCode === 'ENOENT' },
  { code: 'GH_TIMEOUT', transient: true, match: (r) => r.timedOut === true },
  // 03 §3.3: a running or skipped job's log is an Azure blob 404.
  {
    code: 'GH_LOGS_NOT_READY',
    transient: false,
    match: (r, s) =>
      s === 404 && (/BlobNotFound|specified blob does not exist/.test(r.stdout) || /blob/i.test(r.stderr)),
  },
  // 03 §3.3: expired logs are 410 "Server Error (HTTP 410)"; must precede the transient Server Error row.
  { code: 'GH_LOGS_GONE', transient: false, match: (_r, s) => s === 410 },
  // 03 §3.4: GraphQL partial errors (200, exit 1) with errors[].type NOT_FOUND.
  { code: 'GH_NOT_FOUND', transient: false, match: (r) => graphqlErrorTypes(r.stdout).includes('NOT_FOUND') },
  {
    code: 'GH_RATE_LIMITED',
    transient: true,
    match: (r, s) =>
      (s === 403 || s === 429 || /^GraphQL:/m.test(r.stderr) || s === undefined) &&
      (RATE_LIMIT.test(r.stderr) || graphqlErrorTypes(r.stdout).includes('RATE_LIMITED')),
  },
  {
    code: 'GH_AUTH',
    transient: false,
    match: (r, s) => s === 401 || /gh auth login|not logged in|authentication required|Bad credentials/i.test(r.stderr),
  },
  {
    code: 'GH_TOO_LARGE',
    transient: false,
    match: (r, s) => s === 406 || /exceeded the maximum number of files/.test(r.stderr),
  },
  { code: 'GH_IN_PROGRESS', transient: false, match: has(/is still in progress; logs will be available/) },
  { code: 'GH_NO_CHECKS', transient: false, match: has(/no checks reported/) },
  {
    code: 'GH_ALREADY',
    transient: false,
    match: has(/already merged|already running|cannot be rerun/),
  },
  {
    code: 'GH_NOT_A_REPO',
    transient: false,
    match: has(/not a git repository|failed to determine base repo|no git remotes found/),
  },
  {
    code: 'GH_NOT_FOUND',
    transient: false,
    match: (r, s) => s === 404 || /Could not resolve to a/.test(r.stderr),
  },
  { code: 'GH_FORBIDDEN', transient: false, match: (_r, s) => s === 403 },
  {
    code: 'GH_TRANSIENT',
    transient: true,
    match: (r, s) =>
      (s !== undefined && s >= 500 && s <= 599) ||
      /Something went wrong while executing your query|connection reset|i\/o timeout|TLS handshake timeout|: EOF\s*$|unexpected EOF/im.test(
        r.stderr,
      ),
  },
];

function retryAfterMs(r: ClassifyInput): number | undefined {
  const h = r.headers ?? {};
  const ra = h['retry-after'];
  if (ra !== undefined && /^\d+$/.test(ra)) return Number(ra) * 1_000;
  const reset = h['x-ratelimit-reset'];
  if (reset !== undefined && /^\d+$/.test(reset) && r.now !== undefined) {
    return Math.max(0, Number(reset) * 1_000 - r.now);
  }
  return undefined;
}

export function classify(r: ClassifyInput): GhFailureInfo {
  const status = statusOf(r);
  const row = CLASSIFIER_ROWS.find((x) => x.match(r, status));
  const info: GhFailureInfo = row
    ? { code: row.code, transient: row.transient }
    : { code: 'GH_FAILED', transient: false };
  if (status !== undefined) info.status = status;
  if (info.code === 'GH_RATE_LIMITED') {
    const ms = retryAfterMs(r);
    if (ms !== undefined) info.retryAfterMs = ms;
  }
  return info;
}
