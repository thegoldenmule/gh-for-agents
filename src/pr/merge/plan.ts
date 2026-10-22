// The merge plan (02 §8.1 steps 1–6; 03 M8.1): validate the overrides, read the PR through the shared
// pr status composition (mergeable bound 30 s), pin H to the evaluated head, and decide. All checks run and
// every violation is reported together (MERGE_BLOCKED); a stale --expect-head is HEAD_MOVED with the plan
// in details; a PR already merged at H is a success with nothing to send.
import type { Context } from '../../core/command.ts';
import { GhxError } from '../../core/errors.ts';
import type { RepoRef } from '../../gh/types.ts';
import { type MergeEvaluation, type MergeMethod, mergeBlockedError } from '../../policy/merge.ts';
import { parseOverrides } from '../../policy/overrides.ts';
import type { MergePlan } from '../../policy/schemas.ts';
import { COMPARE_BUDGET_MS } from '../ci-summary.ts';
import { MERGE_MERGEABLE_BUDGET_MS, type PrSnapshot } from '../snapshot/index.ts';
import { loadPrStatus } from '../status/compose.ts';
import { prContext, rethrowNotFound } from '../status/target.ts';
import { readMergePull } from './pull.ts';

/** Time kept back from the deadline before the PUT, so the merge and its verification never hit it. */
export const PUT_MARGIN_MS = 30_000;

export interface MergeFlags {
  pr: string;
  expectHead?: string | undefined;
  method?: MergeMethod | undefined;
  override?: readonly string[] | undefined;
  reason?: string | undefined;
}

interface Planned {
  repo: RepoRef;
  snapshot: PrSnapshot;
  evaluation: MergeEvaluation;
  plan: MergePlan;
  /** The pinned head (02 §8.1 step 3). */
  head: string;
  config: Awaited<ReturnType<typeof prContext>>['config'];
}

export type MergeDecision =
  | (Planned & { kind: 'merge' })
  | (Planned & { kind: 'already-merged'; mergeCommit: string; mergedAt: string });

const short = (sha: string) => sha.slice(0, 7);

export function headMovedError(ref: string, expected: string, actual: string | null, extra: object = {}): GhxError {
  const now = actual ? short(actual) : 'unknown';
  return new GhxError(
    'HEAD_MOVED',
    `Head is ${now}, expected ${expected.length === 40 ? short(expected) : expected}.`,
    {
      hint: actual
        ? `Re-check the new head: ghx pr status ${ref}, then retry with --expect-head ${short(actual)}.`
        : `Re-check the head: ghx pr status ${ref}, then retry with --expect-head <new head>.`,
      details: { expected, actual, ...extra },
    },
  );
}

/** Run every check and decide; throws VALIDATION, HEAD_MOVED or MERGE_BLOCKED. */
export async function planMerge(ctx: Context, flags: MergeFlags): Promise<MergeDecision> {
  // Bad overrides fail before any read (VALIDATION, exit 2).
  const overrides = parseOverrides(flags.override ?? [], flags.reason);
  const { resolved, number, config, configMissing, warnings } = await prContext(ctx, flags.pr);
  for (const w of warnings) ctx.warn(w);
  const remaining =
    ctx.deadline === undefined ? Infinity : ctx.deadline - ctx.clock.monotonic() - PUT_MARGIN_MS - 10_000;
  let state: Awaited<ReturnType<typeof loadPrStatus>>;
  try {
    state = await loadPrStatus({
      gh: ctx.gh,
      clock: ctx.clock,
      artifacts: ctx.artifacts,
      signal: ctx.signal,
      repo: resolved.repo,
      number,
      config,
      configMissing,
      mergeableBudgetMs: MERGE_MERGEABLE_BUDGET_MS,
      compareBudgetMs: Math.max(0, Math.min(COMPARE_BUDGET_MS, remaining)),
      request: {
        ...(flags.method ? { method: flags.method } : {}),
        ...(flags.expectHead ? { expectHead: flags.expectHead } : {}),
        overrides,
      },
    });
  } catch (e) {
    rethrowNotFound(e, resolved, number, 'merge');
  }
  const { snapshot, evaluation } = state;
  for (const w of state.warnings) ctx.warn({ code: w.code, message: w.message });
  for (const w of evaluation.warnings) ctx.warn({ code: w.code, message: w.message });
  const plan = evaluation.plan;
  const head = snapshot.head.sha;
  const base: Planned = { repo: resolved.repo, snapshot, evaluation, plan, head, config };

  // Step 3: a stale --expect-head is HEAD_MOVED, whatever else holds (the evaluation is about another commit).
  if (flags.expectHead && !head.startsWith(flags.expectHead.toLowerCase())) {
    throw headMovedError(snapshot.ref, flags.expectHead, head, { plan });
  }
  // Step 4: already merged at the evaluated head (#3211).
  if (snapshot.state === 'MERGED') {
    let mergeCommit = snapshot.merge.mergeCommit;
    let mergedAt = snapshot.merge.mergedAt;
    if (mergeCommit === null || mergedAt === null) {
      const pull = await readMergePull(ctx.gh, resolved.repo, number);
      mergeCommit = pull.merge_commit_sha;
      mergedAt = pull.merged_at;
    }
    if (mergeCommit === null || mergedAt === null) {
      throw new GhxError('GH_OUTPUT_UNEXPECTED', `${snapshot.ref} is MERGED but GitHub reports no merge commit.`, {
        hint: `Check the PR on GitHub: ghx pr status ${snapshot.ref}.`,
      });
    }
    return { ...base, kind: 'already-merged', mergeCommit, mergedAt };
  }
  if (!evaluation.ready) throw mergeBlockedError(evaluation);
  return { ...base, kind: 'merge' };
}
