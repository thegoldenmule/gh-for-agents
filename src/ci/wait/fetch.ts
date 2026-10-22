// The gh reads behind the ci wait pure modules (03 M4.1, M4.2, M4.5), on the read-mode client. Each
// helper is one small REST read; selection and math stay in expected.ts, eta.ts and stall.ts.
import { z } from 'zod';
import { rethrowControlFlow } from '../../core/control-flow.ts';
import type { ApiRequest } from '../../gh/api.ts';
import { type Gh, GhFailure } from '../../gh/index.ts';
import type { RepoRef } from '../../gh/types.ts';
import type { JsonCache } from '../cache.ts';
import { listRunJobs } from '../github.ts';
import { type BaselineStats, baselineStats, type JobSamples, needsPullRequestSamples, samplesFromJobs } from './eta.ts';
import {
  type Baseline,
  type BaselineCandidate,
  type BranchRule,
  pickBaseline,
  type RequiredSources,
  rulesRequiredContexts,
} from './expected.ts';

type Warn = (w: { code: string; message: string }) => void;

/** A branch name as a path: each segment encoded, slashes kept. */
export const branchPath = (b: string): string => b.split('/').map(encodeURIComponent).join('/');

const isNotFound = (e: unknown): boolean => e instanceof GhFailure && e.failure.code === 'GH_NOT_FOUND';

async function get<S extends z.ZodType>(gh: Gh, req: ApiRequest, schema: S): Promise<z.output<S>> {
  const r = await gh.api(req, schema);
  if (r.notModified) throw new Error('unreachable: unconditional request returned 304');
  return r.data;
}

/** A GET whose 404 is data (`null`). Control flow and every other failure propagate. */
async function getOrNull<S extends z.ZodType>(gh: Gh, req: ApiRequest, schema: S): Promise<z.output<S> | null> {
  try {
    return await get(gh, req, schema);
  } catch (e) {
    rethrowControlFlow(e);
    if (isNotFound(e)) return null;
    throw e;
  }
}

// ── Required checks (spike §3.2) ──────────────────────────────────────────
const Rule = z.object({
  type: z.string(),
  ruleset_source_type: z.string().nullish(),
  parameters: z
    .object({ required_status_checks: z.array(z.object({ context: z.string() })).nullish() })
    .loose()
    .nullish(),
});

const Branch = z.object({
  commit: z.object({ sha: z.string() }),
  protected: z.boolean().nullish(),
  protection: z
    .object({
      required_status_checks: z
        .object({
          contexts: z.array(z.string()).nullish(),
          checks: z.array(z.object({ context: z.string() })).nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

export interface RequiredFetch {
  sources: RequiredSources;
  /** The base branch head (`branches/<base>.commit.sha`): the lowest-confidence baseline source. */
  baseHeadSha: string | null;
}

/**
 * `GET rules/branches/<base>` and `GET branches/<base>`; never the admin-only `…/protection`. A 404 on
 * rules (missing branch, GHES without rulesets) is an unknown source plus REQUIRED_CHECKS_UNKNOWN.
 */
export async function fetchRequiredSources(o: {
  gh: Gh;
  repo: RepoRef;
  base: string;
  warn?: Warn;
}): Promise<RequiredFetch> {
  const b = branchPath(o.base);
  const rules = await getOrNull(
    o.gh,
    { path: `repos/{owner}/{repo}/rules/branches/${b}`, repo: o.repo, paginate: { maxPages: 3 } },
    z.array(Rule),
  );
  if (rules === null) {
    o.warn?.({
      code: 'REQUIRED_CHECKS_UNKNOWN',
      message: `The rules for ${o.base} could not be read (404); required checks come from branch protection and isRequired only.`,
    });
  }
  const branch = await getOrNull(o.gh, { path: `repos/{owner}/{repo}/branches/${b}`, repo: o.repo }, Branch);
  const rsc = branch?.protection?.required_status_checks;
  return {
    sources: {
      rules: rules === null ? null : rulesRequiredContexts(rules as BranchRule[]),
      branch: branch ? [...new Set([...(rsc?.contexts ?? []), ...(rsc?.checks ?? []).map((c) => c.context)])] : null,
    },
    baseHeadSha: branch?.commit.sha ?? null,
  };
}

// ── Baseline names ────────────────────────────────────────────────────────
const CheckRunsPage = z.object({ check_runs: z.array(z.object({ name: z.string() })) });
const CombinedStatus = z.object({ statuses: z.array(z.object({ context: z.string() })) });

/** Every check name registered on a commit: check runs (latest) plus status contexts. */
export async function fetchCheckNames(o: { gh: Gh; repo: RepoRef; sha: string }): Promise<string[]> {
  const runs = await get(
    o.gh,
    {
      path: `repos/{owner}/{repo}/commits/${o.sha}/check-runs`,
      repo: o.repo,
      fields: { filter: 'latest' },
      paginate: { maxPages: 3, itemsKey: 'check_runs' },
    },
    CheckRunsPage,
  );
  const status = await getOrNull(
    o.gh,
    { path: `repos/{owner}/{repo}/commits/${o.sha}/status`, repo: o.repo, fields: { per_page: 100 } },
    CombinedStatus,
  );
  return [...new Set([...runs.check_runs.map((r) => r.name), ...(status?.statuses ?? []).map((s) => s.context)])];
}

/** The PR's commit SHAs, oldest first (bounded to 300). */
export async function fetchPrCommits(o: { gh: Gh; repo: RepoRef; number: number }): Promise<string[]> {
  const commits = await get(
    o.gh,
    { path: `repos/{owner}/{repo}/pulls/${o.number}/commits`, repo: o.repo, paginate: { maxPages: 3 } },
    z.array(z.object({ sha: z.string() })),
  );
  return commits.map((c) => c.sha);
}

/** The first parent of a commit (a branch target's previous commit), or null for a root commit. */
export async function fetchCommitParent(o: { gh: Gh; repo: RepoRef; sha: string }): Promise<string | null> {
  const c = await get(
    o.gh,
    { path: `repos/{owner}/{repo}/commits/${o.sha}`, repo: o.repo },
    z.object({ parents: z.array(z.object({ sha: z.string() })) }),
  );
  return c.parents[0]?.sha ?? null;
}

const ClosedPr = z.object({
  number: z.number().int(),
  merged_at: z.string().nullable(),
  head: z.object({ sha: z.string() }),
});

/** The head SHA of the most recently updated merged PR into `base` (one page of 20), excluding `excludeNumber`. */
export async function fetchLastMergedPrHead(o: {
  gh: Gh;
  repo: RepoRef;
  base: string;
  excludeNumber?: number;
}): Promise<string | null> {
  const prs = await get(
    o.gh,
    {
      path: 'repos/{owner}/{repo}/pulls',
      repo: o.repo,
      fields: { state: 'closed', base: o.base, sort: 'updated', direction: 'desc', per_page: 20 },
    },
    z.array(ClosedPr),
  );
  return prs.find((p) => p.merged_at !== null && p.number !== o.excludeNumber)?.head.sha ?? null;
}

/** The PR's changed paths (renames give both names), or null when GitHub's 3 000-file listing is truncated. */
export async function fetchChangedFiles(o: { gh: Gh; repo: RepoRef; number: number }): Promise<string[] | null> {
  const r = await o.gh.api(
    { path: `repos/{owner}/{repo}/pulls/${o.number}/files`, repo: o.repo, paginate: { maxPages: 30 } },
    z.array(z.object({ filename: z.string(), previous_filename: z.string().nullish() })),
    { notFound: 'PR_NOT_FOUND' },
  );
  if (r.notModified) throw new Error('unreachable: unconditional request returned 304');
  if (r.truncated) return null;
  return [...new Set(r.data.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename])))];
}

export const BASELINE_TTL_MS = 24 * 60 * 60_000;

const CachedBaseline = z
  .object({
    source: z.enum(['previous-head', 'last-merged-pr', 'base-head']),
    sha: z.string(),
    confidence: z.enum(['high', 'medium', 'low']),
    names: z.array(z.string()),
  })
  .nullable();

/**
 * The baseline names (02 §11.3), lazily in priority order: each previous-head candidate (newest
 * first), then the last merged PR's head, then the base head. The first commit with any registered
 * check wins; the result (or its absence) is cached for 24 h per base and head.
 */
export async function fetchBaseline(o: {
  gh: Gh;
  repo: RepoRef;
  base: string;
  headSha: string;
  /** From previousHeadCandidates(fetchPrCommits(…)) or [fetchCommitParent(…)]. */
  previousHeads: readonly string[];
  /** The PR itself, excluded from "last merged PR". */
  number?: number;
  /** From fetchRequiredSources; fetched when undefined. */
  baseHeadSha?: string | null;
  cache?: JsonCache;
}): Promise<Baseline | null> {
  const key = `baseline:${o.base}:${o.headSha}`;
  const hit = o.cache?.get(key, CachedBaseline);
  if (hit !== undefined) return hit;
  const tried: BaselineCandidate[] = [];
  const attempt = async (source: BaselineCandidate['source'], sha: string | null): Promise<Baseline | null> => {
    if (sha === null || sha === o.headSha) return null;
    tried.push({ source, sha, names: await fetchCheckNames({ gh: o.gh, repo: o.repo, sha }) });
    return pickBaseline(tried);
  };
  let found: Baseline | null = null;
  for (const sha of o.previousHeads) {
    found = await attempt('previous-head', sha);
    if (found) break;
  }
  if (!found) {
    const merged = await fetchLastMergedPrHead({
      gh: o.gh,
      repo: o.repo,
      base: o.base,
      ...(o.number !== undefined ? { excludeNumber: o.number } : {}),
    });
    found = await attempt('last-merged-pr', merged);
  }
  if (!found) {
    const baseHead =
      o.baseHeadSha !== undefined
        ? o.baseHeadSha
        : ((
            await getOrNull(o.gh, { path: `repos/{owner}/{repo}/branches/${branchPath(o.base)}`, repo: o.repo }, Branch)
          )?.commit.sha ?? null);
    found = await attempt('base-head', baseHead);
  }
  o.cache?.set(key, found, BASELINE_TTL_MS);
  return found;
}

// ── ETA samples (02 §11.6) ────────────────────────────────────────────────
export const ETA_TTL_MS = 24 * 60 * 60_000;
/** Runs whose jobs are sampled, per event. */
export const ETA_SAMPLE_RUNS = 3;

const SampleRun = z.object({
  id: z.number().int(),
  pull_requests: z.array(z.object({ base: z.object({ ref: z.string() }) })).nullish(),
});
const SampleRunsPage = z.object({ workflow_runs: z.array(SampleRun) });
const Sample = z.object({ durationSec: z.number(), queueSec: z.number().nullable() });
const CachedSamples = z.object({
  push: z.record(z.string(), z.array(Sample)),
  pullRequest: z.record(z.string(), z.array(Sample)).nullable(),
});

async function sampleRuns(
  o: { gh: Gh; repo: RepoRef; workflowId: number },
  fields: Record<string, string | number>,
): Promise<z.output<typeof SampleRun>[]> {
  return (
    await get(
      o.gh,
      { path: `repos/{owner}/{repo}/actions/workflows/${o.workflowId}/runs`, repo: o.repo, fields },
      SampleRunsPage,
    )
  ).workflow_runs;
}

async function samplesOf(o: { gh: Gh; repo: RepoRef }, runIds: readonly number[]): Promise<JobSamples> {
  const out: JobSamples = {};
  for (const runId of runIds) {
    for (const [name, xs] of Object.entries(samplesFromJobs(await listRunJobs({ gh: o.gh, repo: o.repo, runId })))) {
      out[name] = [...(out[name] ?? []), ...xs];
    }
  }
  return out;
}

/**
 * Baseline stats for one workflow's jobs: ≤10 successful push runs on the base (jobs of the newest 3),
 * and, only when a job name is missing there, ≤10 successful pull_request runs into the base. The raw
 * samples are cached for 24 h per repo, workflow and base.
 */
export async function fetchEtaStats(o: {
  gh: Gh;
  repo: RepoRef;
  base: string;
  workflowId: number;
  /** The PR's job names in this workflow. */
  jobNames: readonly string[];
  cache?: JsonCache;
}): Promise<BaselineStats> {
  const key = `eta:${o.workflowId}:${o.base}`;
  let s = o.cache?.get(key, CachedSamples);
  let dirty = false;
  if (!s) {
    const runs = await sampleRuns(o, { branch: o.base, event: 'push', status: 'success', per_page: 10 });
    s = {
      push: await samplesOf(
        o,
        runs.slice(0, ETA_SAMPLE_RUNS).map((r) => r.id),
      ),
      pullRequest: null,
    };
    dirty = true;
  }
  if (s.pullRequest === null && needsPullRequestSamples(o.jobNames, s.push)) {
    const runs = (await sampleRuns(o, { event: 'pull_request', status: 'success', per_page: 10 })).filter((r) =>
      (r.pull_requests ?? []).some((p) => p.base.ref === o.base),
    );
    s = {
      ...s,
      pullRequest: await samplesOf(
        o,
        runs.slice(0, ETA_SAMPLE_RUNS).map((r) => r.id),
      ),
    };
    dirty = true;
  }
  if (dirty) o.cache?.set(key, s, ETA_TTL_MS);
  return baselineStats(o.jobNames, s.push, s.pullRequest ?? {});
}
