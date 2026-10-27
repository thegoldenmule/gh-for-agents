// One read of everything the merge policy needs (02 §4.3, §8): snapshot → CI summary and facts → policy.
// `pr status` prints it; `pr merge` (mergeableBudgetMs 30 s, request with method/overrides/expectHead) and
// `ci wait --until mergeable` (scope 'ci-gate') call the same function, so `ready` cannot drift between them.
// Warnings are returned, never sent to ctx.warn: the runner would replace a command's own `warnings` list.
// With a `deadline` (pr status), the mergeable retry and the main comparison are cut to fit it, each budget
// taken from the time left when that step starts, so a slow PR ends with what is known instead of timing out.
import type { ArtifactStore } from '../../core/artifacts.ts';
import type { Clock } from '../../core/clock.ts';
import type { Gh } from '../../gh/index.ts';
import type { RepoRef } from '../../gh/types.ts';
import {
  type CiFacts,
  evaluateMerge,
  type MergeEvaluation,
  type MergePolicyConfig,
  type MergeRequest,
} from '../../policy/merge.ts';
import type { CiSummary } from '../../schemas/ci.ts';
import type { Warning } from '../../schemas/common.ts';
import { buildCiSummary, type CiSummaryConfig, COMPARE_BUDGET_MS } from '../ci-summary.ts';
import { fetchPrSnapshot, MERGEABLE_BUDGET_MS, type PrSnapshot, type PrSnapshotConfig } from '../snapshot/index.ts';
import { backoffDelays } from '../snapshot/mergeable.ts';

export interface PrStatusConfig extends MergePolicyConfig {
  ci: CiSummaryConfig & MergePolicyConfig['ci'];
  trust: PrSnapshotConfig['trust'];
  bots: PrSnapshotConfig['bots'];
}

export interface LoadPrStatusOptions {
  gh: Gh;
  clock: Clock;
  artifacts: ArtifactStore;
  signal?: AbortSignal;
  repo: RepoRef;
  number: number;
  config: PrStatusConfig;
  /** No .github/ghx.json: the CONFIG_MISSING blocker (02 §4.2). */
  configMissing?: boolean;
  /** Retry an UNKNOWN mergeable (default true). */
  waitMergeable?: boolean;
  /** The mergeable retry budget (snapshot default 20 s; pr merge passes 30 s). */
  mergeableBudgetMs?: number;
  /** Shared-with-main on failing checks (default true). */
  compareMain?: boolean;
  compareBudgetMs?: number;
  /**
   * clock.monotonic() by which the read should be done. The mergeable retry gets at most half the usable
   * time left and the comparison the usable time left when it starts (both still capped by their budgets);
   * usable keeps DEADLINE_MARGIN_MS (or a quarter of what is left, if less) for what follows. Unset: no cut.
   */
  deadline?: number | undefined;
  request?: MergeRequest;
  scope?: 'full' | 'ci-gate';
  /** Baseline names ci wait has aged out itself (buildCiSummary's agedOut); default: the grace rule. */
  agedOut?: readonly string[];
}

export interface PrStatusState {
  snapshot: PrSnapshot;
  ci: CiSummary;
  ciFacts: CiFacts;
  evaluation: MergeEvaluation;
  /** Snapshot, block, fold, CI and policy warnings, in that order. */
  warnings: Warning[];
}

/** Kept back from `deadline` for what follows the comparison (key steps, the policy) and the output. */
export const DEADLINE_MARGIN_MS = 10_000;

/** The time left before `deadline` that a step may use: all of it but the margin. Infinity without one. */
function usableMs(o: Pick<LoadPrStatusOptions, 'clock' | 'deadline'>): number {
  if (o.deadline === undefined) return Infinity;
  const left = Math.max(0, o.deadline - o.clock.monotonic());
  return left - Math.min(DEADLINE_MARGIN_MS, left / 4);
}

/** The mergeable retry budget: the asked one, or half the usable time if less, in whole backoff steps. */
function mergeableBudget(o: LoadPrStatusOptions): number | undefined {
  if (o.deadline === undefined) return o.mergeableBudgetMs;
  const want = Math.min(o.mergeableBudgetMs ?? MERGEABLE_BUDGET_MS, usableMs(o) / 2);
  return backoffDelays(want).reduce((a, b) => a + b, 0);
}

export async function loadPrStatus(o: LoadPrStatusOptions): Promise<PrStatusState> {
  const mergeableBudgetMs = mergeableBudget(o);
  const snapshot = await fetchPrSnapshot({
    gh: o.gh,
    clock: o.clock,
    ...(o.signal ? { signal: o.signal } : {}),
    repo: o.repo,
    number: o.number,
    config: { ci: { ignore: o.config.ci.ignore }, trust: o.config.trust, bots: o.config.bots },
    waitMergeable: o.waitMergeable !== false,
    ...(mergeableBudgetMs !== undefined ? { mergeableBudgetMs } : {}),
    blockOnSeverity: o.config.merge.blockOnSeverity,
  });
  const ciWarnings: Warning[] = [];
  const compareBudgetMs =
    o.deadline === undefined
      ? o.compareBudgetMs
      : Math.max(0, Math.min(o.compareBudgetMs ?? COMPARE_BUDGET_MS, usableMs(o)));
  const { summary, facts } = await buildCiSummary({
    gh: o.gh,
    artifacts: o.artifacts,
    clock: o.clock,
    repo: o.repo,
    ref: snapshot.ref,
    number: snapshot.number,
    base: snapshot.base.ref,
    ci: snapshot.ci,
    config: o.config.ci,
    compareMain: o.compareMain !== false,
    ...(compareBudgetMs !== undefined ? { compareBudgetMs } : {}),
    ...(o.agedOut ? { agedOut: o.agedOut } : {}),
    warn: (w) => ciWarnings.push(w),
  });
  const evaluation = evaluateMerge({
    snapshot,
    ci: summary,
    ciFacts: facts,
    feedback: snapshot.feedback,
    config: o.config,
    configMissing: o.configMissing === true,
    ...(o.request ? { request: o.request } : {}),
    now: o.clock.now(),
    ...(o.scope ? { scope: o.scope } : {}),
  });
  return {
    snapshot,
    ci: summary,
    ciFacts: facts,
    evaluation,
    warnings: [
      ...snapshot.warnings,
      ...snapshot.meta.warnings,
      ...snapshot.feedback.warnings,
      ...ciWarnings,
      ...evaluation.notices,
    ],
  };
}
