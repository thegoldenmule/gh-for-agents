#!/usr/bin/env node
// Read-only gh spike probes (03 §3.1–§3.5). Re-run after any gh upgrade:
//
//   node scripts/spike-gh.ts            # all probes
//   node scripts/spike-gh.ts etag logs  # only the named groups
//
// Prints one JSON object: {ghVersion, ranAt, probes: {<id>: {...}}, assumptions: {<id>: boolean}}.
// Every call is a GET against a public repo. Exit code is 0 when every assumption still holds, 1
// otherwise, so the (deferred) live workflow can gate on it. Zero dependencies on purpose: this file
// predates package.json and must stay runnable with a bare `node`.
import { spawnSync } from 'node:child_process';

interface Raw {
  argv: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface Parsed {
  statusLine: string | null;
  status: number | null;
  headers: Record<string, string>;
  duplicateHeaders: string[];
  body: string;
}

const HEADERS_OF_INTEREST = [
  'etag',
  'x-ratelimit-used',
  'x-ratelimit-remaining',
  'x-ratelimit-resource',
  'ratelimit-remaining',
  'server',
  'content-type',
  'location',
];

function gh(args: string[]): Raw {
  const env = { ...process.env, GH_PAGER: '', NO_COLOR: '1', GH_PROMPT_DISABLED: '1' };
  const r = spawnSync('gh', args, { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  return { argv: args, exitCode: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function parseInclude(stdout: string): Parsed {
  const text = stdout.replace(/^﻿/, '');
  const sep = text.search(/\r?\n\r?\n/);
  const head = sep === -1 ? text : text.slice(0, sep);
  const body = sep === -1 ? '' : text.slice(sep).replace(/^\r?\n\r?\n/, '');
  const lines = head.split(/\r?\n/);
  const statusLine = lines[0]?.startsWith('HTTP/') ? (lines[0] ?? null) : null;
  const status = statusLine ? Number(statusLine.split(' ')[1]) : null;
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  const duplicateHeaders: string[] = [];
  for (const line of statusLine ? lines.slice(1) : []) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    if (seen.has(k) && !duplicateHeaders.includes(k)) duplicateHeaders.push(k);
    seen.add(k);
    headers[k] = line.slice(i + 1).trim();
  }
  return { statusLine, status, headers, duplicateHeaders, body };
}

function pick(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of HEADERS_OF_INTEREST) if (h[k] !== undefined) out[k] = h[k];
  return out;
}

function summary(r: Raw, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const p = parseInclude(r.stdout);
  return {
    argv: ['gh', ...r.argv],
    exitCode: r.exitCode,
    statusLine: p.statusLine,
    stderr: r.stderr.trim().slice(0, 500),
    headers: pick(p.headers),
    bodyBytes: Buffer.byteLength(p.body),
    bodyStartsWithBom: r.stdout.includes('\r\n\r\n﻿') || r.stdout.includes('\n\n﻿'),
    ...extra,
  };
}

type Probe = () => { result: Record<string, unknown>; assumptions: Record<string, boolean> };

const probes: Record<string, Probe> = {
  // §3.1: a conditional GET returns 304, exit 1, headers on stdout, and does not count.
  etag() {
    const first = gh(['api', '-i', 'repos/cli/cli']);
    const p1 = parseInclude(first.stdout);
    const etag = p1.headers.etag ?? '';
    const second = gh(['api', '-i', '-H', `If-None-Match: ${etag}`, 'repos/cli/cli']);
    const third = gh(['api', '-i', '-H', `If-None-Match: ${etag}`, 'repos/cli/cli']);
    const p2 = parseInclude(second.stdout);
    const p3 = parseInclude(third.stdout);
    return {
      result: { first: summary(first), conditional: summary(second), conditionalAgain: summary(third) },
      assumptions: {
        'etag.304-status': p2.status === 304,
        'etag.304-exit-1': second.exitCode === 1,
        'etag.304-stderr': /HTTP 304/.test(second.stderr),
        'etag.304-free': p2.headers['x-ratelimit-used'] === p3.headers['x-ratelimit-used'],
      },
    };
  },
  // §3.2: rules and branch summary readable without admin; …/protection is 404 (not 403).
  rules() {
    const rules = gh(['api', '-i', 'repos/cli/cli/rules/branches/trunk']);
    const branch = gh(['api', '-i', 'repos/cli/cli/branches/trunk']);
    const protection = gh(['api', '-i', 'repos/cli/cli/branches/trunk/protection']);
    const pb = parseInclude(branch.stdout);
    let contexts: unknown = null;
    try {
      contexts = JSON.parse(pb.body)?.protection?.required_status_checks?.contexts ?? null;
    } catch {
      contexts = null;
    }
    return {
      result: {
        rules: summary(rules),
        branch: summary(branch, { requiredContexts: contexts }),
        protection: summary(protection),
      },
      assumptions: {
        'rules.readable': parseInclude(rules.stdout).status === 200,
        'branch.readable': pb.status === 200,
        'protection.404': parseInclude(protection.stdout).status === 404,
      },
    };
  },
  // §3.3: job logs follow the redirect to Azure Blob; running job = blob 404; expired = 410.
  logs() {
    const cases: Record<string, string> = {
      completedFailed: 'repos/cli/cli/actions/jobs/119137909038/logs',
      finishedInRunningRun: 'repos/vercel/next.js/actions/jobs/119889011890/logs',
      stillRunning: 'repos/nodejs/node/actions/jobs/119888519187/logs',
      expired: 'repos/cli/cli/actions/jobs/73871539329/logs',
    };
    const result: Record<string, unknown> = {};
    const assumptions: Record<string, boolean> = {};
    for (const [k, path] of Object.entries(cases)) {
      const r = gh(['api', '-i', path]);
      const p = parseInclude(r.stdout);
      result[k] = summary(r, { blobNotFound: /BlobNotFound/.test(p.body) });
      if (k === 'completedFailed' && p.status === 200) {
        assumptions['logs.redirect-followed'] = /Windows-Azure-Blob/i.test(p.headers.server ?? '');
        assumptions['logs.no-ratelimit-headers'] = p.headers['x-ratelimit-used'] === undefined;
      }
      if (k === 'expired') {
        assumptions['logs.410-server-error'] = p.status === 410 && /Server Error \(HTTP 410\)/.test(r.stderr);
      }
    }
    return { result, assumptions };
  },
  // §3.4: GraphQL partial errors come back as 200 with exit 1, data + errors[type=NOT_FOUND].
  graphql() {
    const q =
      '{repository(owner:"cli",name:"cli"){pullRequest(number:99999999){number}} rateLimit{remaining cost}}';
    const r = gh(['api', '-i', 'graphql', '-f', `query=${q}`]);
    const p = parseInclude(r.stdout);
    let errorTypes: string[] = [];
    let hasData = false;
    try {
      const j = JSON.parse(p.body) as { data?: unknown; errors?: { type?: string }[] };
      hasData = j.data !== undefined && j.data !== null;
      errorTypes = (j.errors ?? []).map((e) => String(e.type));
    } catch {
      // body not JSON: assumptions below fail
    }
    return {
      result: summary(r, { errorTypes, hasData, duplicateHeaders: p.duplicateHeaders }),
      assumptions: {
        'graphql.partial-200': p.status === 200,
        'graphql.partial-exit-1': r.exitCode === 1,
        'graphql.partial-not-found': errorTypes.includes('NOT_FOUND') && hasData,
      },
    };
  },
  // §3.5: a queued job has runner_id null and started_at == created_at.
  jobs() {
    const runs = gh(['api', 'repos/vercel/next.js/actions/runs?status=queued&per_page=5']);
    let runId: number | null = null;
    try {
      runId = (JSON.parse(runs.stdout) as { workflow_runs?: { id: number }[] }).workflow_runs?.[0]?.id ?? null;
    } catch {
      runId = null;
    }
    if (runId === null) {
      return { result: { note: 'no queued run found on vercel/next.js right now', exitCode: runs.exitCode }, assumptions: {} };
    }
    const jobs = gh(['api', `repos/vercel/next.js/actions/runs/${runId}/jobs?per_page=100`]);
    type Job = { status: string; created_at: string; started_at: string | null; runner_id: number | null; runner_name: string | null };
    let queued: Job[] = [];
    try {
      queued = ((JSON.parse(jobs.stdout) as { jobs?: Job[] }).jobs ?? []).filter((j) => j.status === 'queued');
    } catch {
      queued = [];
    }
    const sample = queued.slice(0, 3).map((j) => ({
      created_at: j.created_at,
      started_at: j.started_at,
      runner_id: j.runner_id,
      runner_name: j.runner_name,
    }));
    return {
      result: { runId, queuedJobs: queued.length, sample },
      assumptions:
        queued.length === 0
          ? {}
          : {
              'jobs.queued-runner-null': queued.every((j) => j.runner_id === null),
              'jobs.queued-started-eq-created': queued.every((j) => j.started_at === j.created_at),
            },
    };
  },
};

function main(): void {
  const wanted = process.argv.slice(2);
  const unknown = wanted.filter((w) => !(w in probes));
  if (unknown.length > 0) {
    process.stdout.write(`${JSON.stringify({ error: `unknown probe(s): ${unknown.join(', ')}`, probes: Object.keys(probes) })}\n`);
    process.exitCode = 2;
    return;
  }
  const version = gh(['--version']).stdout.split('\n')[0] ?? null;
  const out: { ghVersion: string | null; ranAt: string; probes: Record<string, unknown>; assumptions: Record<string, boolean> } = {
    ghVersion: version,
    ranAt: new Date().toISOString(),
    probes: {},
    assumptions: {},
  };
  for (const [id, probe] of Object.entries(probes)) {
    if (wanted.length > 0 && !wanted.includes(id)) continue;
    const { result, assumptions } = probe();
    out.probes[id] = result;
    Object.assign(out.assumptions, assumptions);
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exitCode = Object.values(out.assumptions).every(Boolean) ? 0 : 1;
}

main();
