// A small stateful GitHub for the ci wait tests. Unlike FakeGh's static replies, every REST read is
// computed from the world as it stands at clock.monotonic() (a timeline of states), with real ETags:
// a request whose If-None-Match equals the body's ETag gets the 304 that `gh api -i` gives (exit 1,
// headers on stdout, rate limit unchanged; spike §3.1). Calls are logged for expectNoCall-style checks.
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { FALLBACK_PR_QUERY, SUITES_QUERY } from '../../src/ci/wait/poller.ts';
import { isMutating } from '../../src/gh/guard.ts';
import type { ProcessRunner, ProcRequest, ProcResult } from '../../src/proc/runner.ts';
import type { FakeClock } from '../helpers/fake-clock.ts';
import { fakeGit } from '../helpers/fake-git.ts';
import { type HarnessOptions, runInProcess, scratchDir } from '../helpers/harness.ts';
import { httpReply, vitestLog } from './ci-why-world.ts';

export { vitestLog };
export const sha = (c: string): string => c.repeat(40);

export interface SimJob {
  id: number;
  runId: number;
  name: string;
  workflow?: string;
  workflowId?: number;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion?: string | null;
  /** Offsets in ms from the clock's start epoch. */
  createdAt?: number;
  startedAt?: number;
  completedAt?: number;
  runnerId?: number | null;
  /** Failing tests for the log (vitest format). */
  tests?: string[];
  /** Extra log lines (e.g. an infra error). */
  logExtra?: string[];
}

export interface SimStatus {
  context: string;
  state: 'pending' | 'success' | 'failure' | 'error';
}

export interface SimPr {
  state: 'open' | 'closed';
  merged?: boolean;
  head: string;
  base?: string;
}

export interface SimState {
  /** PR number `o.number` (default 7). */
  pr: SimPr;
  /** Further PRs by number (multi-target tests). */
  prs?: Record<number, SimPr>;
  branches?: Record<string, string>;
  /** Check runs per commit. */
  checks: Record<string, SimJob[]>;
  statuses?: Record<string, SimStatus[]>;
}

export interface SimOptions {
  slug?: string;
  number?: number;
  /** PR commits oldest first (baseline previous-head). Default: [the first head]. */
  prCommits?: string[];
  /** Required contexts from branch protection. */
  required?: string[];
  /** Completed push runs on main by workflow id, with their jobs (ETA samples and the main comparison). */
  mainRuns?: { id: number; workflowId?: number; jobs: SimJob[]; sha?: string }[];
  /** .github/ghx.json; null = 404. */
  config?: Record<string, unknown> | null;
}

interface Step {
  atMs: number;
  state: SimState;
}

export interface SimCall {
  argv: string[];
  at: number;
  status: number;
}

const json = (status: string, body: unknown, headers: Record<string, string>) =>
  httpReply(status, JSON.stringify(body), headers);

export class GitHubSim {
  readonly slug: string;
  readonly number: number;
  readonly calls: SimCall[] = [];
  readonly clock: FakeClock;
  readonly o: SimOptions;
  #steps: Step[] = [];
  #used = 0;
  #usedGraphql = 0;
  #overrides: { m: (argv: string[]) => boolean; reply: (argv: string[]) => ProcResultLike | undefined }[] = [];

  constructor(clock: FakeClock, initial: SimState, o: SimOptions = {}) {
    this.clock = clock;
    this.o = o;
    this.slug = o.slug ?? 'o/r';
    this.number = o.number ?? 7;
    this.#steps = [{ atMs: 0, state: initial }];
  }

  /** From `atMs` (monotonic) on, the world is `state`. */
  at(atMs: number, state: SimState | ((prev: SimState) => SimState)): this {
    const prev = this.stateAt(atMs);
    const next = typeof state === 'function' ? state(structuredClone(prev)) : state;
    this.#steps = [...this.#steps.filter((s) => s.atMs !== atMs), { atMs, state: next }].sort(
      (a, b) => a.atMs - b.atMs,
    );
    return this;
  }

  /** Answer matching calls with `reply` (undefined falls through). Later overrides win. */
  override(m: (argv: string[]) => boolean, reply: (argv: string[]) => ProcResultLike | undefined): this {
    this.#overrides.unshift({ m, reply });
    return this;
  }

  stateAt(ms = this.clock.monotonic()): SimState {
    return (this.#steps.filter((s) => s.atMs <= ms).at(-1) as Step).state;
  }

  iso(offsetMs: number | undefined): string | null {
    return offsetMs === undefined ? null : new Date(this.clock.now() - this.clock.monotonic() + offsetMs).toISOString();
  }

  /** Calls whose endpoint path (without query) satisfies `p`. */
  callsTo(p: string | RegExp): SimCall[] {
    return this.calls.filter((c) => {
      const path = endpoint(c.argv);
      return path !== undefined && (typeof p === 'string' ? path === p : p.test(path));
    });
  }

  mutations(): string[][] {
    return this.calls.filter((c) => isMutating(c.argv)).map((c) => c.argv);
  }

  runner(): ProcessRunner {
    return async (req: ProcRequest): Promise<ProcResult> => {
      if (!(req.cmd === 'gh' || req.cmd.endsWith('/gh'))) throw new Error(`sim: unexpected ${req.cmd}`);
      const argv = [...req.args];
      const r = this.#reply(argv);
      this.calls.push({ argv, at: this.clock.monotonic(), status: r.status });
      if (r.hang) {
        await new Promise<void>((resolve) => {
          if (req.signal.aborted) resolve();
          req.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return {
          exitCode: null,
          signal: 'SIGTERM',
          stdout: '',
          stderr: '',
          timedOut: false,
          aborted: true,
          durationMs: 0,
        };
      }
      if (req.stdoutFile) {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(req.stdoutFile, r.stdout);
        return { ...base(r), stdout: '' };
      }
      return base(r);
    };
  }

  #rate(): Record<string, string> {
    return {
      'X-Ratelimit-Limit': '5000',
      'X-Ratelimit-Remaining': String(5000 - this.#used),
      'X-Ratelimit-Used': String(this.#used),
      'X-Ratelimit-Reset': String(Math.floor(this.clock.now() / 1000) + 3600),
      'X-Ratelimit-Resource': 'core',
    };
  }

  /** A 200 with an ETag, or a 304 when If-None-Match matches. */
  #conditional(argv: string[], body: unknown): ProcResultLike {
    const text = JSON.stringify(body);
    const etag = `W/"${createHash('sha256').update(text).digest('hex').slice(0, 16)}"`;
    const inm = header(argv, 'if-none-match');
    if (inm !== undefined && inm.replace(/^W\//, '') === etag.replace(/^W\//, '')) {
      return {
        status: 304,
        exitCode: 1,
        stdout: httpReply('HTTP/2.0 304 Not Modified', '', { ETag: etag.slice(2), ...this.#rate() }),
        stderr: 'gh: HTTP 304\n',
      };
    }
    this.#used++;
    return {
      status: 200,
      exitCode: 0,
      stdout: json('HTTP/2.0 200 OK', body, { ETag: etag, ...this.#rate() }),
      stderr: '',
    };
  }

  #ok(body: unknown): ProcResultLike {
    this.#used++;
    return { status: 200, exitCode: 0, stdout: json('HTTP/2.0 200 OK', body, this.#rate()), stderr: '' };
  }

  #notFound(): ProcResultLike {
    return {
      status: 404,
      exitCode: 1,
      stdout: httpReply('HTTP/2.0 404 Not Found', '{"message":"Not Found","status":"404"}'),
      stderr: 'gh: Not Found (HTTP 404)\n',
    };
  }

  jobRow(j: SimJob, headSha: string): Record<string, unknown> {
    const created = j.createdAt ?? j.startedAt ?? 0;
    const status = j.status;
    return {
      id: j.id,
      run_id: j.runId,
      run_attempt: 1,
      name: j.name,
      status,
      conclusion: status === 'completed' ? (j.conclusion ?? 'success') : null,
      created_at: this.iso(created),
      started_at: this.iso(status === 'queued' ? created : (j.startedAt ?? created)),
      completed_at: status === 'completed' ? this.iso(j.completedAt ?? j.startedAt ?? created) : null,
      html_url: `https://github.com/${this.slug}/actions/runs/${j.runId}/job/${j.id}`,
      workflow_name: j.workflow ?? 'CI',
      head_sha: headSha,
      runner_id: j.runnerId === undefined ? (status === 'queued' ? null : 1) : j.runnerId,
      runner_name: status === 'queued' ? null : 'r1',
      steps: [
        { name: 'Set up job', status: 'completed', conclusion: 'success', number: 1 },
        {
          name: 'Run tests',
          status,
          conclusion: status === 'completed' ? (j.conclusion ?? 'success') : null,
          number: 2,
        },
      ],
    };
  }

  checkRun(j: SimJob): Record<string, unknown> {
    const created = j.createdAt ?? j.startedAt ?? 0;
    return {
      id: j.id,
      name: j.name,
      status: j.status,
      conclusion: j.status === 'completed' ? (j.conclusion ?? 'success') : null,
      started_at: this.iso(j.status === 'queued' ? created : (j.startedAt ?? created)),
      completed_at: j.status === 'completed' ? this.iso(j.completedAt ?? j.startedAt ?? created) : null,
      html_url: `https://github.com/${this.slug}/actions/runs/${j.runId}/job/${j.id}`,
      details_url: `https://github.com/${this.slug}/actions/runs/${j.runId}/job/${j.id}`,
      app: { slug: 'github-actions' },
      check_suite: { id: suiteOf(j) },
    };
  }

  /** Every job the world has ever had on any commit, plus main jobs (for jobs/{id} and logs). */
  #allJobs(): { job: SimJob; sha: string }[] {
    const out: { job: SimJob; sha: string }[] = [];
    const st = this.stateAt();
    for (const [s, jobs] of Object.entries(st.checks)) for (const job of jobs) out.push({ job, sha: s });
    for (const r of this.o.mainRuns ?? []) for (const job of r.jobs) out.push({ job, sha: r.sha ?? sha('d') });
    return out;
  }

  #reply(argv: string[]): ProcResultLike {
    for (const o of this.#overrides) {
      if (o.m(argv)) {
        const r = o.reply(argv);
        if (r) return r;
      }
    }
    const st = this.stateAt();
    const repo = `repos/${this.slug}`;
    if (argv[1] === 'graphql') return this.#graphql(argv, st);
    const path = endpoint(argv) ?? '';
    const q = query(argv);
    let pm = new RegExp(`^${repo}/pulls/(\\d+)$`).exec(path);
    if (pm) {
      const n = Number(pm[1]);
      const pr = n === this.number ? st.pr : st.prs?.[n];
      if (!pr) return this.#notFound();
      return this.#conditional(argv, {
        number: n,
        state: pr.state,
        merged: pr.merged === true,
        merged_at: pr.merged ? this.iso(0) : null,
        head: { sha: pr.head },
        base: { ref: pr.base ?? 'main', repo: { default_branch: 'main' } },
      });
    }
    pm = new RegExp(`^${repo}/pulls/(\\d+)/commits$`).exec(path);
    if (pm) {
      const n = Number(pm[1]);
      const pr = n === this.number ? st.pr : st.prs?.[n];
      if (!pr) return this.#notFound();
      return this.#ok((n === this.number ? (this.o.prCommits ?? [pr.head]) : [pr.head]).map((s) => ({ sha: s })));
    }
    if (path === `${repo}/pulls`) return this.#ok([]);
    if (path.startsWith(`${repo}/rules/branches/`)) return this.#ok([]);
    let m = new RegExp(`^${repo}/branches/(.+)$`).exec(path);
    if (m) {
      const name = decodeURIComponent(m[1] as string);
      const head = st.branches?.[name] ?? (name === (st.pr.base ?? 'main') ? sha('d') : undefined);
      if (!head) return this.#notFound();
      return this.#conditional(argv, {
        name,
        commit: { sha: head },
        protected: (this.o.required ?? []).length > 0,
        protection: { required_status_checks: { contexts: this.o.required ?? [] } },
      });
    }
    m = new RegExp(`^${repo}/commits/([0-9a-f]{40})/check-runs$`).exec(path);
    if (m) {
      const jobs = st.checks[m[1] as string] ?? [];
      const page = Number(q.page ?? 1);
      const per = Number(q.per_page ?? 30);
      const slice = jobs.slice((page - 1) * per, page * per);
      return this.#conditional(argv, { total_count: jobs.length, check_runs: slice.map((j) => this.checkRun(j)) });
    }
    m = new RegExp(`^${repo}/commits/([0-9a-f]{40})/status$`).exec(path);
    if (m) {
      const statuses = st.statuses?.[m[1] as string] ?? [];
      return this.#conditional(argv, {
        state: 'pending',
        statuses: statuses.map((s) => ({
          context: s.context,
          state: s.state,
          target_url: null,
          created_at: this.iso(0),
          updated_at: this.iso(0),
        })),
      });
    }
    m = new RegExp(`^${repo}/commits/([0-9a-f]{7,40})$`).exec(path);
    if (m) {
      const prefix = m[1] as string;
      const known = [...Object.keys(st.checks), ...Object.values(st.branches ?? {}), st.pr.head];
      const full = prefix.length === 40 ? prefix : known.find((k) => k.startsWith(prefix));
      return full ? this.#ok({ sha: full, parents: [{ sha: sha('c') }] }) : this.#notFound();
    }
    if (path === `${repo}/contents/.github/ghx.json`) {
      if (!this.o.config) return this.#notFound();
      return this.#ok({
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(JSON.stringify(this.o.config)).toString('base64'),
      });
    }
    if (path.startsWith(`${repo}/contents/`)) return this.#notFound();
    if (path === repo) return this.#ok({ full_name: this.slug, default_branch: 'main' });
    m = new RegExp(`^${repo}/actions/workflows/(\\d+)/runs$`).exec(path);
    if (m) {
      const wf = Number(m[1]);
      const runs =
        q.event === 'push' || q.branch ? (this.o.mainRuns ?? []).filter((r) => (r.workflowId ?? 5) === wf) : [];
      return this.#ok({
        total_count: runs.length,
        workflow_runs: runs.map((r) => ({
          id: r.id,
          head_sha: r.sha ?? sha('d'),
          head_branch: 'main',
          event: 'push',
          status: 'completed',
          conclusion: r.jobs.some((j) => j.conclusion === 'failure') ? 'failure' : 'success',
          workflow_id: wf,
          path: `.github/workflows/w${wf}.yml`,
          run_attempt: 1,
          created_at: this.iso(-3_600_000),
          run_started_at: this.iso(-3_600_000),
          pull_requests: [],
        })),
      });
    }
    if (path === `${repo}/actions/runs`) return this.#ok({ total_count: 0, workflow_runs: [] });
    m = new RegExp(`^${repo}/actions/runs/(\\d+)/jobs$`).exec(path);
    if (m) {
      const runId = Number(m[1]);
      const rows = this.#allJobs()
        .filter((x) => x.job.runId === runId)
        .map((x) => this.jobRow(x.job, x.sha));
      return this.#ok({ total_count: rows.length, jobs: rows });
    }
    m = new RegExp(`^${repo}/actions/jobs/(\\d+)/logs$`).exec(path);
    if (m) {
      const hit = this.#allJobs().find((x) => x.job.id === Number(m?.[1]));
      if (!hit) return this.#notFound();
      const BOM = String.fromCharCode(0xfeff);
      return {
        status: 200,
        exitCode: 0,
        stdout: `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n${BOM}${vitestLog(hit.job.tests ?? ['src/a.test.ts > fails'], { extra: hit.job.logExtra ?? [] })}`,
        stderr: '',
      };
    }
    m = new RegExp(`^${repo}/actions/jobs/(\\d+)$`).exec(path);
    if (m) {
      const hit = this.#allJobs().find((x) => x.job.id === Number(m?.[1]));
      return hit ? this.#ok(this.jobRow(hit.job, hit.sha)) : this.#notFound();
    }
    m = new RegExp(`^${repo}/actions/runs/(\\d+)$`).exec(path);
    if (m) {
      const runId = Number(m[1]);
      const hit = this.#allJobs().find((x) => x.job.runId === runId);
      if (!hit) return this.#notFound();
      const wf = hit.job.workflowId ?? 5;
      return this.#ok({
        id: runId,
        head_sha: hit.sha,
        event: 'pull_request',
        status: 'completed',
        conclusion: 'failure',
        workflow_id: wf,
        path: `.github/workflows/w${wf}.yml`,
        run_attempt: 1,
        created_at: this.iso(0),
      });
    }
    return this.#notFound();
  }

  #graphql(argv: string[], st: SimState): ProcResultLike {
    const field = (k: string) => argv.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1);
    const q = field('query');
    this.#usedGraphql++;
    const ok = (data: unknown): ProcResultLike => ({
      status: 200,
      exitCode: 0,
      stdout: json(
        'HTTP/2.0 200 OK',
        { data },
        {
          ...this.#rate(),
          'X-Ratelimit-Remaining': String(5000 - this.#usedGraphql),
          'X-Ratelimit-Used': String(this.#usedGraphql),
          'X-Ratelimit-Resource': 'graphql',
        },
      ),
      stderr: '',
    });
    if (q === SUITES_QUERY) {
      const jobs = st.checks[field('oid') ?? ''] ?? [];
      const nodes = [...new Map(jobs.map((j) => [suiteOf(j), j])).values()].map((j) => ({
        databaseId: suiteOf(j),
        workflowRun: {
          databaseId: j.runId,
          event: 'pull_request',
          file: { path: `.github/workflows/w${j.workflowId ?? 5}.yml` },
          workflow: { databaseId: j.workflowId ?? 5, name: j.workflow ?? 'CI' },
        },
      }));
      return ok({ repository: { object: { checkSuites: { nodes } } } });
    }
    if (q === FALLBACK_PR_QUERY) {
      const head = st.pr.head;
      const nodes = (st.checks[head] ?? []).map((j) => {
        const r = this.checkRun(j) as Record<string, string | null>;
        return {
          __typename: 'CheckRun',
          databaseId: j.id,
          name: j.name,
          status: String(r.status).toUpperCase(),
          conclusion: r.conclusion === null ? null : String(r.conclusion).toUpperCase(),
          startedAt: r.started_at,
          completedAt: r.completed_at,
          detailsUrl: r.html_url,
          isRequired: false,
          checkSuite: {
            app: { slug: 'github-actions' },
            workflowRun: {
              databaseId: j.runId,
              event: 'pull_request',
              file: { path: `.github/workflows/w${j.workflowId ?? 5}.yml` },
              workflow: { databaseId: j.workflowId ?? 5, name: j.workflow ?? 'CI' },
            },
          },
        };
      });
      return ok({
        rateLimit: { limit: 5000, remaining: 4321, resetAt: this.iso(3_600_000), cost: 1 },
        repository: {
          defaultBranchRef: { name: 'main' },
          pullRequest: {
            number: this.number,
            state: st.pr.merged ? 'MERGED' : st.pr.state.toUpperCase(),
            headRefOid: head,
            headRefName: 'feat/x',
            baseRefName: st.pr.base ?? 'main',
            commits: {
              nodes: [
                {
                  commit: {
                    oid: head,
                    statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } },
                  },
                },
              ],
            },
          },
        },
      });
    }
    return {
      status: 200,
      exitCode: 1,
      stdout: json('HTTP/2.0 200 OK', { data: null, errors: [{ type: 'NOT_FOUND', message: 'unknown query' }] }, {}),
      stderr: 'gh: GraphQL: unknown query\n',
    };
  }
}

export interface ProcResultLike {
  status: number;
  exitCode: number;
  stdout: string;
  stderr: string;
  hang?: boolean;
}

function base(r: ProcResultLike): ProcResult {
  return {
    exitCode: r.exitCode,
    signal: null,
    stdout: r.stdout,
    stderr: r.stderr,
    timedOut: false,
    aborted: false,
    durationMs: 0,
  };
}

const suiteOf = (j: SimJob): number => 9_000_000 + j.runId;

/** The endpoint path of a `gh api` argv, without its query string. */
export function endpoint(argv: readonly string[]): string | undefined {
  if (argv[1] === 'graphql') return 'graphql';
  return argv.find((a) => a.startsWith('repos/') || a === 'rate_limit')?.split('?')[0];
}

export function query(argv: readonly string[]): Record<string, string> {
  const p = argv.find((a) => a.startsWith('repos/'));
  const qs = p?.split('?')[1];
  return Object.fromEntries(new URLSearchParams(qs ?? '').entries());
}

export function header(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-H') {
      const h = argv[i + 1] ?? '';
      const c = h.indexOf(':');
      if (h.slice(0, c).trim().toLowerCase() === name) return h.slice(c + 1).trim();
    }
  }
  return undefined;
}

export const forbidden = (): ProcResultLike => ({
  status: 403,
  exitCode: 1,
  stdout: httpReply('HTTP/2.0 403 Forbidden', '{"message":"Resource not accessible by integration"}'),
  stderr: 'gh: Resource not accessible by integration (HTTP 403)\n',
});

/** Run `ghx ci wait …argv` in-process against the sim, with its own artifact dir unless given. */
export function startWait(
  sim: GitHubSim,
  argv: string[],
  o: {
    env?: Record<string, string | undefined>;
    artifacts?: string;
    shutdown?: HarnessOptions['shutdown'];
    /** Replaces the sim's runner (e.g. a recording wrapper around it). */
    proc?: ProcessRunner;
  } = {},
) {
  const artifacts = o.artifacts ?? mkdtempSync(join(scratchDir(), 'wait-'));
  let done = false;
  const p = runInProcess(['ci', 'wait', ...argv], {
    proc: o.proc ?? sim.runner(),
    git: fakeGit({}),
    clock: sim.clock,
    env: { GHX_ARTIFACT_DIR: artifacts, CLAUDE_CODE_SESSION_ATTENDED: '1', ...o.env },
    ...(o.shutdown ? { shutdown: o.shutdown } : {}),
  }).then((r) => {
    done = true;
    return r;
  });
  return { p, artifacts, isDone: () => done };
}

/** Start the wait and drive fake time until it exits. */
export async function wait(
  sim: GitHubSim,
  argv: string[],
  o: Parameters<typeof startWait>[2] & { stepMs?: number; maxMs?: number } = {},
) {
  const run = startWait(sim, argv, o);
  await sim.clock.runUntil(run.isDone, { stepMs: o.stepMs ?? 5_000, maxMs: o.maxMs ?? 8 * 3_600_000 });
  return { ...(await run.p), artifacts: run.artifacts };
}
