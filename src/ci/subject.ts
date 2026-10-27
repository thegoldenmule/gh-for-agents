// The CI a ci why or ci rerun target names (02 §12, §13.1), read once: a PR's checks through the rollup
// for its head SHA [G-SHA]; a run's jobs through actions/runs/{id}/jobs; a branch's head commit as every
// workflow's newest run on that commit and branch, with their jobs. Non-PR subjects carry Actions checks
// only (commit statuses come with a PR's rollup).
import { z } from 'zod';
import type { Context } from '../core/command.ts';
import type { Gh } from '../gh/index.ts';
import { formatPrRef } from '../gh/refs.ts';
import { enrichNotFound, type ResolvedRepo } from '../gh/repo.ts';
import type { RepoRef } from '../gh/types.ts';
import type { Check, CiSummary } from '../schemas/ci.ts';
import { checkRunBucket, checkRunStatus, ignoreRuleFor, normaliseContext, type WorkflowRunInfo } from './checks.ts';
import { type ActionsJob, ActionsRun, fetchRun, listRunJobs } from './github.ts';
import { invalidFromRun, invalidRunNode, invalidRunWarning, isInvalidRun } from './invalid-runs.ts';
import { fetchCiSnapshot, snapshotSummary } from './snapshot.ts';
import { summariseCi } from './summary.ts';
import { branchPath } from './wait/fetch.ts';
import { type CiTarget, targetArg } from './wait/targets.ts';

type IgnoreRules = Parameters<typeof ignoreRuleFor>[1];

/** Workflows read for a branch head: one run each (the newest), at most this many. */
export const BRANCH_MAX_RUNS = 20;

/** What ci why and ci rerun need, from a PR rollup, one run, or a branch head's runs. */
export interface Subject {
  /** owner/repo#N for a PR; null otherwise. */
  ref: string | null;
  /** The target as a ghx argument for `next` and hints: owner/repo#N, `run:<id> -R o/r`, `branch:<name>@<sha> -R o/r`. */
  arg: string;
  /** The display form every output carries: owner/repo#N, run:<id> or branch:<name>@<sha7>. */
  target: string;
  headSha: string;
  defaultBranch: string;
  summary: CiSummary;
  checks: Check[];
  runs: Record<string, Pick<WorkflowRunInfo, 'workflowId'>>;
  /** Job lists already read (run and branch subjects), so key steps need no second call. */
  jobsByRun: Map<number, ActionsJob[]>;
  /** Run rows already read (run and branch subjects), so ci rerun needs no second call. */
  runRows: Map<number, ActionsRun>;
}

const RepoInfo = z.object({ default_branch: z.string() });
const BranchInfo = z.object({ commit: z.object({ sha: z.string() }) });
const CommitInfo = z.object({ sha: z.string() });
const RunsPage = z.object({ total_count: z.number().int(), workflow_runs: z.array(ActionsRun) });

export async function defaultBranchOf(gh: Gh, repo: RepoRef): Promise<string> {
  const r = await gh.api({ path: 'repos/{owner}/{repo}', repo }, RepoInfo, { notFound: 'REPO_NOT_FOUND' });
  if (r.notModified) throw new Error('unreachable: unconditional request returned 304');
  return r.data.default_branch;
}

/** A jobs-API row as a Check (the shape the rollup gives a PR). */
export function jobCheck(j: ActionsJob, repo: RepoRef): Check {
  return {
    name: j.name,
    workflow: j.workflow_name ?? null,
    kind: 'actions',
    bucket: checkRunBucket(j.status, j.conclusion),
    status: checkRunStatus(j.status),
    conclusion: j.conclusion,
    required: false,
    runId: j.run_id,
    jobId: j.id,
    attempt: j.run_attempt ?? null,
    url: j.html_url ?? `https://${repo.host}/${repo.owner}/${repo.name}/actions/runs/${j.run_id}/job/${j.id}`,
    startedAt: j.started_at ?? null,
    completedAt: j.completed_at ?? null,
  };
}

/** Read the subject a parsed target names. */
export async function readSubject(
  ctx: Context,
  resolved: ResolvedRepo,
  target: CiTarget,
  ignore: IgnoreRules,
): Promise<Subject> {
  if (target.kind === 'pr') return prSubject(ctx, resolved, target.number, ignore);
  if (target.kind === 'run') return runSubject(ctx, resolved, target, ignore);
  return branchSubject(ctx, resolved, target, ignore);
}

async function prSubject(ctx: Context, resolved: ResolvedRepo, number: number, ignore: IgnoreRules): Promise<Subject> {
  let snapshot: Awaited<ReturnType<typeof fetchCiSnapshot>>;
  try {
    snapshot = await fetchCiSnapshot({ gh: ctx.gh, repo: resolved.repo, number, ignore, warn: ctx.warn });
  } catch (e) {
    throw enrichNotFound(e, resolved, `PR #${number}`);
  }
  const ref = formatPrRef(resolved.repo, snapshot.number);
  return {
    ref,
    arg: ref,
    target: ref,
    headSha: snapshot.headSha,
    defaultBranch: snapshot.defaultBranch,
    summary: snapshotSummary(snapshot),
    checks: snapshot.checks,
    runs: snapshot.runs,
    jobsByRun: new Map(),
    runRows: new Map(),
  };
}

/**
 * Runs GitHub rejected before any job ran (no job, failed), each as the red check the rollup path makes
 * (invalid-runs.ts), warned WORKFLOW_INVALID.
 */
function rejectedChecks(
  ctx: Pick<Context, 'warn'>,
  repo: RepoRef,
  headSha: string,
  runs: Map<number, ActionsJob[]>,
  rows: Iterable<ActionsRun>,
): Check[] {
  const out: Check[] = [];
  for (const run of rows) {
    if (!isInvalidRun(run.status, run.conclusion, runs.get(run.id)?.length ?? 0)) continue;
    const c = normaliseContext(invalidRunNode(invalidFromRun(run, repo)), { repo, headSha }).check;
    ctx.warn(invalidRunWarning(c));
    out.push(c);
  }
  return out;
}

/** Checks from job lists (plus rejected runs), ci.ignore applied, with the summary over them. */
function fromJobs(
  repo: RepoRef,
  headSha: string,
  jobs: readonly ActionsJob[],
  ignore: IgnoreRules,
  rejected: readonly Check[] = [],
) {
  const all = [...jobs.map((j) => jobCheck(j, repo)), ...rejected];
  const checks = all.filter((c) => !ignoreRuleFor(c, ignore));
  const ignored = all.filter((c) => ignoreRuleFor(c, ignore)).map((c) => c.name);
  return { checks, summary: summariseCi({ headSha, checks, ignored }) };
}

async function runSubject(
  ctx: Context,
  resolved: ResolvedRepo,
  target: Extract<CiTarget, { kind: 'run' }>,
  ignore: IgnoreRules,
): Promise<Subject> {
  const { repo } = resolved;
  const { runId } = target;
  let run: ActionsRun;
  let jobs: ActionsJob[];
  try {
    run = await fetchRun({ gh: ctx.gh, repo, runId });
    jobs = await listRunJobs({ gh: ctx.gh, repo, runId });
  } catch (e) {
    throw enrichNotFound(e, resolved, `Run ${runId}`);
  }
  return {
    ref: null,
    arg: targetArg(target, repo),
    target: target.raw,
    headSha: run.head_sha,
    defaultBranch: await defaultBranchOf(ctx.gh, repo),
    ...fromJobs(
      repo,
      run.head_sha,
      jobs,
      ignore,
      rejectedChecks(ctx, repo, run.head_sha, new Map([[runId, jobs]]), [run]),
    ),
    runs: { [String(runId)]: { workflowId: run.workflow_id } },
    jobsByRun: new Map([[runId, jobs]]),
    runRows: new Map([[runId, run]]),
  };
}

/**
 * A branch head (or the pinned commit): each workflow's newest run on that commit and branch, so a
 * re-triggered workflow counts once and a PR run that shares the commit does not count.
 */
async function branchSubject(
  ctx: Context,
  resolved: ResolvedRepo,
  target: Extract<CiTarget, { kind: 'branch' }>,
  ignore: IgnoreRules,
): Promise<Subject> {
  const { repo } = resolved;
  let headSha: string;
  try {
    if (target.sha === null) {
      const r = await ctx.gh.api(
        { path: `repos/{owner}/{repo}/branches/${branchPath(target.branch)}`, repo },
        BranchInfo,
        { notFound: 'REF_NOT_FOUND' },
      );
      if (r.notModified) throw new Error('unreachable: unconditional request returned 304');
      headSha = r.data.commit.sha;
    } else {
      const r = await ctx.gh.api({ path: `repos/{owner}/{repo}/commits/${target.sha}`, repo }, CommitInfo, {
        notFound: 'REF_NOT_FOUND',
      });
      if (r.notModified) throw new Error('unreachable: unconditional request returned 304');
      headSha = r.data.sha;
    }
  } catch (e) {
    throw enrichNotFound(e, resolved, target.sha === null ? `Branch ${target.branch}` : `Commit ${target.sha}`);
  }
  const page = await ctx.gh.api(
    {
      path: 'repos/{owner}/{repo}/actions/runs',
      repo,
      fields: { head_sha: headSha, branch: target.branch, per_page: 100 },
    },
    RunsPage,
  );
  if (page.notModified) throw new Error('unreachable: unconditional request returned 304');
  const newest = new Map<number, ActionsRun>();
  for (const run of page.data.workflow_runs) {
    const seen = newest.get(run.workflow_id);
    if (!seen || run.id > seen.id) newest.set(run.workflow_id, run);
  }
  const rows = [...newest.values()].sort((a, b) => b.id - a.id).slice(0, BRANCH_MAX_RUNS);
  const jobsByRun = new Map<number, ActionsJob[]>();
  for (const run of rows) jobsByRun.set(run.id, await listRunJobs({ gh: ctx.gh, repo, runId: run.id }));
  const pinned = { ...target, raw: `branch:${target.branch}@${headSha.slice(0, 7)}`, sha: headSha.slice(0, 7) };
  return {
    ref: null,
    arg: targetArg(pinned, repo),
    target: pinned.raw,
    headSha,
    defaultBranch: await defaultBranchOf(ctx.gh, repo),
    ...fromJobs(
      repo,
      headSha,
      [...jobsByRun.values()].flat(),
      ignore,
      rejectedChecks(ctx, repo, headSha, jobsByRun, rows),
    ),
    runs: Object.fromEntries(rows.map((r) => [String(r.id), { workflowId: r.workflow_id }])),
    jobsByRun,
    runRows: new Map(rows.map((r) => [r.id, r])),
  };
}
