// The shared CI-summary composition (04; 02 §4.3 steps 6–7), called by pr status, pr merge and ci wait
// --until mergeable so merge.ready has one set of inputs.
// - Quiet (settled ≥ EXPECT_GRACE_MS ago): no REST call, no baseline, `eta: null`. Otherwise required
//   sources, baseline and ETA samples are read via ci wait's helpers, cached under PR_CI_CACHE_NS.
// - Baselines age to `absent` after the grace (02 §11.3) unless the caller passes `agedOut`.
// - Shared-with-main: ≤5 failing Actions checks, no flake signals (02 §14.5); uncompared stays null.
import { z } from 'zod';
import { repoCache } from '../ci/cache.ts';
import type { IgnoreRule } from '../ci/checks.ts';
import { createMainComparer } from '../ci/compare-main.ts';
import {
  comparisonFacts,
  DIAGNOSIS_LOG_TIMEOUT_MS,
  DIAGNOSIS_MAX_JOBS,
  diagnosisOrder,
  isDiagnosable,
} from '../ci/diagnose.ts';
import { findSuspicious } from '../ci/key-steps.ts';
import { analyzeJob } from '../ci/logs/analyze.ts';
import { type CiSnapshot, snapshotSummary } from '../ci/snapshot.ts';
import { isRed } from '../ci/summary.ts';
import { type BaselineStats, computeEta } from '../ci/wait/eta.ts';
import {
  type Baseline,
  buildExpectedSet,
  type ConfigExpectedEntry,
  configExpected,
  expectedState,
  previousHeadCandidates,
  type RequiredSources,
  requiredChecks,
  satisfies,
} from '../ci/wait/expected.ts';
import {
  fetchBaseline,
  fetchChangedFiles,
  fetchEtaStats,
  fetchPrCommits,
  fetchRequiredSources,
} from '../ci/wait/fetch.ts';
import type { ArtifactStore } from '../core/artifacts.ts';
import type { Clock } from '../core/clock.ts';
import { rethrowControlFlow } from '../core/control-flow.ts';
import type { Gh } from '../gh/index.ts';
import type { RepoRef } from '../gh/types.ts';
import type { CiFacts } from '../policy/merge.ts';
import type { Check, CiSummary, ExpectedCheck, SameOnMain } from '../schemas/ci.ts';
import type { Warning } from '../schemas/common.ts';

/** The repoCache namespace for the required sources, baselines and ETA samples read here. */
export const PR_CI_CACHE_NS = 'ci-expected';
/** How long the required-check sources of a base branch are reused. */
export const REQUIRED_TTL_MS = 60 * 60_000;
/** 02 §11.4's diagnosis budget also bounds the comparison pass. */
export const COMPARE_BUDGET_MS = 60_000;
/** 02 §11.3 `--expect-grace`: a missing baseline check ages to `absent` this long after the rest settled. */
export const EXPECT_GRACE_MS = 90_000;

/** The ci.* keys read here (GhxConfig['ci'] satisfies it). */
export interface CiSummaryConfig {
  ignore: readonly IgnoreRule[];
  expected?: readonly ConfigExpectedEntry[] | undefined;
  keySteps?: readonly string[] | undefined;
  logPatterns?: readonly string[] | undefined;
}

export interface CiSummaryOptions {
  gh: Gh;
  artifacts: ArtifactStore;
  clock: Clock;
  repo: RepoRef;
  /** owner/repo#N, for `next`. */
  ref: string;
  number: number;
  /** The PR base branch (expected set and ETA baselines are per base). */
  base: string;
  /** PrSnapshot.ci. */
  ci: CiSnapshot;
  config: CiSummaryConfig;
  /** false: no shared-with-main pass (`--no-compare-main`); failing checks keep sameOnMain null. */
  compareMain?: boolean;
  /** The comparison budget (default COMPARE_BUDGET_MS); pass less near a deadline. */
  compareBudgetMs?: number;
  /** Baseline names a stateful caller (ci wait) has aged out itself; replaces the grace rule. */
  agedOut?: readonly string[];
  warn: (w: Warning) => void;
}

export interface CiSummaryResult {
  summary: CiSummary;
  facts: CiFacts;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function optional<T>(o: CiSummaryOptions, what: string, fallback: T, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    rethrowControlFlow(e);
    o.warn({ code: 'CI_DETAIL_UNAVAILABLE', message: `${what} could not be read: ${messageOf(e)}` });
    return fallback;
  }
}

/** Epoch ms of the last completion, or null while anything is pending (or nothing reported). */
function settledAt(checks: readonly Check[]): number | null {
  if (checks.length === 0 || checks.some((c) => c.bucket === 'pending')) return null;
  const times = checks.map((c) => (c.completedAt ? Date.parse(c.completedAt) : Number.NaN)).filter(Number.isFinite);
  return times.length > 0 ? Math.max(...times) : 0;
}

const CachedRequired = z.object({ rules: z.array(z.string()).nullable(), branch: z.array(z.string()).nullable() });

async function expectedSet(o: CiSummaryOptions, quiet: boolean, graceOver: boolean): Promise<ExpectedCheck[]> {
  const checks = o.ci.checks;
  const entries = o.config.expected ?? [];
  const unreported = entries.some(
    (e) => e.paths && !checks.some((c) => satisfies({ name: e.name, workflow: e.workflow ?? null }, c)),
  );
  const changedFiles = unreported
    ? await optional(o, 'The changed files', null, () =>
        fetchChangedFiles({ gh: o.gh, repo: o.repo, number: o.number }),
      )
    : null;
  let sources: RequiredSources = { rules: null, branch: null };
  let baseline: Baseline | null = null;
  if (!quiet) {
    const cache = await repoCache({ artifacts: o.artifacts, repo: o.repo, clock: o.clock, ns: PR_CI_CACHE_NS });
    const key = `required:${o.base}`;
    const hit = cache.get(key, CachedRequired);
    let baseHeadSha: string | null | undefined;
    if (hit) {
      sources = hit;
    } else {
      const fetched = await optional(o, `The required checks for ${o.base}`, null, () =>
        fetchRequiredSources({ gh: o.gh, repo: o.repo, base: o.base, warn: o.warn }),
      );
      if (fetched) {
        const { rules, branch } = fetched.sources;
        sources = { rules: rules ? [...rules] : null, branch: branch ? [...branch] : null };
        baseHeadSha = fetched.baseHeadSha;
        cache.set(key, sources, REQUIRED_TTL_MS);
      }
    }
    baseline = await optional(o, 'The baseline checks', null, async () => {
      const commits = await fetchPrCommits({ gh: o.gh, repo: o.repo, number: o.number });
      return fetchBaseline({
        gh: o.gh,
        repo: o.repo,
        base: o.base,
        headSha: o.ci.headSha,
        previousHeads: previousHeadCandidates(commits, o.ci.headSha),
        number: o.number,
        ...(baseHeadSha !== undefined ? { baseHeadSha } : {}),
        cache,
      });
    });
  }
  const defs = buildExpectedSet({
    required: requiredChecks(sources, checks),
    config: configExpected(entries, changedFiles),
    baseline,
    ignore: o.config.ignore,
  });
  const agedOut = o.agedOut ?? (graceOver ? defs.filter((d) => d.source === 'baseline').map((d) => d.name) : []);
  return expectedState(defs, checks, agedOut);
}

async function etaOf(o: CiSummaryOptions, pending: readonly Check[]): Promise<CiSummary['eta']> {
  const byWorkflow = new Map<number, string[]>();
  for (const c of pending) {
    const wf = c.runId === null ? null : (o.ci.runs[String(c.runId)]?.workflowId ?? null);
    if (c.kind !== 'actions' || wf === null) continue;
    byWorkflow.set(wf, [...(byWorkflow.get(wf) ?? []), c.name]);
  }
  if (byWorkflow.size === 0) return null;
  const cache = await repoCache({ artifacts: o.artifacts, repo: o.repo, clock: o.clock, ns: PR_CI_CACHE_NS });
  const stats: BaselineStats = {};
  for (const [workflowId, jobNames] of byWorkflow) {
    Object.assign(
      stats,
      await optional(o, `The ETA baseline of workflow ${workflowId}`, {}, () =>
        fetchEtaStats({ gh: o.gh, repo: o.repo, base: o.base, workflowId, jobNames, cache }),
      ),
    );
  }
  return computeEta(pending, stats, o.clock.now()).eta;
}

interface Compared {
  sameOnMain: SameOnMain;
  /** The jobs API's run_attempt (the rollup has none). */
  attempt: number | null;
}

/** Shared-with-main verdicts for up to DIAGNOSIS_MAX_JOBS failing Actions checks, keyed by job id. */
async function compareFailing(o: CiSummaryOptions, failing: readonly Check[]): Promise<Map<number, Compared>> {
  const out = new Map<number, Compared>();
  const all = diagnosisOrder(failing.filter(isDiagnosable));
  const picked = all.slice(0, DIAGNOSIS_MAX_JOBS);
  if (picked.length === 0) return out;
  if (all.length > picked.length) {
    o.warn({
      code: 'COMPARE_MAIN_PARTIAL',
      message: `Only ${picked.length} of ${all.length} failing jobs were compared with ${o.ci.defaultBranch}; ghx ci why ${o.ref} --job '<name>' covers the rest.`,
    });
  }
  const comparer = createMainComparer({
    gh: o.gh,
    artifacts: o.artifacts,
    clock: o.clock,
    repo: o.repo,
    defaultBranch: o.ci.defaultBranch,
    prHeadSha: o.ci.headSha,
    ...(o.config.logPatterns ? { logPatterns: o.config.logPatterns } : {}),
    warn: o.warn,
  });
  // Sequential: two jobs may share a main job's log, and the second must hit the comparer's disk cache.
  const work = (async () => {
    for (const c of picked) {
      try {
        const analysis = await analyzeJob({
          gh: o.gh,
          artifacts: o.artifacts,
          repo: o.repo,
          jobId: c.jobId,
          ...(o.config.logPatterns ? { logPatterns: o.config.logPatterns } : {}),
          timeoutMs: DIAGNOSIS_LOG_TIMEOUT_MS,
        });
        for (const w of analysis.warnings) o.warn({ code: w.code, message: `${c.name}: ${w.message}` });
        const workflowId = o.ci.runs[String(c.runId)]?.workflowId ?? null;
        const sameOnMain = await comparer.compare({
          ...comparisonFacts(analysis, workflowId),
          name: c.name,
          runId: c.runId,
        });
        out.set(c.jobId, { sameOnMain, attempt: analysis.job.run_attempt ?? c.attempt });
      } catch (e) {
        rethrowControlFlow(e);
        o.warn({
          code: 'DIAGNOSIS_INCOMPLETE',
          message: `${c.name}: ${o.ci.defaultBranch} comparison failed: ${messageOf(e)}`,
        });
      }
    }
  })();
  const budgetMs = Math.max(0, o.compareBudgetMs ?? COMPARE_BUDGET_MS);
  const timer = new AbortController();
  const budget = o.clock.sleep(budgetMs, timer.signal).then(
    () => 'expired' as const,
    () => 'cancelled' as const,
  );
  try {
    if ((await Promise.race([work.then(() => 'done' as const), budget])) === 'expired') {
      work.catch(() => {});
      o.warn({
        code: 'DIAGNOSIS_PARTIAL',
        message: `The ${o.ci.defaultBranch} comparison ran out of time (${Math.round(budgetMs / 1000)} s); unfinished failing checks have sameOnMain null.`,
      });
    }
  } finally {
    timer.abort();
  }
  // A copy, so comparisons finishing after an overrun cannot change what the caller returned.
  return new Map(out);
}

const WorkflowsPage = z.object({ total_count: z.number().int() });

/** CiFacts for evaluateMerge (02 §8.2 rows 10b and 12). */
async function ciFacts(o: CiSummaryOptions, summary: CiSummary): Promise<CiFacts> {
  const workflowsTotal =
    summary.state === 'no-checks'
      ? await optional(o, 'The workflow list', null, async () => {
          const r = await o.gh.api(
            { path: 'repos/{owner}/{repo}/actions/workflows', repo: o.repo, fields: { per_page: 1 } },
            WorkflowsPage,
          );
          return r.notModified ? null : r.data.total_count;
        })
      : null;
  const keySteps = o.config.keySteps ?? [];
  if (keySteps.length === 0) return { workflowsTotal, keyStepsSkipped: [] };
  const runIds = [...new Set(o.ci.checks.flatMap((c) => (c.kind === 'actions' && c.runId !== null ? [c.runId] : [])))];
  const found = await findSuspicious({ gh: o.gh, repo: o.repo, runIds, keySteps, warn: o.warn });
  return { workflowsTotal, keyStepsSkipped: found.map((s) => ({ job: s.job, step: s.step })) };
}

/** The full CiSummary and the policy's CiFacts for a PR snapshot's CI part. */
export async function buildCiSummary(o: CiSummaryOptions): Promise<CiSummaryResult> {
  const s = o.ci;
  if (!s.forHeadSha) {
    return {
      summary: snapshotSummary(s, { next: [`ghx ci wait ${o.ref}`] }),
      facts: { workflowsTotal: null, keyStepsSkipped: null },
    };
  }
  const pending = s.checks.filter((c) => c.bucket === 'pending');
  const at = settledAt(s.checks);
  const graceOver = at !== null && o.clock.now() - at >= EXPECT_GRACE_MS;
  const expected = await expectedSet(o, graceOver, graceOver);
  const summary = snapshotSummary(s, { expected, eta: pending.length > 0 ? await etaOf(o, pending) : null });
  const red = s.checks.filter(isRed);
  if (o.compareMain !== false && red.length > 0) {
    const verdicts = await compareFailing(o, red);
    summary.failing = summary.failing.map((f) => {
      const v = f.jobId !== null ? verdicts.get(f.jobId) : undefined;
      return v ? { ...f, attempt: v.attempt, sameOnMain: v.sameOnMain } : f;
    });
  }
  if (summary.state === 'red') summary.next.push(`ghx ci why ${o.ref}`);
  else if (summary.state !== 'green') summary.next.push(`ghx ci wait ${o.ref}`);
  return { summary, facts: await ciFacts(o, summary) };
}
