// The ci wait poller (02 §11.6; 03 M4.3, spike §3.1). A tick sends three conditional REST GETs (pulls/N
// or branches/<name>, check-runs, status) and returns GraphQL-shaped rollup nodes for checks.ts. A 304 is
// free and reuses the cached, schema-stripped body, which persists in the wait state (M4.6).
// REST check runs carry no workflow run, so new check suites are mapped once via GraphQL. The same query
// reads which suites the statusCheckRollup holds: the rollup is the one canonical check set (04), and
// REST also lists suites it leaves out (a `dynamic` copilot review), which are dropped.
// After two consecutive REST failures, one GraphQL query per tick (with rateLimit{}) takes over.
import { z } from 'zod';
import { rethrowControlFlow } from '../../core/control-flow.ts';
import { GhxError } from '../../core/errors.ts';
import type { ApiRequest } from '../../gh/api.ts';
import { type Gh, GhFailure } from '../../gh/index.ts';
import type { RateBudget } from '../../gh/ratelimit.ts';
import type { RepoRef } from '../../gh/types.ts';
import type { RollupContext } from '../checks.ts';
import { CI_COMMIT_FIELDS, CI_SNAPSHOT_QUERY, CiCommit, completeRollup } from '../snapshot.ts';
import { branchPath } from './fetch.ts';

// ── REST shapes (z.object strips unknown keys: the parsed object is what the ETag cache keeps) ──────
const PullRest = z.object({
  number: z.number().int(),
  state: z.string(),
  merged: z.boolean().nullish(),
  merged_at: z.string().nullish(),
  head: z.object({ sha: z.string() }),
  base: z.object({ ref: z.string(), repo: z.object({ default_branch: z.string() }).nullish() }),
});

const BranchRest = z.object({ commit: z.object({ sha: z.string() }) });

const CheckRunRest = z.object({
  id: z.number().int(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  started_at: z.string().nullish(),
  completed_at: z.string().nullish(),
  details_url: z.string().nullish(),
  html_url: z.string().nullish(),
  app: z.object({ slug: z.string() }).nullish(),
  check_suite: z.object({ id: z.number().int() }).nullish(),
});
const CheckRunsRest = z.object({ total_count: z.number().int(), check_runs: z.array(CheckRunRest) });

const StatusRest = z.object({
  statuses: z.array(
    z.object({
      context: z.string(),
      state: z.string(),
      target_url: z.string().nullish(),
      created_at: z.string().nullish(),
      updated_at: z.string().nullish(),
    }),
  ),
});

type CheckRunRest = z.infer<typeof CheckRunRest>;

/** Check-run pages read per tick, each conditional (500 checks, like the GraphQL snapshot). */
export const MAX_CHECK_RUN_PAGES = 5;
/** Consecutive REST failures before the GraphQL fallback takes over (03 M4.3). */
export const REST_FAILURES_BEFORE_FALLBACK = 2;
/** A suite still unmapped after this many GraphQL lookups is treated as a non-Actions suite. */
export const MAX_SUITE_LOOKUPS = 3;
/** Lookups in a row that must miss a suite in a complete rollup before its checks are dropped. */
export const ROLLUP_MISSES_TO_DROP = 2;

// ── Suite → workflow run (GraphQL, once per new suite) ────────────────────
export const WorkflowRunNode = z.object({
  databaseId: z.number().int().nullable(),
  event: z.string().nullable(),
  file: z.object({ path: z.string() }).nullable(),
  workflow: z.object({ databaseId: z.number().int().nullable(), name: z.string() }),
});
export type WorkflowRunNode = z.infer<typeof WorkflowRunNode>;

export const SUITES_QUERY =
  'query($owner:String!,$name:String!,$oid:GitObjectID!){repository(owner:$owner,name:$name){' +
  'object(oid:$oid){... on Commit{checkSuites(first:100){nodes{databaseId ' +
  'workflowRun{databaseId event file{path} workflow{databaseId name}}}} ' +
  'statusCheckRollup{contexts(first:100){pageInfo{hasNextPage} nodes{__typename ' +
  '... on CheckRun{checkSuite{databaseId}}}}}}}}}';

const SuitesData = z.object({
  repository: z
    .object({
      object: z
        .object({
          checkSuites: z
            .object({
              nodes: z.array(
                z
                  .object({ databaseId: z.number().int().nullable(), workflowRun: WorkflowRunNode.nullable() })
                  .nullable(),
              ),
            })
            .nullish(),
          statusCheckRollup: z
            .object({
              contexts: z.object({
                pageInfo: z.object({ hasNextPage: z.boolean() }),
                nodes: z.array(
                  z.object({ checkSuite: z.object({ databaseId: z.number().int().nullable() }).nullish() }).nullable(),
                ),
              }),
            })
            .nullish(),
        })
        .nullable(),
    })
    .nullable(),
});

// ── GraphQL fallback queries ───────────────────────────────────────────────
const RATE_FIELDS = 'rateLimit{limit remaining resetAt cost}';
const RateLimitNode = z.object({ limit: z.number(), remaining: z.number(), resetAt: z.string() }).nullish();

/** The CI snapshot query plus rateLimit{} (one call per tick). */
export const FALLBACK_PR_QUERY = CI_SNAPSHOT_QUERY.replace('{repository(', `{${RATE_FIELDS} repository(`);
if (FALLBACK_PR_QUERY === CI_SNAPSHOT_QUERY) throw new Error('poller: CI_SNAPSHOT_QUERY changed shape');

/** A branch target has no PR, so isRequired (which needs a PR number) is left out. */
const COMMIT_FIELDS_NO_PR = CI_COMMIT_FIELDS.replaceAll(' isRequired(pullRequestNumber:$number)', '');
export const FALLBACK_BRANCH_QUERY =
  'query($owner:String!,$name:String!,$qref:String!,$oid:GitObjectID!,$after:String){' +
  `${RATE_FIELDS} repository(owner:$owner,name:$name){ref(qualifiedName:$qref){target{oid}} ` +
  `object(oid:$oid){... on Commit{${COMMIT_FIELDS_NO_PR}}}}}`;

const FallbackPrData = z.object({
  rateLimit: RateLimitNode,
  repository: z
    .object({
      defaultBranchRef: z.object({ name: z.string() }).nullable(),
      pullRequest: z
        .object({
          number: z.number().int(),
          state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
          headRefOid: z.string(),
          baseRefName: z.string(),
          commits: z.object({ nodes: z.array(z.object({ commit: CiCommit }).nullable()) }),
        })
        .nullable(),
    })
    .nullable(),
});

const LooseCommit = z.object({
  oid: z.string(),
  statusCheckRollup: z
    .object({
      contexts: z.object({
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
        nodes: z.array(z.record(z.string(), z.unknown()).nullable()),
      }),
    })
    .nullable(),
});

const FallbackBranchData = z.object({
  rateLimit: RateLimitNode,
  repository: z
    .object({
      ref: z.object({ target: z.object({ oid: z.string() }).nullable() }).nullable(),
      object: LooseCommit.nullable(),
    })
    .nullable(),
});

// ── Public types ──────────────────────────────────────────────────────────
export type PollTarget = { kind: 'pr'; number: number } | { kind: 'branch'; branch: string };

export interface PullInfo {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  headSha: string;
  baseRef: string;
  /** The repo default branch, when the response carried it. */
  defaultBranch: string | null;
}

export interface EtagEntry {
  etag: string;
  /** The schema-parsed body of the last 200; re-validated on use. */
  body: unknown;
}

/** What the poller persists between processes (M4.6). */
export interface PollerState {
  etags: Record<string, EtagEntry>;
  /** check_suite id → its workflow run (null: not an Actions suite). */
  suites: Record<string, WorkflowRunNode | null>;
  /** Lookups so far for suites not yet mapped. */
  suiteLookups: Record<string, number>;
  /** check_suite id → true (in the rollup) or how many complete rollups in a row left it out. */
  rollup?: Record<string, true | number>;
}

export const emptyPollerState = (): PollerState => ({ etags: {}, suites: {}, suiteLookups: {}, rollup: {} });

export interface TickResult {
  /** PR targets: the PR as read this tick. */
  pull: PullInfo | null;
  /** The target's current head (PR head or branch head); null when a branch no longer exists. */
  headSha: string | null;
  /** The commit whose CI was read. */
  sha: string;
  /** Rollup nodes for `sha`. */
  nodes: RollupContext[];
  source: 'rest' | 'graphql';
  /** Every REST read was a 304. */
  notModified: boolean;
  /** gh calls made this tick. */
  calls: number;
  /** The budget of the resource polled (core for REST, graphql for the fallback). */
  budget: RateBudget | undefined;
}

export interface Poller {
  /**
   * One tick. `sha` is the commit to read CI for; null reads the target's current head (a fresh binding).
   * `required` marks REST check runs as required (REST carries no isRequired).
   */
  tick(o: { sha: string | null; required?: ReadonlySet<string> }): Promise<TickResult>;
  readonly mode: 'rest' | 'graphql';
  /** The persistable part (ETags, suite map). */
  state(): PollerState;
}

/** A tick failed but the wait can go on (the next tick retries, or the fallback takes over). */
export class TickFailed extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super(`poll failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'TickFailed';
    this.cause = cause;
  }
}

const isRateLimited = (e: unknown): boolean => e instanceof GhFailure && e.failure.code === 'GH_RATE_LIMITED';
const isNotFound = (e: unknown): boolean => e instanceof GhFailure && e.failure.code === 'GH_NOT_FOUND';

/** A conditional GET's cache key (method-less: every poll read is a GET). */
export function etagKey(req: Pick<ApiRequest, 'path' | 'fields'>): string {
  const q = Object.entries(req.fields ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('&');
  return q ? `${req.path}?${q}` : req.path;
}

function pullInfo(p: z.infer<typeof PullRest>): PullInfo {
  const merged = p.merged === true || (p.merged_at ?? null) !== null;
  return {
    number: p.number,
    state: p.state.toLowerCase() === 'open' ? 'OPEN' : merged ? 'MERGED' : 'CLOSED',
    headSha: p.head.sha,
    baseRef: p.base.ref,
    defaultBranch: p.base.repo?.default_branch ?? null,
  };
}

/** A REST check run as a GraphQL rollup node (so checks.ts normalises both alike). */
export function checkRunNode(
  r: CheckRunRest,
  suites: Readonly<Record<string, WorkflowRunNode | null>>,
  required: ReadonlySet<string>,
): RollupContext {
  const run = r.check_suite ? (suites[String(r.check_suite.id)] ?? null) : null;
  return {
    __typename: 'CheckRun',
    databaseId: r.id,
    name: r.name,
    status: r.status.toUpperCase(),
    conclusion: r.conclusion === null ? null : r.conclusion.toUpperCase(),
    startedAt: r.started_at ?? null,
    completedAt: r.completed_at ?? null,
    detailsUrl: r.html_url ?? r.details_url ?? null,
    isRequired: required.has(r.name),
    checkSuite: { app: r.app ? { slug: r.app.slug } : null, workflowRun: run },
  };
}

/** A combined-status entry as a rollup StatusContext (the latest status per context). */
export function statusNode(s: z.infer<typeof StatusRest>['statuses'][number], required: ReadonlySet<string>) {
  return {
    __typename: 'StatusContext' as const,
    context: s.context,
    state: s.state.toUpperCase(),
    targetUrl: s.target_url ?? null,
    createdAt: s.updated_at ?? s.created_at ?? '1970-01-01T00:00:00Z',
    isRequired: required.has(s.context),
  };
}

const rateFrom = (r: z.infer<typeof RateLimitNode>, now: number): RateBudget | undefined =>
  r
    ? {
        resource: 'graphql',
        limit: r.limit,
        remaining: r.remaining,
        used: r.limit - r.remaining,
        resetAt: Date.parse(r.resetAt) || now,
        observedAt: now,
      }
    : undefined;

export interface PollerOptions {
  gh: Gh;
  repo: RepoRef;
  target: PollTarget;
  /** Epoch ms (for the GraphQL rateLimit budget). */
  now: () => number;
  /** Restored state (ETags, suite map) from a previous process. */
  initial?: PollerState;
}

export function createPoller(o: PollerOptions): Poller {
  const st: PollerState = o.initial
    ? {
        etags: { ...o.initial.etags },
        suites: { ...o.initial.suites },
        suiteLookups: { ...o.initial.suiteLookups },
        rollup: { ...o.initial.rollup },
      }
    : emptyPollerState();
  st.rollup ??= {};
  const rollup = st.rollup;
  /** Dropped: left out of the rollup ROLLUP_MISSES_TO_DROP times in a row (until then it counts). */
  const outside = (id: number): boolean => {
    const m = rollup[String(id)];
    return typeof m === 'number' && m >= ROLLUP_MISSES_TO_DROP;
  };
  /** Membership still to (re)confirm: never looked up, or missed fewer times than the drop threshold. */
  const unsettled = (id: number): boolean => {
    const m = rollup[String(id)];
    return m === undefined || (typeof m === 'number' && m < ROLLUP_MISSES_TO_DROP);
  };
  let mode: 'rest' | 'graphql' = 'rest';
  let restFailures = 0;
  const { gh, repo } = o;

  /** A GET with If-None-Match. A 304 returns the cached body; a cache entry that no longer parses is dropped. */
  async function conditional<S extends z.ZodType>(
    req: ApiRequest,
    schema: S,
    counter: { calls: number; changed: boolean },
    callOpts: Parameters<Gh['api']>[2] = {},
  ): Promise<z.output<S>> {
    const key = etagKey(req);
    let cached = st.etags[key];
    let parsedCache: z.output<S> | undefined;
    if (cached) {
      const p = schema.safeParse(cached.body);
      if (p.success) parsedCache = p.data;
      else {
        delete st.etags[key];
        cached = undefined;
      }
    }
    counter.calls++;
    const r = await gh.api(
      { ...req, ...(cached ? { headers: { ...req.headers, 'If-None-Match': cached.etag } } : {}) },
      schema,
      callOpts,
    );
    if (r.notModified) {
      if (parsedCache !== undefined) return parsedCache;
      // A 304 without a usable cached body (cannot happen unless the cache was edited): read it again.
      delete st.etags[key];
      return conditional(req, schema, counter, callOpts);
    }
    counter.changed = true;
    if (r.etag) st.etags[key] = { etag: r.etag, body: r.data };
    else delete st.etags[key];
    return r.data;
  }

  async function mapSuites(sha: string, ids: readonly number[], counter: { calls: number }): Promise<void> {
    const unknown = ids.filter((id) => !(String(id) in st.suites));
    if (unknown.length === 0 && !ids.some(unsettled)) return;
    counter.calls++;
    const data = await gh.graphql(SUITES_QUERY, { owner: repo.owner, name: repo.name, oid: sha }, SuitesData, {
      repo,
    });
    for (const n of data.repository?.object?.checkSuites?.nodes ?? []) {
      if (n?.databaseId != null) st.suites[String(n.databaseId)] = n.workflowRun;
    }
    const contexts = data.repository?.object?.statusCheckRollup?.contexts;
    const inRollup = new Set(
      (contexts?.nodes ?? []).flatMap((n) => (n?.checkSuite?.databaseId ? [n.checkSuite.databaseId] : [])),
    );
    for (const id of ids.filter(unsettled)) {
      const k = String(id);
      // An incomplete rollup (over 100 contexts) cannot prove a suite absent: it counts.
      if (inRollup.has(id) || !contexts || contexts.pageInfo.hasNextPage) rollup[k] = true;
      else rollup[k] = (typeof rollup[k] === 'number' ? rollup[k] : 0) + 1;
    }
    for (const id of unknown) {
      const k = String(id);
      if (k in st.suites) {
        delete st.suiteLookups[k];
        continue;
      }
      const n = (st.suiteLookups[k] ?? 0) + 1;
      if (n >= MAX_SUITE_LOOKUPS) {
        st.suites[k] = null;
        delete st.suiteLookups[k];
      } else st.suiteLookups[k] = n;
    }
  }

  async function restTick(sha: string | null, required: ReadonlySet<string>): Promise<TickResult> {
    const counter = { calls: 0, changed: false };
    let pull: PullInfo | null = null;
    let headSha: string | null;
    if (o.target.kind === 'pr') {
      pull = pullInfo(
        await conditional({ path: `repos/{owner}/{repo}/pulls/${o.target.number}`, repo }, PullRest, counter, {
          notFound: 'PR_NOT_FOUND',
        }),
      );
      headSha = pull.headSha;
    } else {
      try {
        headSha = (
          await conditional(
            { path: `repos/{owner}/{repo}/branches/${branchPath(o.target.branch)}`, repo },
            BranchRest,
            counter,
            { notFound: 'REF_NOT_FOUND' },
          )
        ).commit.sha;
      } catch (e) {
        rethrowControlFlow(e);
        // A deleted branch: the bound commit's CI can still be read.
        if (!(isNotFound(e) && sha !== null)) throw e;
        headSha = null;
      }
    }
    const target = sha ?? headSha;
    if (target === null) throw new Error('unreachable: no commit to read');
    const runsPath = `repos/{owner}/{repo}/commits/${target}/check-runs`;
    const first = await conditional(
      { path: runsPath, repo, fields: { filter: 'latest', per_page: 100 } },
      CheckRunsRest,
      counter,
    );
    let runs = first.check_runs;
    // Every page is its own conditional GET: page 1's ETag says nothing about pages 2..N.
    for (let page = 2; page <= MAX_CHECK_RUN_PAGES && runs.length < first.total_count; page++) {
      const more = await conditional(
        { path: runsPath, repo, fields: { filter: 'latest', per_page: 100, page } },
        CheckRunsRest,
        counter,
      );
      if (more.check_runs.length === 0) break;
      runs = [...runs, ...more.check_runs];
    }
    const status = await conditional(
      { path: `repos/{owner}/{repo}/commits/${target}/status`, repo, fields: { per_page: 100 } },
      StatusRest,
      counter,
    );
    const suiteIds = [...new Set(runs.flatMap((r) => (r.check_suite ? [r.check_suite.id] : [])))];
    await mapSuites(target, suiteIds, counter);
    const nodes: RollupContext[] = [
      ...runs
        .filter((r) => !(r.check_suite && outside(r.check_suite.id)))
        .map((r) => checkRunNode(r, st.suites, required)),
      ...status.statuses.map((s) => statusNode(s, required)),
    ];
    return {
      pull,
      headSha,
      sha: target,
      nodes,
      source: 'rest',
      notModified: !counter.changed,
      calls: counter.calls,
      budget: gh.rateBudget('core'),
    };
  }

  async function graphqlTick(sha: string | null, required: ReadonlySet<string>): Promise<TickResult> {
    let calls = 0;
    const now = o.now();
    if (o.target.kind === 'pr') {
      const number = o.target.number;
      let rate: RateBudget | undefined;
      let pull: PullInfo | null = null;
      const fetchPage = async (after: string | null) => {
        calls++;
        const d = await gh.graphql(
          FALLBACK_PR_QUERY,
          { owner: repo.owner, name: repo.name, number, after },
          FallbackPrData,
          { repo, notFound: 'PR_NOT_FOUND' },
        );
        const pr = d.repository?.pullRequest;
        if (!pr) throw new GhxError('PR_NOT_FOUND', `PR ${repo.owner}/${repo.name}#${number} was not found.`);
        rate = rateFrom(d.rateLimit, now) ?? rate;
        if (after === null) {
          pull = {
            number: pr.number,
            state: pr.state,
            headSha: pr.headRefOid,
            baseRef: pr.baseRefName,
            defaultBranch: d.repository?.defaultBranchRef?.name ?? null,
          };
        }
        return { headSha: pr.headRefOid, commit: pr.commits.nodes.at(-1)?.commit ?? null };
      };
      const first = await fetchPage(null);
      const head = first.headSha;
      // The PR query reads the head commit only; a binding that stays on an older SHA reads it by oid.
      if (sha !== null && sha !== head) {
        const other = await branchLikeCommit(sha, null);
        calls += other.calls;
        return {
          pull,
          headSha: head,
          sha,
          nodes: other.nodes,
          source: 'graphql',
          notModified: false,
          calls,
          budget: other.rate ?? rate ?? gh.rateBudget('graphql'),
        };
      }
      const done = await completeRollup({ gh, repo, number, headSha: head, firstPage: first.commit, fetchPage });
      return {
        pull,
        headSha: head,
        sha: head,
        nodes: done.forHeadSha ? done.nodes : [],
        source: 'graphql',
        notModified: false,
        calls,
        budget: rate ?? gh.rateBudget('graphql'),
      };
    }
    const branch = o.target.branch;
    const probe = await branchLikeCommit(sha, branch);
    calls += probe.calls;
    return {
      pull: null,
      headSha: probe.head,
      sha: probe.sha,
      nodes: probe.nodes,
      source: 'graphql',
      notModified: false,
      calls,
      budget: probe.rate ?? gh.rateBudget('graphql'),
    };

    /** The CI of one commit by oid (and the branch head, when `branchName` is given). */
    async function branchLikeCommit(
      oid: string | null,
      branchName: string | null,
    ): Promise<{
      head: string | null;
      sha: string;
      nodes: RollupContext[];
      rate: RateBudget | undefined;
      calls: number;
    }> {
      let n = 0;
      let rate: RateBudget | undefined;
      let head: string | null = null;
      let target = oid;
      const page = async (after: string | null) => {
        n++;
        const d = await gh.graphql(
          FALLBACK_BRANCH_QUERY,
          {
            owner: repo.owner,
            name: repo.name,
            qref: `refs/heads/${branchName ?? 'HEAD'}`,
            oid: target ?? '0000000000000000000000000000000000000000',
            after,
          },
          FallbackBranchData,
          { repo },
        );
        rate = rateFrom(d.rateLimit, now) ?? rate;
        if (after === null) head = d.repository?.ref?.target?.oid ?? null;
        const c = d.repository?.object ?? null;
        const commit = c
          ? CiCommit.parse({
              ...c,
              statusCheckRollup: c.statusCheckRollup
                ? {
                    contexts: {
                      ...c.statusCheckRollup.contexts,
                      nodes: c.statusCheckRollup.contexts.nodes.map((x) =>
                        x === null ? null : { isRequired: required.has(String(x.name ?? x.context)), ...x },
                      ),
                    },
                  }
                : null,
            })
          : null;
        return { headSha: target ?? head ?? '', commit };
      };
      let first = await page(null);
      if (target === null) {
        // A fresh branch binding: read the head first, then its CI.
        target = head;
        if (target === null) throw new GhxError('REF_NOT_FOUND', `Branch ${branchName} does not exist.`);
        first = await page(null);
      }
      const done = await completeRollup({
        gh,
        repo,
        number: 0,
        headSha: target,
        firstPage: first.commit,
        fetchPage: page,
      });
      return { head, sha: target, nodes: done.forHeadSha ? done.nodes : [], rate, calls: n };
    }
  }

  return {
    get mode() {
      return mode;
    },
    state: () => st,
    async tick(t) {
      const required = t.required ?? new Set<string>();
      if (mode === 'rest') {
        try {
          const r = await restTick(t.sha, required);
          restFailures = 0;
          return r;
        } catch (e) {
          rethrowControlFlow(e);
          // Not found and rate limits are answers, not flaky transport: the caller handles them.
          if (isNotFound(e) || isRateLimited(e) || !(e instanceof GhFailure)) throw e;
          restFailures++;
          if (restFailures < REST_FAILURES_BEFORE_FALLBACK) throw new TickFailed(e);
          mode = 'graphql';
        }
      }
      return graphqlTick(t.sha, required);
    },
  };
}
