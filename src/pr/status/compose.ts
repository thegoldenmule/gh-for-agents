// One read of everything the merge policy needs (02 §4.3, §8): snapshot → CI summary and facts → policy.
// `pr status` prints it; `pr merge` (mergeableBudgetMs 30 s, request with method/overrides/expectHead) and
// `ci wait --until mergeable` (scope 'ci-gate') call the same function, so `ready` cannot drift between them.
// Warnings are returned, never sent to ctx.warn: the runner would replace a command's own `warnings` list.
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
import { buildCiSummary, type CiSummaryConfig } from '../ci-summary.ts';
import { fetchPrSnapshot, type PrSnapshot, type PrSnapshotConfig } from '../snapshot/index.ts';

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

export async function loadPrStatus(o: LoadPrStatusOptions): Promise<PrStatusState> {
  const snapshot = await fetchPrSnapshot({
    gh: o.gh,
    clock: o.clock,
    ...(o.signal ? { signal: o.signal } : {}),
    repo: o.repo,
    number: o.number,
    config: { ci: { ignore: o.config.ci.ignore }, trust: o.config.trust, bots: o.config.bots },
    waitMergeable: o.waitMergeable !== false,
    ...(o.mergeableBudgetMs !== undefined ? { mergeableBudgetMs: o.mergeableBudgetMs } : {}),
    blockOnSeverity: o.config.merge.blockOnSeverity,
  });
  const ciWarnings: Warning[] = [];
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
    ...(o.compareBudgetMs !== undefined ? { compareBudgetMs: o.compareBudgetMs } : {}),
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
