// A small fake GitHub for the ci why tests: PR head jobs (in the rollup), jobs on main runs, logs, and
// the Actions REST endpoints the diagnosis reads, installed as FakeGh rules. Each endpoint is one
// rule, so a test can still override a single reply with fake.on() after install().
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CI_SNAPSHOT_QUERY } from '../../src/ci/snapshot.ts';
import { FakeGh, type GhReply } from '../helpers/fake-gh.ts';
import { GH_FIXTURE_ROOT } from '../helpers/fixture-match.ts';
import { runInProcess, scratchDir } from '../helpers/harness.ts';

export type LogSpec = { text: string } | { file: string } | 'not-ready' | 'gone';

export interface WJob {
  id: number;
  runId: number;
  name: string;
  /** Default 'CI' / 5. */
  workflow?: string;
  workflowId?: number;
  status?: 'completed' | 'in_progress' | 'queued';
  conclusion: string | null;
  required?: boolean;
  attempt?: number;
  /** The step that carries the conclusion (default 'Run tests'). */
  step?: string;
  /** Full jobs-API steps; overrides the synthetic three. */
  steps?: unknown[];
  /** A recorded jobs-API row (its id/run_id must match). */
  row?: Record<string, unknown>;
  log?: LogSpec;
  headSha?: string;
}

export interface World {
  slug: string;
  number: number;
  headSha: string;
  defaultBranch?: string;
  prState?: 'OPEN' | 'CLOSED' | 'MERGED';
  /** Jobs on the PR head (the rollup). */
  jobs: WJob[];
  statuses?: { context: string; state: string; targetUrl?: string; required?: boolean }[];
  /** Jobs on other runs (main), reachable through runs/{id}/jobs and jobs/{id}/logs. */
  otherJobs?: WJob[];
  /** Completed push runs on the default branch, by workflow id (newest first). */
  mainRuns?: Record<number, Record<string, unknown>[]>;
  /** actions/runs?head_sha= (same-sha-passed). Default []. */
  shaRuns?: Record<string, unknown>[];
  /** .github/ghx.json in the repo; null answers 404. */
  config?: Record<string, unknown> | null;
  /** Runs GitHub rejected before any job ran (failed, no job): rollup check suites, runs listing, empty jobs. */
  rejected?: { id: number; path: string; conclusion?: string }[];
}

export const sha = (c: string): string => c.repeat(40);

export function httpReply(status: string, body: string, headers: Record<string, string> = {}): string {
  const h = { 'Content-Type': 'application/json; charset=utf-8', ...headers };
  return [status, ...Object.entries(h).map(([k, v]) => `${k}: ${v}`), '', body].join('\r\n');
}

export const okJson = (body: unknown): GhReply => ({
  exitCode: 0,
  stdout: httpReply('HTTP/2.0 200 OK', JSON.stringify(body)),
  stderr: '',
});

export const notFoundJson = (): GhReply => ({
  exitCode: 1,
  stdout: httpReply('HTTP/2.0 404 Not Found', '{"message":"Not Found","status":"404"}'),
  stderr: 'gh: Not Found (HTTP 404)\n',
});

export const serverError = (): GhReply => ({
  exitCode: 1,
  stdout: httpReply('HTTP/2.0 502 Bad Gateway', '{"message":"Server Error"}'),
  stderr: 'gh: HTTP 502\n',
});

function recorded(file: string): GhReply {
  const f = JSON.parse(readFileSync(join(GH_FIXTURE_ROOT, file), 'utf8')) as GhReply;
  return { exitCode: f.exitCode, stdout: f.stdout, stderr: f.stderr };
}

/** Raw job logs start with a UTF-8 BOM (spike §3.3). */
const BOM = String.fromCharCode(0xfeff);

export function logReply(spec: LogSpec): GhReply {
  if (spec === 'not-ready') return recorded('logs-api/blob-404-in-progress.json');
  if (spec === 'gone') return recorded('logs-api/gone-410.json');
  if ('file' in spec) return { exitCode: 0, stdout: '', stderr: '', stdoutFile: spec.file };
  return { exitCode: 0, stdout: `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n${BOM}${spec.text}`, stderr: '' };
}

/** A raw vitest job log: one `Run pnpm test` step with FAIL blocks, the summary and the exit line. */
export function vitestLog(tests: string[], o: { error?: string; extra?: string[] } = {}): string {
  const ts = (s: number) => `2026-10-22T11:00:${String(s).padStart(2, '0')}.0000000Z`;
  const lines = [
    `${ts(0)} ##[group]Run pnpm test`,
    `${ts(0)} pnpm test`,
    `${ts(0)} ##[endgroup]`,
    `${ts(1)}  RUN  v3.2.4 /home/runner/work/r/r`,
    ...(o.extra ?? []).map((l) => `${ts(1)} ${l}`),
    ...tests.flatMap((t) => [`${ts(2)}  FAIL  ${t}`, `${ts(2)} ${o.error ?? 'AssertionError: expected 3 to equal 4'}`]),
    `${ts(3)}  Test Files  ${tests.length} failed | 4 passed (${tests.length + 4})`,
    `${ts(3)} ##[error]Process completed with exit code 1.`,
  ];
  return `${lines.join('\n')}\n`;
}

function runOf(j: WJob): { id: number; wf: number; workflow: string; path: string } {
  const wf = j.workflowId ?? 5;
  return { id: j.runId, wf, workflow: j.workflow ?? 'CI', path: `.github/workflows/w${wf}.yml` };
}

export function jobRow(w: Pick<World, 'slug' | 'headSha'>, j: WJob): Record<string, unknown> {
  if (j.row) return j.row;
  const status = j.status ?? (j.conclusion === null ? 'in_progress' : 'completed');
  const stepName = j.step ?? 'Run tests';
  return {
    id: j.id,
    run_id: j.runId,
    run_attempt: j.attempt ?? 1,
    name: j.name,
    status,
    conclusion: j.conclusion,
    created_at: '2026-10-22T10:59:00Z',
    started_at: '2026-10-22T10:59:30Z',
    completed_at: status === 'completed' ? '2026-10-22T11:00:30Z' : null,
    html_url: `https://github.com/${w.slug}/actions/runs/${j.runId}/job/${j.id}`,
    workflow_name: j.workflow ?? 'CI',
    head_sha: j.headSha ?? w.headSha,
    steps: j.steps ?? [
      { name: 'Set up job', status: 'completed', conclusion: 'success', number: 1 },
      { name: stepName, status, conclusion: j.conclusion, number: 2 },
      { name: 'Complete job', status, conclusion: status === 'completed' ? 'success' : null, number: 3 },
    ],
  };
}

export function rollupData(w: World): unknown {
  const nodes = [
    ...w.jobs.map((j) => {
      const row = jobRow(w, j);
      const r = runOf(j);
      return {
        __typename: 'CheckRun',
        databaseId: j.id,
        name: j.name,
        status: String(row.status).toUpperCase(),
        conclusion: j.conclusion === null ? null : j.conclusion.toUpperCase(),
        startedAt: row.started_at,
        completedAt: row.completed_at,
        detailsUrl: row.html_url,
        isRequired: j.required === true,
        checkSuite: {
          app: { slug: 'github-actions' },
          workflowRun: {
            databaseId: r.id,
            event: 'pull_request',
            file: { path: r.path },
            workflow: { databaseId: r.wf, name: r.workflow },
          },
        },
      };
    }),
    ...(w.statuses ?? []).map((s) => ({
      __typename: 'StatusContext',
      context: s.context,
      state: s.state,
      targetUrl: s.targetUrl ?? null,
      createdAt: '2026-10-22T10:59:00Z',
      isRequired: s.required === true,
    })),
  ];
  return {
    data: {
      repository: {
        defaultBranchRef: { name: w.defaultBranch ?? 'main' },
        pullRequest: {
          number: w.number,
          state: w.prState ?? 'OPEN',
          headRefOid: w.headSha,
          headRefName: 'feat/x',
          baseRefName: w.defaultBranch ?? 'main',
          commits: {
            nodes: [
              {
                commit: {
                  oid: w.headSha,
                  statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } },
                  checkSuites: { nodes: (w.rejected ?? []).map((r) => rejectedSuite(w, r)) },
                },
              },
            ],
          },
        },
      },
    },
  };
}

/** A rejected run as a GraphQL check suite: completed, failed, no check run. */
function rejectedSuite(w: World, r: NonNullable<World['rejected']>[number]): unknown {
  return {
    status: 'COMPLETED',
    conclusion: (r.conclusion ?? 'failure').toUpperCase(),
    checkRuns: { totalCount: 0 },
    workflowRun: {
      databaseId: r.id,
      url: `https://github.com/${w.slug}/actions/runs/${r.id}`,
      createdAt: '2026-10-22T10:59:00Z',
      event: 'push',
      file: { path: r.path },
      workflow: { databaseId: 9, name: 'ci' },
    },
  };
}

/** A rejected run's REST row: named after its file, failed at creation. */
export function rejectedRun(w: World, r: NonNullable<World['rejected']>[number]): Record<string, unknown> {
  return {
    id: r.id,
    name: r.path,
    head_sha: w.headSha,
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: r.conclusion ?? 'failure',
    workflow_id: 9,
    path: r.path,
    html_url: `https://github.com/${w.slug}/actions/runs/${r.id}`,
    run_attempt: 1,
    created_at: '2026-10-22T10:59:00Z',
  };
}

/** A completed push run on the default branch. */
export function mainRun(
  id: number,
  conclusion: string,
  o: { wf?: number; sha?: string } = {},
): Record<string, unknown> {
  return {
    id,
    head_sha: o.sha ?? sha('d'),
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion,
    workflow_id: o.wf ?? 5,
    path: `.github/workflows/w${o.wf ?? 5}.yml`,
    run_attempt: 1,
    created_at: '2026-10-22T09:00:00Z',
    run_started_at: '2026-10-22T09:00:05Z',
  };
}

/** The PR-side run row for `runId` (actions/runs/{id}), derived from its jobs. */
export function prRun(w: World, runId: number): Record<string, unknown> {
  const jobs = [...w.jobs, ...(w.otherJobs ?? [])].filter((j) => j.runId === runId);
  const first = jobs[0];
  const r = first ? runOf(first) : { wf: 5, path: '.github/workflows/w5.yml' };
  const done = jobs.every((j) => j.conclusion !== null);
  const failed = jobs.some((j) => j.conclusion === 'failure');
  return {
    id: runId,
    head_sha: first?.headSha ?? w.headSha,
    head_branch: 'feat/x',
    event: 'pull_request',
    status: done ? 'completed' : 'in_progress',
    conclusion: done ? (failed ? 'failure' : 'success') : null,
    workflow_id: r.wf,
    path: r.path,
    run_attempt: 1,
    created_at: '2026-10-22T10:59:00Z',
    run_started_at: '2026-10-22T10:59:05Z',
  };
}

const pathOf = (argv: readonly string[]): string | undefined => argv.find((a) => a.startsWith('repos/'))?.split('?')[0];

/** Install the world as FakeGh rules. */
export function install(fake: FakeGh, w: World): FakeGh {
  const base = `repos/${w.slug}`;
  const at = (p: string) => (argv: string[]) => pathOf(argv) === p;
  fake.on((a) => a[1] === 'graphql' && a.some((x) => x === `query=${CI_SNAPSHOT_QUERY}`), okJson(rollupData(w)));
  fake.on(at(`${base}/contents/.github/ghx.json`), w.config ? okJson(contents(w.config)) : notFoundJson());
  fake.on(at(base), okJson({ full_name: w.slug, default_branch: w.defaultBranch ?? 'main' }));
  fake.on(
    at(`${base}/actions/runs`),
    okJson({ total_count: (w.shaRuns ?? []).length, workflow_runs: w.shaRuns ?? [] }),
  );
  const all = [...w.jobs, ...(w.otherJobs ?? [])];
  for (const j of all) {
    fake.on(at(`${base}/actions/jobs/${j.id}`), okJson(jobRow(w, j)));
    if (j.log) fake.on(at(`${base}/actions/jobs/${j.id}/logs`), logReply(j.log));
  }
  for (const runId of new Set(all.map((j) => j.runId))) {
    const rows = all.filter((j) => j.runId === runId).map((j) => jobRow(w, j));
    fake.on(at(`${base}/actions/runs/${runId}/jobs`), okJson({ total_count: rows.length, jobs: rows }));
  }
  for (const runId of new Set(w.jobs.map((j) => j.runId))) {
    fake.on(at(`${base}/actions/runs/${runId}`), okJson(prRun(w, runId)));
  }
  for (const r of w.rejected ?? []) {
    fake.on(at(`${base}/actions/runs/${r.id}`), okJson(rejectedRun(w, r)));
    fake.on(at(`${base}/actions/runs/${r.id}/jobs`), okJson({ total_count: 0, jobs: [] }));
  }
  const wfs = new Set([...w.jobs.map((j) => j.workflowId ?? 5), ...Object.keys(w.mainRuns ?? {}).map(Number)]);
  for (const wf of wfs) {
    const runs = w.mainRuns?.[wf] ?? [];
    fake.on(at(`${base}/actions/workflows/${wf}/runs`), okJson({ total_count: runs.length, workflow_runs: runs }));
  }
  return fake;
}

function contents(config: Record<string, unknown>): unknown {
  return {
    type: 'file',
    encoding: 'base64',
    content: Buffer.from(JSON.stringify(config)).toString('base64'),
    url: 'https://api.github.com/repos/o/r/contents/.github/ghx.json?ref=main',
  };
}

/** A recorded runner job (test/fixtures/gh/logs/<runner>-fail/) as a failing PR job. */
export function recordedJob(runner: string, o: Partial<WJob> = {}): WJob {
  const dir = join(GH_FIXTURE_ROOT, 'logs', `${runner}-fail`);
  const fixture = JSON.parse(readFileSync(join(dir, '001-job.json'), 'utf8')) as { stdout: string };
  const row = JSON.parse(fixture.stdout.split('\r\n\r\n')[1] ?? '{}') as Record<string, unknown>;
  return {
    id: row.id as number,
    runId: row.run_id as number,
    name: row.name as string,
    conclusion: 'failure',
    row,
    log: { file: join(dir, '002-logs.log') },
    ...o,
  };
}

/** Run `ghx ci why <slug>#<number> …args` against the world, with its own artifact dir. */
export async function why(world: World, args: string[] = [], o: { fake?: FakeGh; selector?: boolean } = {}) {
  /** A caller-supplied fake is already installed (so its overrides win). */
  const fake = o.fake ?? install(new FakeGh(), world);
  const artifacts = mkdtempSync(join(scratchDir(), 'why-'));
  /** selector: false leaves the PR selector out (for --run). */
  const selector = o.selector === false ? [] : [`${world.slug}#${world.number}`];
  const r = await runInProcess(['ci', 'why', ...selector, ...args], {
    gh: fake,
    env: { GHX_ARTIFACT_DIR: artifacts },
  });
  return { ...r, fake };
}
