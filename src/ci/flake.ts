// Flake signals (02 §11.8; 03 M2.6). Read-only: only `ci rerun --flaky` reruns anything.
// - same-sha-passed: the same-named job passed on an earlier attempt, or in another run on this commit.
// - main-intermittent: a failing test whose pass/fail sequence over recent main push runs changes at
//   least twice; ≤5 failed main runs are parsed (cached by job id).
// - known-flaky: ci.knownFlaky. infra-error: INFRA_PATTERNS plus ci.infraPatterns.
// - no-runner: the job ended before any runner picked it up (isNoRunner): no step ran and there is no
//   log. Infrastructure, so a rerun is the fix; the diagnosis engine sets it without reading anything.
// Score: high = same-sha-passed, infra-error or no-runner; medium = main-intermittent or known-flaky;
// otherwise none. 02 names `low`, but no rule produces it. gh-backed checks are skipped once they cannot
// change the score.
import type { Gh } from '../gh/index.ts';
import type { RepoRef } from '../gh/types.ts';
import type { Flake } from '../schemas/ci.ts';
import type { MainComparer } from './compare-main.ts';
import { type ActionsJob, type ActionsRun, listRunJobs, listRunsForSha, listWorkflowRuns } from './github.ts';
import { compilePatterns } from './logs/extract/generic.ts';
import { capLine } from './logs/extract/index.ts';

export type FlakeSignal = Flake['signals'][number];

export interface KnownFlakyRule {
  job: string;
  test?: string | undefined;
}

export const INFRA_PATTERNS: readonly { label: string; re: RegExp }[] = [
  { label: 'runner shutdown', re: /The runner has received a shutdown signal|lost communication with the server/i },
  { label: 'ECONNRESET', re: /\bECONNRESET\b/ },
  { label: '429 Too Many Requests', re: /\b429 Too Many Requests\b/i },
  { label: 'No space left on device', re: /No space left on device/i },
];

/** At most this many failed main runs have their logs parsed for main-intermittent. */
export const MAX_FAILED_MAIN_RUNS = 5;
/** At most this many earlier attempts / sibling runs are checked for same-sha-passed. */
export const MAX_SAME_SHA_LOOKUPS = 3;

// ── Pure parts ──────────────────────────────────────────────────────────────
export function scoreFlake(signals: readonly FlakeSignal[]): Flake {
  const kinds = new Set(signals.map((s) => s.kind));
  const score =
    kinds.has('same-sha-passed') || kinds.has('infra-error') || kinds.has('no-runner')
      ? 'high'
      : kinds.has('main-intermittent') || kinds.has('known-flaky')
        ? 'medium'
        : 'none';
  return { candidate: score === 'high' || score === 'medium', score, signals: [...signals] };
}

export function detectInfraError(lines: readonly string[], extra: readonly string[] = []): FlakeSignal | null {
  const custom = compilePatterns(extra).map((re) => ({ label: `ci.infraPatterns ${re.source}`, re }));
  for (const l of lines) {
    const hit = [...INFRA_PATTERNS, ...custom].find((p) => p.re.test(l));
    if (hit) return { kind: 'infra-error', detail: capLine(`${hit.label}: ${l.trim()}`) };
  }
  return null;
}

/** no-runner for a job isNoRunner matched: how long it waited, and what to check if a rerun does not help. */
export function noRunnerSignal(
  j: Pick<ActionsJob, 'name' | 'conclusion' | 'created_at' | 'completed_at' | 'labels'>,
): FlakeSignal {
  const waited = elapsed(j.created_at, j.completed_at);
  const labels = (j.labels ?? []).join(', ');
  return {
    kind: 'no-runner',
    detail: capLine(
      `${j.name} never got a runner: ${j.conclusion ?? 'cancelled'}${waited ? ` after ${waited} queued` : ''}, ` +
        `before any step ran, so there is no log. Rerun it; if it repeats, check its runs-on labels${labels ? ` (${labels})` : ''}.`,
    ),
  };
}

/** `15m`, `40s`; '' when either end is unknown. */
function elapsed(from: string | null | undefined, to: string | null | undefined): string {
  const ms = from && to ? Date.parse(to) - Date.parse(from) : Number.NaN;
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
}

/** `*` matches any run of characters, `?` one; everything else is literal (test names contain `/` and `>`). */
export function wildcard(pattern: string): RegExp {
  const src = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${src}$`);
}

export function matchKnownFlaky(
  jobName: string,
  tests: readonly string[],
  rules: readonly KnownFlakyRule[],
): FlakeSignal | null {
  for (const r of rules) {
    if (!wildcard(r.job).test(jobName)) continue;
    if (r.test === undefined) return { kind: 'known-flaky', detail: `ci.knownFlaky lists job ${r.job}` };
    const re = wildcard(r.test);
    const t = tests.find((x) => re.test(x));
    if (t) return { kind: 'known-flaky', detail: capLine(`ci.knownFlaky lists ${t} in ${r.job}`) };
  }
  return null;
}

/** One main run's outcome for this job: pass, fail with these tests, or unknown. Oldest first. */
export interface MainOutcome {
  runId: number;
  outcome: 'pass' | 'fail' | 'unknown';
  tests: readonly string[];
}

/** A failing test whose pass/fail sequence on main changes at least twice. */
export function detectIntermittent(tests: readonly string[], history: readonly MainOutcome[]): FlakeSignal | null {
  for (const t of tests) {
    const seq: { state: 'pass' | 'fail'; runId: number }[] = [];
    for (const h of history) {
      if (h.outcome === 'pass') seq.push({ state: 'pass', runId: h.runId });
      else if (h.outcome === 'fail' && h.tests.includes(t)) seq.push({ state: 'fail', runId: h.runId });
      // A run failing for other reasons says nothing about this test.
    }
    let changes = 0;
    for (let i = 1; i < seq.length; i++) if (seq[i]?.state !== seq[i - 1]?.state) changes++;
    const fails = seq.filter((s) => s.state === 'fail');
    if (changes >= 2 && fails.length > 0) {
      return {
        kind: 'main-intermittent',
        detail: capLine(
          `${t} failed in ${fails.length} of the last ${seq.length} main runs, passing in between (runs ${fails.map((f) => f.runId).join(', ')})`,
        ),
      };
    }
  }
  return null;
}

// ── gh-backed parts ─────────────────────────────────────────────────────────
export interface FlakeJob {
  name: string;
  jobId: number;
  runId: number;
  /** run_attempt of the failing job (jobs API); 1 when unknown. */
  attempt: number;
  headSha: string;
  workflowId: number | null;
}

/** The same-named job passed on an earlier attempt of this run, or in another run on this commit. */
export async function sameShaPassed(o: { gh: Gh; repo: RepoRef; job: FlakeJob }): Promise<FlakeSignal | null> {
  const { job } = o;
  for (let n = job.attempt - 1; n >= 1 && n >= job.attempt - MAX_SAME_SHA_LOOKUPS; n--) {
    const jobs = await listRunJobs({ gh: o.gh, repo: o.repo, runId: job.runId, attempt: n });
    if (jobs.some((j) => j.name === job.name && j.conclusion === 'success')) {
      return { kind: 'same-sha-passed', detail: `${job.name} passed on attempt ${n} of run ${job.runId}` };
    }
  }
  // Other runs only count for the same workflow: with it unknown, a same-named job elsewhere proves nothing.
  if (job.workflowId === null) return null;
  const siblings = (await listRunsForSha({ gh: o.gh, repo: o.repo, headSha: job.headSha }))
    .filter((r) => r.id !== job.runId && r.workflow_id === job.workflowId)
    .filter((r) => r.status === 'completed')
    .slice(0, MAX_SAME_SHA_LOOKUPS);
  for (const r of siblings) {
    const jobs = await listRunJobs({ gh: o.gh, repo: o.repo, runId: r.id });
    if (jobs.some((j) => j.name === job.name && j.conclusion === 'success')) {
      return {
        kind: 'same-sha-passed',
        detail: `${job.name} passed in run ${r.id} (${r.event}) on the same commit ${job.headSha.slice(0, 7)}`,
      };
    }
  }
  return null;
}

/** The job's outcome over the recent main push runs of its workflow (oldest first). */
export async function mainHistory(o: {
  gh: Gh;
  repo: RepoRef;
  comparer: MainComparer;
  defaultBranch: string;
  workflowId: number;
  jobName: string;
  prHeadSha: string;
  /** Checked before each comparer call (the comparer's gh is shared and is not scoped to it). */
  signal?: AbortSignal;
}): Promise<MainOutcome[]> {
  const runs: ActionsRun[] = (
    await listWorkflowRuns({
      gh: o.gh,
      repo: o.repo,
      workflowId: o.workflowId,
      fields: { branch: o.defaultBranch, event: 'push', status: 'completed', per_page: 10 },
    })
  ).filter((r) => r.head_sha !== o.prHeadSha);
  const out: MainOutcome[] = [];
  let parsed = 0;
  for (const r of runs) {
    if (r.conclusion === 'success') {
      out.push({ runId: r.id, outcome: 'pass', tests: [] });
      continue;
    }
    if (r.conclusion !== 'failure' || parsed >= MAX_FAILED_MAIN_RUNS) {
      out.push({ runId: r.id, outcome: 'unknown', tests: [] });
      continue;
    }
    o.signal?.throwIfAborted();
    const j = (await o.comparer.mainJobs(r.id)).find((x) => x.name === o.jobName);
    if (!j || (j.conclusion !== 'failure' && j.conclusion !== 'success')) {
      out.push({ runId: r.id, outcome: 'unknown', tests: [] });
    } else if (j.conclusion === 'success') {
      out.push({ runId: r.id, outcome: 'pass', tests: [] });
    } else {
      parsed++;
      o.signal?.throwIfAborted();
      out.push({ runId: r.id, outcome: 'fail', tests: (await o.comparer.jobTests(j)).tests });
    }
  }
  return out.reverse();
}

export interface AssessFlakeOptions {
  gh: Gh;
  repo: RepoRef;
  job: FlakeJob;
  /** The PR job's failing tests and the cleaned log lines the extractors read (JobAnalysis). */
  tests: readonly string[];
  lines: readonly string[];
  knownFlaky?: readonly KnownFlakyRule[];
  infraPatterns?: readonly string[];
  /** For main-intermittent; omitted means that signal is not computed. */
  main?: { comparer: MainComparer; defaultBranch: string };
  /** Stops main-history comparer calls once aborted (scope `gh` with gh.withSignal for the rest). */
  signal?: AbortSignal;
}

export async function assessFlake(o: AssessFlakeOptions): Promise<Flake> {
  const signals: FlakeSignal[] = [];
  const add = (s: FlakeSignal | null): void => {
    if (s) signals.push(s);
  };
  add(detectInfraError(o.lines, o.infraPatterns));
  add(matchKnownFlaky(o.job.name, o.tests, o.knownFlaky ?? []));
  if (scoreFlake(signals).score !== 'high') add(await sameShaPassed({ gh: o.gh, repo: o.repo, job: o.job }));
  const s = scoreFlake(signals).score;
  if (o.main && o.job.workflowId !== null && o.tests.length > 0 && s !== 'high' && s !== 'medium') {
    const history = await mainHistory({
      gh: o.gh,
      repo: o.repo,
      comparer: o.main.comparer,
      defaultBranch: o.main.defaultBranch,
      workflowId: o.job.workflowId,
      jobName: o.job.name,
      prHeadSha: o.job.headSha,
      ...(o.signal ? { signal: o.signal } : {}),
    });
    add(detectIntermittent(o.tests, history));
  }
  return scoreFlake(signals);
}
