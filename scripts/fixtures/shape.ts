// Shape comparison for the drift check (03 §6.1): key sets, JSON types, status lines, and stderr with
// numbers masked. Values (ids, timestamps, counts) are allowed to differ.

export type Shape = string | Shape[] | { [k: string]: Shape };

/** Header names whose presence varies run to run and carries no contract. */
const VOLATILE_HEADERS = new Set([
  'date',
  'etag',
  'last-modified',
  'x-github-request-id',
  'x-ms-request-id',
  'content-length',
  'age',
  'expires',
  'x-ratelimit-used',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'ratelimit-remaining',
  'ratelimit-reset',
  'set-cookie',
  'vary',
  'server-timing',
  'cache-control',
  'link',
  'content-md5',
  'x-ms-version',
  'x-ms-creation-time',
  'x-ms-lease-status',
  'x-ms-lease-state',
  'x-ms-blob-type',
  'x-ms-server-encrypted',
  'accept-ranges',
  'access-control-allow-origin',
]);

export function jsonShape(v: unknown): Shape {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    const seen = new Map<string, Shape>();
    for (const x of v) {
      const s = jsonShape(x);
      seen.set(JSON.stringify(s), s);
    }
    return [...seen.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, jsonShape((v as Record<string, unknown>)[k])]),
    );
  }
  return typeof v;
}

function splitInclude(stdout: string): { status: string | null; headers: string[]; body: string } {
  const m = /^(HTTP\/[\d.]+ \d{3})[^\r\n]*\r?\n((?:[^\r\n]+\r?\n)*)\r?\n([\s\S]*)$/.exec(stdout);
  if (!m) return { status: null, headers: [], body: stdout };
  const headers = (m[2] ?? '')
    .split(/\r?\n/)
    .map((l) => l.slice(0, l.indexOf(':')).trim().toLowerCase())
    .filter((h) => h && !VOLATILE_HEADERS.has(h));
  return {
    status: (m[1] ?? '').replace(/^HTTP\/[\d.]+ /, 'HTTP '),
    headers: [...new Set(headers)].sort(),
    body: m[3] ?? '',
  };
}

export interface FixtureShape {
  exitCode: number;
  status: string | null;
  headers: string[];
  body: Shape;
  stderr: string;
}

export function fixtureShape(f: { exitCode: number; stdout: string; stderr: string }): FixtureShape {
  const { status, headers, body } = splitInclude(f.stdout);
  let shape: Shape;
  try {
    shape = jsonShape(JSON.parse(body.replace(/^﻿/, '')));
  } catch {
    shape = body === '' ? 'empty' : 'text';
  }
  return {
    exitCode: f.exitCode,
    status,
    headers,
    body: shape,
    stderr: f.stderr.replace(/\d+/g, 'N').replace(/`[^`]*`/g, '`…`'),
  };
}

/** Human-readable differences between two fixture shapes; empty when they agree. */
export function diffShapes(name: string, committed: FixtureShape, fresh: FixtureShape): string[] {
  const out: string[] = [];
  const cmp = (what: string, a: unknown, b: unknown) => {
    const sa = JSON.stringify(a);
    const sb = JSON.stringify(b);
    if (sa !== sb) out.push(`${name}: ${what} changed\n  committed: ${sa}\n  fresh:     ${sb}`);
  };
  cmp('exit code', committed.exitCode, fresh.exitCode);
  cmp('status line', committed.status, fresh.status);
  cmp('headers', committed.headers, fresh.headers);
  cmp('body shape', committed.body, fresh.body);
  cmp('stderr', committed.stderr, fresh.stderr);
  return out;
}
