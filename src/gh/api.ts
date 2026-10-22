// REST via `gh api --include` (01 §4.3/§4.4 amended by 03 §2 M1.7): status line and header parsing,
// manual Link pagination with a hard bound, conditional requests (304), and log/diff bodies.
import { closeSync, createReadStream, createWriteStream, openSync, readSync, renameSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { GhxError } from '../core/errors.ts';
import type { RepoRef } from './types.ts';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface ApiRequest {
  /** e.g. 'repos/{owner}/{repo}/actions/jobs/123/logs'; placeholders are filled from `repo`. */
  path: string;
  /** Supplies {owner}/{repo} and --hostname. */
  repo?: RepoRef;
  /** Default GET; always passed as -X. */
  method?: HttpMethod;
  /** For GET these become query parameters; otherwise -F/-f fields. */
  fields?: Record<string, string | number | boolean>;
  /** Sent as JSON on stdin via --input -. Writes only. */
  body?: unknown;
  /** e.g. If-None-Match for conditional polling. */
  headers?: Record<string, string>;
  /** Manual Link-header pagination, bounded. */
  paginate?: { maxPages: number; perPage?: number; itemsKey?: string };
  /** Stream the raw body to this file (logs). */
  toFile?: string;
}

export interface ParsedResponse {
  statusLine: string | null;
  status: number | null;
  /** Lower-cased names; the last of duplicate headers wins (03 §3.4). */
  headers: Record<string, string>;
  body: string;
}

export type ApiResponse<T> =
  | {
      status: number;
      headers: Record<string, string>;
      data: T;
      pages: number;
      /** Hit maxPages with a next link remaining. */
      truncated: boolean;
      etag?: string;
      notModified: false;
    }
  | {
      status: 304;
      headers: Record<string, string>;
      data: undefined;
      pages: number;
      truncated: false;
      etag?: string;
      notModified: true;
    };

const STATUS_LINE = /^HTTP\/[\d.]+ (\d{3})(?: .*)?$/;

/** Split `gh api --include` stdout into status, headers and body. Accepts HTTP/1.1 and HTTP/2.0, CRLF or LF. */
export function parseIncludeOutput(stdout: string): ParsedResponse {
  let text = stdout;
  for (;;) {
    const lines = text.split(/\r?\n/);
    const first = lines[0] ?? '';
    const m = STATUS_LINE.exec(first);
    if (!m) return { statusLine: null, status: null, headers: {}, body: text };
    const headers: Record<string, string> = {};
    let i = 1;
    for (; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (line === '') break;
      const c = line.indexOf(':');
      if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
    }
    // Re-join the rest with the original separators: find the blank line's byte offset.
    const sep = /\r?\n\r?\n/.exec(text);
    const body = sep ? text.slice(sep.index + sep[0].length) : '';
    // An intermediate response (e.g. a redirect shown by some gh versions) is followed by another block.
    if (STATUS_LINE.test(body.split(/\r?\n/, 1)[0] ?? '') && Number(m[1]) >= 300 && Number(m[1]) < 400) {
      text = body;
      continue;
    }
    return { statusLine: first, status: Number(m[1]), headers, body };
  }
}

export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** The rel="next" URL of a Link header. */
export function nextLink(link: string | undefined): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (m) return m[1];
  }
  return undefined;
}

export function fillPath(path: string, repo: RepoRef | undefined): string {
  if (!/\{owner\}|\{repo\}/.test(path)) return path;
  if (!repo) throw new GhxError('INTERNAL', `api path ${path} has placeholders but no repo was given.`);
  return path.replaceAll('{owner}', encodeURIComponent(repo.owner)).replaceAll('{repo}', encodeURIComponent(repo.name));
}

function withQuery(path: string, q: Record<string, string | number | boolean>): string {
  const entries = Object.entries(q);
  if (entries.length === 0) return path;
  const qs = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
  return `${path}${path.includes('?') ? '&' : '?'}${qs}`;
}

/** argv for one `gh api` call (without the leading 'gh'), plus its stdin. */
export function buildApiArgs(req: ApiRequest, endpoint?: string): { args: string[]; stdin?: string } {
  const method = req.method ?? 'GET';
  const args = ['api', '--include', '-X', method];
  // Always explicit: an inherited GH_HOST must never redirect a github.com target (gh honours GH_HOST
  // over its default host). Repo-less calls (rate_limit) keep gh's own host resolution, i.e. GH_HOST.
  if (req.repo) args.push('--hostname', req.repo.host);
  for (const [k, v] of Object.entries(req.headers ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    args.push('-H', `${k}: ${v}`);
  }
  let path = endpoint ?? fillPath(req.path, req.repo);
  if (endpoint === undefined && req.paginate) path = withQuery(path, { per_page: req.paginate.perPage ?? 100 });
  if (method === 'GET') {
    if (endpoint === undefined) path = withQuery(path, req.fields ?? {});
  } else {
    for (const [k, v] of Object.entries(req.fields ?? {})) {
      args.push(typeof v === 'string' ? '-f' : '-F', `${k}=${String(v)}`);
    }
  }
  args.push(path);
  if (req.body !== undefined) {
    if (method === 'GET') throw new GhxError('INTERNAL', 'a GET api request cannot carry a body.');
    args.push('--input', '-');
    return { args, stdin: JSON.stringify(req.body) };
  }
  return { args };
}

/** Concatenate paginated payloads: arrays directly, objects by `itemsKey` (or their first array field). */
export function mergePages(pages: unknown[], itemsKey?: string): unknown {
  if (pages.length <= 1) return pages[0];
  if (pages.every(Array.isArray)) return (pages as unknown[][]).flat();
  const first = pages[0] as Record<string, unknown>;
  const key = itemsKey ?? Object.keys(first).find((k) => Array.isArray(first[k]));
  if (!key) return first;
  return { ...first, [key]: pages.flatMap((p) => ((p as Record<string, unknown>)[key] as unknown[]) ?? []) };
}

/**
 * gh writes `--include` headers into the stdoutFile too. Parse them off the front of `file`, strip a
 * leading BOM from the body, and rewrite the file to hold only the body.
 */
export async function splitHeadersFromFile(file: string): Promise<ParsedResponse> {
  const size = statSync(file).size;
  const fd = openSync(file, 'r');
  const head = Buffer.alloc(Math.min(size, 65_536));
  try {
    readSync(fd, head, 0, head.length, 0);
  } finally {
    closeSync(fd);
  }
  const text = head.toString('latin1');
  const parsed = parseIncludeOutput(text);
  if (parsed.status === null) return { ...parsed, body: '' };
  let offset = text.length - parsed.body.length;
  if (head[offset] === 0xef && head[offset + 1] === 0xbb && head[offset + 2] === 0xbf) offset += 3;
  const tmp = `${file}.body`;
  await pipeline(createReadStream(file, { start: offset }), createWriteStream(tmp));
  renameSync(tmp, file);
  return { ...parsed, body: '' };
}
