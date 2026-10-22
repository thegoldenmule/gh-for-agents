// The ci wait loop (02 §11; 03 M4.7–M4.9). One loop polls up to 10 targets; each target has its own
// binding, machine and state file. Per tick: poll (conditional REST), bind or re-bind, normalise,
// observe, diagnose new failures (one diagnoser per SHA, 60 s budget per SHA), detect stalls, decide,
// save. The loop sleeps until the earliest target is due, never past the unattended self-return.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CiSection } from '../../config/sections/ci.ts';
import type { StreamContext } from '../../core/command.ts';
import { rethrowControlFlow } from '../../core/control-flow.ts';
import { GhxError, isGhxError } from '../../core/errors.ts';
import { exitForSignal } from '../../core/exit.ts';
import { DEFAULT_MAX_BYTES } from '../../core/output.ts';
import { isAbort } from '../../core/signals.ts';
import { DryRunHalt, GhFailure } from '../../gh/index.ts';
import { enrichNotFound, type ResolvedRepo } from '../../gh/repo.ts';
import { type RepoRef, repoSlug } from '../../gh/types.ts';
import type {
  Check,
  ExpectedCheck,
  FailingJob,
  Outcome,
  StalledCheck,
  TargetSummary,
  WaitSummary,
} from '../../schemas/ci.ts';
import { matchesGlob } from '../../util/glob.ts';
import { type JsonCache, repoCache } from '../cache.ts';
import { normaliseRollup, type WorkflowRunInfo } from '../checks.ts';
import {
  compactDiagnosis,
  createDiagnoser,
  DIAGNOSIS_BUDGET_MS,
  DIAGNOSIS_MAX_JOBS,
  type Diagnoser,
  eventDiagnosis,
  isDiagnosable,
} from '../diagnose.ts';
import { type ActionsJob, listRunJobs } from '../github.ts';
import { isRed, summariseCi } from '../summary.ts';
import { computeEta, type EtaEstimate } from './eta.ts';
import { buildExpectedSet, configExpected, previousHeadCandidates, requiredChecks } from './expected.ts';
import {
  fetchBaseline,
  fetchChangedFiles,
  fetchCommitParent,
  fetchEtaStats,
  fetchPrCommits,
  fetchRequiredSources,
  fetchWorkflowTimeouts,
} from './fetch.ts';
import { pollInterval } from './interval.ts';
import {
  type Decision,
  decide,
  initialState,
  type MachineConfig,
  type MachineEvent,
  markReported,
  observe,
  type UntilMode,
  WAIT_DEFAULTS,
} from './machine.ts';
import { createPoller, type Poller, TickFailed, type TickResult } from './poller.ts';
import { detectStalls, settledAt, stallConfig } from './stall.ts';
import { createWaitStore, type WaitState, type WaitStore } from './state.ts';
import { aggregate, type CommandShape, compactTarget, fitDocument, identicalCommand, nextFor } from './summary.ts';
import { type HeadPolicy, headPolicy, parseWaitTarget, targetKey, targetLabel, type WaitTarget } from './targets.ts';

/** Unattended sessions self-return `pending` after this much waiting (02 §11.1). */
export const UNATTENDED_RETURN_MS = 25 * 60_000;
/** Consecutive failed ticks after which a mid-wait gh failure is fatal (error line, exit 7). */
export const MAX_TICK_FAILURES = 5;
/** Room kept for the runner's `warnings` array when fitting the summary into maxBytes. */
const WARNINGS_RESERVE_BYTES = 3_072;
/** At most this many distinct warnings reach the summary; all of them go to diagnosisPath. */
const MAX_SUMMARY_WARNINGS = 8;

export interface WaitOptions {
  targets: string[];
  until: UntilMode;
  any: boolean;
  onHeadChange?: HeadPolicy | undefined;
  check?: string[] | undefined;
  diagnose: boolean;
  compareMain: boolean;
  stream: boolean;
}

/** M6.6: given a settled CI outcome, the merge gate's final word, or null to keep polling. */
export type SettleHook = (o: {
  target: WaitTarget;
  repo: RepoRef;
  headSha: string;
  ciOutcome: Outcome;
  checks: readonly Check[];
}) => Promise<{ outcome: Outcome; merge: NonNullable<TargetSummary['merge']>; next?: string[] } | null>;

export type WaitEventOut = MachineEvent | WaitStartEvent | OtherEvent;
type WaitStartEvent = {
  type: 'start';
  target: string;
  headSha: string;
  until: UntilMode;
  phase: Exclude<WaitState['machine']['phase'], null>;
  counts: TargetSummary['ci']['counts'];
  expected: ExpectedCheck[];
  eta: EtaEstimate['eta'];
};
type OtherEvent =
  | { type: 'diagnosis'; target: string; headSha: string; job: ReturnType<typeof eventDiagnosis> }
  | { type: 'head-changed'; target: string; from: string; to: string; action: 'restart' | 'stop' }
  | { type: 'branch-advanced'; target: string; boundSha: string; branchHead: string }
  | { type: 'rate-limit'; target: string; remaining: number; resetAt: string; intervalSec: number };

type CiConfig = z.output<typeof CiSection>;

interface Observed {
  checks: Check[];
  ignored: string[];
  expected: ExpectedCheck[];
}

interface Run {
  target: WaitTarget;
  resolved: ResolvedRepo;
  repo: RepoRef;
  key: string;
  label: string;
  policy: HeadPolicy;
  store: WaitStore;
  cache: JsonCache;
  ci: CiConfig;
  poller: Poller;
  release: () => void;
  st: WaitState | null;
  /** A state loaded from disk for the latest binding (resume), until the first tick confirms it. */
  resumed: boolean;
  /** Whether this process has emitted `start` for the current binding. */
  started: boolean;
  diagnoser: Diagnoser | null;
  runs: Record<string, WorkflowRunInfo>;
  last: Observed | null;
  lastDecision: Decision | null;
  summary: TargetSummary | null;
  nextAt: number;
  advanced: Set<string>;
  rateLimited: boolean;
  failures: number;
  waitStartedAt: number;
  restarts: number;
  jobs: Map<number, ActionsJob[]>;
}

export async function* runWait(
  o: WaitOptions,
  ctx: StreamContext,
  hooks: { onSettled?: SettleHook } = {},
): AsyncGenerator<WaitEventOut, WaitSummary, void> {
  const clock = ctx.clock;
  const attended = ctx.env.CLAUDE_CODE_SESSION_ATTENDED === '1';
  const offset = ctx.env.GHX_TEST_HOOKS === '1' ? Number(ctx.env.GHX_TEST_CLOCK_OFFSET_MS ?? 0) || 0 : 0;
  const startedMono = clock.monotonic();
  const returnAt = attended ? Number.POSITIVE_INFINITY : startedMono + UNATTENDED_RETURN_MS - offset;
  const cfg: MachineConfig = { until: o.until, ...WAIT_DEFAULTS };
  const globs = o.check ?? [];
  const consider = (c: { name: string }) =>
    globs.length === 0 || globs.some((g) => c.name === g || matchesGlob(c.name, g));

  // Warnings: every one goes to diagnosisPath; the summary gets the first of each code, capped.
  const allWarnings: { code: string; message: string }[] = [];
  const shownCodes = new Set<string>();
  const warn = (w: { code: string; message: string }): void => {
    allWarnings.push(w);
    if (shownCodes.has(w.code) || shownCodes.size >= MAX_SUMMARY_WARNINGS) return;
    shownCodes.add(w.code);
    ctx.warn(w);
  };

  /** `branch:<name>@<short sha>` binds the full SHA (state keys and events carry 40 chars). */
  const fullSha = async (t: WaitTarget, resolved: ResolvedRepo): Promise<WaitTarget> => {
    if (t.kind !== 'branch' || t.sha === null || t.sha.length === 40) return t;
    try {
      const r = await ctx.gh.api({ path: `repos/{owner}/{repo}/commits/${t.sha}`, repo: resolved.repo }, CommitSchema, {
        notFound: 'REF_NOT_FOUND',
      });
      return r.notModified ? t : { ...t, sha: r.data.sha };
    } catch (e) {
      throw enrichNotFound(e, resolved, `Commit ${t.sha}`);
    }
  };

  const parsed = o.targets.map(parseWaitTarget);
  const runs: Run[] = [];
  let flagRepo: string | undefined;
  try {
    for (const given of parsed) {
      const resolved = await ctx.repo({ ref: given.kind === 'pr' ? given.repo : undefined });
      if (resolved.source === 'flag') flagRepo = repoSlug(resolved.repo);
      const repo = resolved.repo;
      const target = await fullSha(given, resolved);
      const key = targetKey(target);
      const label = targetLabel(target, repo);
      if (runs.some((r) => r.key === key && repoSlug(r.repo) === repoSlug(repo))) {
        throw new GhxError('VALIDATION', `Target ${label} is listed twice.`, {
          details: { issues: [{ path: 'targets', code: 'duplicate', message: `${label} is listed twice` }] },
        });
      }
      const ci = (await ctx.config({ ref: repo })).config.ci;
      const store = await createWaitStore({ artifacts: ctx.artifacts, repo, clock });
      const release = await store.lock(key, {
        signal: ctx.signal,
        onStale: (pid) =>
          warn({
            code: 'WAIT_STATE_DISCARDED',
            message: `${label}: broke a stale wait lock${pid === null ? '' : ` (pid ${pid} is gone)`}.`,
          }),
      });
      // Resume: the latest binding's state, whose ETags make the first poll a 304 when nothing changed.
      const latest = store.latest(key);
      const prior = latest ? store.load(key, latest) : ({ kind: 'miss' } as const);
      if (prior.kind === 'discarded') {
        warn({
          code: 'WAIT_STATE_DISCARDED',
          message: `${label}: the saved wait state was unreadable (${prior.reason}); starting fresh.`,
        });
      }
      const st = prior.kind === 'hit' ? prior.state : null;
      runs.push({
        target,
        resolved,
        repo,
        key,
        label,
        policy: headPolicy(target, o.onHeadChange),
        store,
        cache: await repoCache({ artifacts: ctx.artifacts, repo, clock, ns: 'ci-wait' }),
        ci,
        poller: createPoller({
          gh: ctx.gh,
          repo,
          target:
            target.kind === 'pr' ? { kind: 'pr', number: target.number } : { kind: 'branch', branch: target.branch },
          now: () => clock.now(),
          ...(st ? { initial: st.poller } : {}),
        }),
        release,
        st,
        resumed: st !== null,
        started: false,
        diagnoser: null,
        runs: {},
        last: null,
        lastDecision: null,
        summary: null,
        nextAt: clock.monotonic(),
        advanced: new Set(),
        rateLimited: false,
        failures: 0,
        waitStartedAt: st?.waitStartedAt ?? clock.now(),
        restarts: st?.restarts ?? 0,
        jobs: new Map(),
      });
    }
  } catch (e) {
    for (const r of runs) r.release();
    throw e;
  }

  const shape: CommandShape = { ...o, repo: flagRepo };
  const identical = identicalCommand(shape);
  const prRef = (r: Run) => (r.target.kind === 'pr' ? r.label : null);
  const active = () => runs.filter((r) => r.summary === null);
  const save = (r: Run) => {
    if (!r.st) return;
    r.st.savedAt = clock.now();
    r.st.poller = r.poller.state();
    r.store.save(r.key, r.st);
  };

  /** The result for one target in this process (terminal, or pending/interrupted for an unfinished one). */
  const summarise = (r: Run, outcome: Outcome, reason: string | null, d: Decision | null): TargetSummary => {
    const st = r.st as WaitState;
    const obs = r.last ?? { checks: [], ignored: [], expected: [] };
    const s = summariseCi({ headSha: st.boundSha, checks: obs.checks, ignored: obs.ignored, expected: obs.expected });
    const red = obs.checks.filter(isRed);
    const diags = red.flatMap((c) => {
      const j = c.jobId === null ? undefined : st.diagnoses[String(c.jobId)];
      return j ? [j] : [];
    });
    const flaky = diags.filter((j) => j.flake.candidate).map((j) => j.jobId);
    return {
      target: r.label,
      outcome,
      reason,
      headSha: st.boundSha,
      restarts: r.restarts,
      elapsedSec: Math.max(0, Math.round((clock.now() - r.waitStartedAt) / 1000)),
      ci: {
        state: s.state,
        phase: s.phase,
        counts: s.counts,
        failing: red.map((c) => ({ name: c.name, workflow: c.workflow, jobId: c.jobId, runId: c.runId })),
        expectedMissing: s.expectedMissing.map((e) => e.name),
      },
      diagnosis:
        diags.length > 0
          ? { jobs: diags.slice(0, DIAGNOSIS_MAX_JOBS).map(compactDiagnosis), partial: st.diagnosis.partial }
          : null,
      stalled: d?.stalled ?? [],
      rerunCandidates: flaky,
      merge: null,
      next: nextFor({
        outcome,
        prRef: prRef(r),
        headSha: st.boundSha,
        settled: d?.settled ?? false,
        flaky: flaky.length > 0,
        identical,
      }),
    };
  };

  const finish = (r: Run, outcome: Outcome, reason: string, d: Decision | null): void => {
    const st = r.st as WaitState;
    if ((outcome === 'red' || outcome === 'red-shared') && d) st.machine = markReported(st.machine, d.failing);
    r.summary = summarise(r, outcome, reason, d);
    st.terminal = { outcome, settled: d?.settled ?? false, summary: r.summary };
    save(r);
  };

  /** A fresh binding: the expected set (required, config, baseline), read once and stored. */
  async function bind(r: Run, sha: string, t: TickResult): Promise<WaitState> {
    const loaded = r.store.load(r.key, sha);
    if (loaded.kind === 'hit') {
      r.resumed = true;
      return loaded.state;
    }
    if (loaded.kind === 'discarded') {
      warn({
        code: 'WAIT_STATE_DISCARDED',
        message: `${r.label}: the saved wait state was unreadable (${loaded.reason}); starting fresh.`,
      });
    }
    r.resumed = false;
    const base = t.pull?.baseRef ?? (r.target.kind === 'branch' ? r.target.branch : 'main');
    const defaultBranch = t.pull?.defaultBranch ?? (await repoDefaultBranch(r));
    const expected = await expectedDefs(r, sha, base);
    return {
      v: 1,
      target: r.label,
      boundSha: sha,
      savedAt: clock.now(),
      settledAt: null,
      waitStartedAt: r.waitStartedAt,
      restarts: r.restarts,
      base,
      defaultBranch,
      machine: initialState({ target: r.label, boundSha: sha, boundAt: clock.now(), expected }),
      poller: r.poller.state(),
      baselines: {},
      etaWorkflows: [],
      timeouts: {},
      diagnoses: {},
      diagnosis: { spentMs: 0, partial: false },
      terminal: null,
    };
  }

  async function repoDefaultBranch(r: Run): Promise<string> {
    try {
      const res = await ctx.gh.api({ path: 'repos/{owner}/{repo}', repo: r.repo }, RepoInfoSchema, {
        notFound: 'REPO_NOT_FOUND',
      });
      return res.notModified ? 'main' : res.data.default_branch;
    } catch (e) {
      rethrowControlFlow(e);
      throw enrichNotFound(e, r.resolved, `Repository ${repoSlug(r.repo)}`);
    }
  }

  async function expectedDefs(r: Run, sha: string, base: string) {
    const degrade = (what: string, e: unknown) => {
      rethrowControlFlow(e);
      warn({
        code: 'EXPECTED_CHECKS_PARTIAL',
        message: `${r.label}: ${what} could not be read (${e instanceof Error ? e.message : String(e)}).`,
      });
    };
    let required: string[] = [];
    let baseHeadSha: string | null | undefined;
    try {
      const req = await fetchRequiredSources({ gh: ctx.gh, repo: r.repo, base, warn });
      required = requiredChecks(req.sources);
      baseHeadSha = req.baseHeadSha;
    } catch (e) {
      degrade('required checks', e);
    }
    const entries = r.ci.expected ?? [];
    let changed: string[] | null = null;
    if (r.target.kind === 'pr' && entries.some((e) => e.paths)) {
      try {
        changed = await fetchChangedFiles({ gh: ctx.gh, repo: r.repo, number: r.target.number });
      } catch (e) {
        degrade('changed files', e);
      }
    }
    let baseline = null;
    try {
      const previousHeads =
        r.target.kind === 'pr'
          ? previousHeadCandidates(await fetchPrCommits({ gh: ctx.gh, repo: r.repo, number: r.target.number }), sha)
          : [await fetchCommitParent({ gh: ctx.gh, repo: r.repo, sha })].filter((s): s is string => s !== null);
      baseline = await fetchBaseline({
        gh: ctx.gh,
        repo: r.repo,
        base,
        headSha: sha,
        previousHeads,
        ...(r.target.kind === 'pr' ? { number: r.target.number } : {}),
        ...(baseHeadSha !== undefined ? { baseHeadSha } : {}),
        cache: r.cache,
      });
    } catch (e) {
      degrade('baseline checks', e);
    }
    return buildExpectedSet({
      required,
      config: configExpected(entries, changed),
      baseline,
      ignore: r.ci.ignore,
      consider,
    });
  }

  /** ETA samples for workflows not sampled yet (cached on disk for 24 h). */
  async function ensureEta(r: Run, st: WaitState, checks: readonly Check[]): Promise<void> {
    const byWf = new Map<number, string[]>();
    for (const c of checks) {
      const wf = c.runId === null ? null : (r.runs[String(c.runId)]?.workflowId ?? null);
      if (wf === null || st.etaWorkflows.includes(wf) || c.bucket !== 'pending') continue;
      byWf.set(wf, [...(byWf.get(wf) ?? []), c.name]);
    }
    for (const [workflowId, jobNames] of byWf) {
      // Marked sampled only once the read finished: an interrupt mid-fetch (which saves the state) must
      // leave the workflow to be sampled again, not marked sampled with no stats.
      try {
        Object.assign(
          st.baselines,
          await fetchEtaStats({ gh: ctx.gh, repo: r.repo, base: st.base, workflowId, jobNames, cache: r.cache }),
        );
      } catch (e) {
        rethrowControlFlow(e);
        warn({ code: 'ETA_UNAVAILABLE', message: `${r.label}: no ETA baseline for workflow ${workflowId}.` });
      }
      st.etaWorkflows.push(workflowId);
    }
  }

  /** Workflow timeouts for running checks with no baseline (the first-run stall rule), once per run. */
  async function ensureTimeouts(r: Run, st: WaitState, checks: readonly Check[]): Promise<void> {
    for (const c of checks) {
      if (c.bucket !== 'pending' || c.runId === null || st.baselines[c.name] || String(c.runId) in st.timeouts)
        continue;
      const path = r.runs[String(c.runId)]?.workflowPath;
      if (!path) continue;
      try {
        st.timeouts[String(c.runId)] = await fetchWorkflowTimeouts({
          gh: ctx.gh,
          repo: r.repo,
          path,
          ref: st.boundSha,
          cache: r.cache,
        });
      } catch (e) {
        rethrowControlFlow(e);
        st.timeouts[String(c.runId)] = null;
      }
    }
  }

  /** Stalls from the checks alone; a suspected one is confirmed against its run's jobs (runner, siblings). */
  async function stalls(r: Run, st: WaitState, checks: Check[], expected: ExpectedCheck[]): Promise<StalledCheck[]> {
    const input = {
      checks,
      jobs: [] as ActionsJob[],
      baselines: st.baselines,
      timeouts: st.timeouts,
      expected,
      now: clock.now(),
      config: stallConfig(r.ci.stall),
    };
    const rough = detectStalls(input);
    const runIds = [
      ...new Set(
        rough.flatMap((s) =>
          s.state === 'missing' ? [] : checks.filter((c) => c.name === s.name).map((c) => c.runId),
        ),
      ),
    ].filter((id): id is number => id !== null);
    if (runIds.length === 0) return rough;
    const jobs: ActionsJob[] = [];
    for (const runId of runIds) {
      try {
        jobs.push(...(await listRunJobs({ gh: ctx.gh, repo: r.repo, runId })));
      } catch (e) {
        rethrowControlFlow(e);
      }
    }
    return detectStalls({ ...input, jobs });
  }

  async function* diagnoseNew(r: Run, st: WaitState, failures: readonly Check[]): AsyncGenerator<WaitEventOut> {
    if (!o.diagnose) return;
    for (const c of failures) {
      if (!isDiagnosable(c) || st.diagnoses[String(c.jobId)]) continue;
      if (Object.keys(st.diagnoses).length >= DIAGNOSIS_MAX_JOBS) return;
      const left = DIAGNOSIS_BUDGET_MS - st.diagnosis.spentMs;
      if (left <= 0) {
        st.diagnosis.partial = true;
        return;
      }
      r.diagnoser ??= createDiagnoser({
        gh: ctx.gh,
        artifacts: ctx.artifacts,
        clock,
        repo: r.repo,
        headSha: st.boundSha,
        defaultBranch: st.defaultBranch,
        runs: r.runs,
        config: r.ci,
        compareMain: o.compareMain,
        warn,
      });
      const t0 = clock.monotonic();
      const job: FailingJob = await r.diagnoser.job(c, { budgetMs: left, signal: ctx.signal });
      const spent = clock.monotonic() - t0;
      st.diagnosis.spentMs += spent;
      if (spent >= left) st.diagnosis.partial = true;
      st.diagnoses[String(c.jobId)] = job;
      save(r);
      yield { type: 'diagnosis', target: r.label, headSha: st.boundSha, job: eventDiagnosis(job) };
    }
  }

  /** One tick for one target. */
  async function* tick(r: Run): AsyncGenerator<WaitEventOut> {
    const pinned = r.target.kind === 'branch' ? r.target.sha : null;
    let res: TickResult;
    try {
      res = await r.poller.tick({ sha: r.st?.boundSha ?? pinned, required: requiredSet(r) });
      r.failures = 0;
    } catch (e) {
      rethrowControlFlow(e);
      if (e instanceof GhFailure && e.failure.code === 'GH_RATE_LIMITED') {
        const b = ctx.gh.rateBudget(r.poller.mode === 'rest' ? 'core' : 'graphql');
        const until = Math.max(clock.now() + 60_000, b?.resetAt ?? 0);
        r.nextAt = clock.monotonic() + (until - clock.now());
        yield {
          type: 'rate-limit',
          target: r.label,
          remaining: 0,
          resetAt: new Date(until).toISOString(),
          intervalSec: Math.round((until - clock.now()) / 1000),
        };
        return;
      }
      const transient =
        e instanceof TickFailed || (e instanceof GhFailure && r.st !== null && !isGhxError(e, 'PR_NOT_FOUND'));
      if (!transient || ++r.failures >= MAX_TICK_FAILURES) {
        throw enrichNotFound(e instanceof TickFailed ? e.cause : e, r.resolved, r.label);
      }
      r.nextAt = clock.monotonic() + 30_000;
      return;
    }

    const head = res.headSha;
    if (r.st === null) {
      r.st = await bind(r, res.sha, res);
    } else if (r.target.kind === 'pr' && head !== null && head !== r.st.boundSha) {
      // Resuming a binding for a head that has since moved: a new process binds the new head silently.
      if (!r.started && r.policy === 'restart') {
        save(r);
        r.st = null;
        r.nextAt = clock.monotonic();
        return;
      }
      if (r.policy === 'restart') {
        yield { type: 'head-changed', target: r.label, from: r.st.boundSha, to: head, action: 'restart' };
        save(r);
        r.restarts++;
        r.st = null;
        r.started = false;
        r.diagnoser = null;
        r.last = null;
        r.nextAt = clock.monotonic();
        return;
      }
      if (r.policy === 'stop') {
        yield { type: 'head-changed', target: r.label, from: r.st.boundSha, to: head, action: 'stop' };
        finish(r, 'superseded', 'head-moved', null);
        return;
      }
    }
    const st = r.st;
    if (head !== null && head !== st.boundSha && !r.advanced.has(head) && r.policy === 'stay') {
      r.advanced.add(head);
      yield { type: 'branch-advanced', target: r.label, boundSha: st.boundSha, branchHead: head };
    }

    const norm = normaliseRollup(res.nodes, { repo: r.repo, headSha: st.boundSha, ignore: r.ci.ignore });
    Object.assign(r.runs, norm.runs);
    const checks = norm.checks.filter(consider);
    const ignored = norm.ignored;
    const now = clock.now();

    if (res.pull && res.pull.state !== 'OPEN') {
      r.last = { checks, ignored, expected: r.last?.expected ?? [] };
      finish(r, 'closed', res.pull.state === 'MERGED' ? 'merged' : 'closed', null);
      return;
    }

    await ensureEta(r, st, checks);
    const estimate = computeEta(
      checks.filter((c) => c.bucket === 'pending'),
      st.baselines,
      now,
    );
    const ob = observe(st.machine, { checks, ignored: ignored.length, eta: estimate.eta, now }, cfg);
    st.machine = ob.state;
    st.settledAt = settledAt(checks);
    r.last = { checks, ignored, expected: ob.expected };
    if (!r.started) {
      r.started = true;
      yield {
        type: 'start',
        target: r.label,
        headSha: st.boundSha,
        until: o.until,
        phase: ob.phase,
        counts: summariseCi({ headSha: st.boundSha, checks, ignored }).counts,
        expected: ob.expected,
        eta: estimate.eta,
      };
    }
    yield* ob.events;
    // Failures seen before (a resumed state) whose diagnosis was cut off are retried here too.
    const undiagnosed = checks.filter((c) => isRed(c) && c.jobId !== null && !st.diagnoses[String(c.jobId)]);
    yield* diagnoseNew(r, st, [...ob.newFailures, ...undiagnosed.filter((c) => !ob.newFailures.includes(c))]);

    await ensureTimeouts(r, st, checks);
    const stalled = await stalls(r, st, checks, ob.expected);
    const diagnosis = (c: Check) => (c.jobId === null ? undefined : st.diagnoses[String(c.jobId)]);
    const d = decide(st.machine, { checks, now: clock.now() }, { cfg, diagnosis, stalled });
    r.lastDecision = d;
    if (d) {
      if (d.gate) {
        const gated = hooks.onSettled
          ? await hooks.onSettled({
              target: r.target,
              repo: r.repo,
              headSha: st.boundSha,
              ciOutcome: d.outcome,
              checks,
            })
          : { outcome: d.outcome, merge: null, next: undefined };
        if (gated) {
          finish(r, gated.outcome, d.reason, d);
          if (r.summary && gated.merge)
            r.summary = { ...r.summary, merge: gated.merge, next: gated.next ?? r.summary.next };
          return;
        }
      } else {
        finish(r, d.outcome, d.reason, d);
        return;
      }
    }
    save(r);
    const iv = pollInterval({
      phase: ob.phase,
      estimate,
      attended,
      budget: res.budget,
      now: clock.now(),
      random: ctx.random,
    });
    r.nextAt = clock.monotonic() + iv.ms;
    if (iv.rateLimited && !r.rateLimited && res.budget) {
      yield {
        type: 'rate-limit',
        target: r.label,
        remaining: res.budget.remaining,
        resetAt: new Date(res.budget.resetAt).toISOString(),
        intervalSec: Math.round(iv.ms / 1000),
      };
    }
    r.rateLimited = iv.rateLimited;
  }

  /** Required names for REST check runs (which carry no isRequired). */
  function requiredSet(r: Run): Set<string> {
    return new Set((r.st?.machine.expected ?? []).filter((e) => e.source === 'required').map((e) => e.name));
  }

  const writeDiagnosisFile = async (results: TargetSummary[], force: boolean): Promise<string | null> => {
    const diagnoses = runs.flatMap((r) =>
      Object.values(r.st?.diagnoses ?? {}).map((job) => ({ target: r.label, job })),
    );
    if (diagnoses.length === 0 && !force) return null;
    const first = runs[0] as Run;
    const name =
      runs.length === 1
        ? `${first.key}-${(first.st?.boundSha ?? 'unbound').slice(0, 7)}.json`
        : `multi-${createHash('sha256')
            .update(runs.map((r) => `${repoSlug(r.repo)}:${r.key}`).join('\n'))
            .digest('hex')
            .slice(0, 12)}.json`;
    const ref = await ctx.artifacts.write({
      kind: 'ci-wait',
      name,
      content: `${JSON.stringify({ results, diagnoses, warnings: allWarnings }, null, 2)}\n`,
      repo: first.repo,
    });
    return ref.path;
  };

  const result = async (interruptedBy?: string): Promise<WaitSummary> => {
    for (const r of runs) {
      if (r.summary === null && r.st) {
        const outcome: Outcome = interruptedBy ? 'interrupted' : 'pending';
        const reason = interruptedBy ? `signal ${interruptedBy}` : 'unattended-self-return';
        r.summary = summarise(r, outcome, reason, r.lastDecision);
        save(r);
      }
    }
    const results = runs.map((r) => r.summary as TargetSummary);
    const done = o.any ? results.filter((x) => x.outcome !== 'pending') : results;
    const agg = interruptedBy
      ? { outcome: 'interrupted' as const, exitCode: exitForSignal(interruptedBy) }
      : aggregate(done.length > 0 ? done : results);
    const maxBytes =
      Math.min(DEFAULT_MAX_BYTES, Number(ctx.env.GHX_MAX_BYTES) || DEFAULT_MAX_BYTES) - WARNINGS_RESERVE_BYTES;
    const eventsPath = await ctx.events.path();
    const build = (diagnosisPath: string | null) => (lvl: number) => ({
      outcome: agg.outcome,
      exitCode: agg.exitCode,
      results: results.map((t) => compactTarget(t, lvl)),
      diagnosisPath,
      eventsPath,
      resumed: runs.some((r) => r.resumed),
    });
    const path = await writeDiagnosisFile(results, false);
    const fitted = fitDocument(build(path), maxBytes);
    if (fitted.level === 0 || path !== null) return fitted.doc;
    // Compaction cut detail and nothing was written yet: keep the full form on disk.
    return fitDocument(build(await writeDiagnosisFile(results, true)), maxBytes).doc;
  };

  try {
    for (;;) {
      for (const r of active()) {
        if (r.nextAt > clock.monotonic()) continue;
        yield* tick(r);
        // A re-bind wants an immediate tick on the new head.
        while (r.summary === null && r.st === null && r.nextAt <= clock.monotonic()) yield* tick(r);
      }
      const open = active();
      if (open.length === 0 || (o.any && open.length < runs.length)) break;
      if (clock.monotonic() >= returnAt) break;
      const wake = Math.min(returnAt, ...open.map((r) => r.nextAt));
      await clock.sleep(Math.max(0, wake - clock.monotonic()), ctx.signal);
    }
    return await result();
  } catch (e) {
    if (e instanceof DryRunHalt) throw e;
    if (!isAbort(e) || runs.some((r) => r.summary === null && r.st === null)) throw e;
    const details = (e as GhxError).details as { signal?: string } | null | undefined;
    return await result(isGhxError(e, 'INTERRUPTED') ? (details?.signal ?? 'SIGTERM') : 'SIGTERM');
  } finally {
    for (const r of runs) r.release();
  }
}

const RepoInfoSchema = z.object({ default_branch: z.string() });
const CommitSchema = z.object({ sha: z.string() });
