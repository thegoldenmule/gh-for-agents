// The bounded `mergeable: UNKNOWN` retry [G-UNKNOWN] (02 §4.3 step 4, §8.1 step 2; 03 M6.3, R03).
// GitHub computes mergeability lazily after a push, so the first read is often UNKNOWN. ghx re-queries
// with sleeps of 1, 2, 3, 4, 5, 5 s (20 s in total; `pr merge` continues at 5 s up to 30 s). The sleeps
// are exact, not jittered, and run on the injected clock. A head change mid-retry is reported to the
// caller, which restarts the whole read once.
import { z } from 'zod';
import type { Clock } from '../../core/clock.ts';
import type { Gh } from '../../gh/index.ts';
import type { RepoRef } from '../../gh/types.ts';

/** The backoff schedule; after it, 5 s steps continue while the budget allows. */
export const MERGEABLE_BACKOFF_MS = [1000, 2000, 3000, 4000, 5000, 5000] as const;
/** `pr status` and `ci wait --until mergeable`. */
export const MERGEABLE_BUDGET_MS = 20_000;
/** `pr merge` (02 §8.1 step 2). */
export const MERGE_MERGEABLE_BUDGET_MS = 30_000;

export const MERGEABLE_VALUES = ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] as const;
export type Mergeable = (typeof MERGEABLE_VALUES)[number];
export const MERGE_STATE_VALUES = [
  'BEHIND',
  'BLOCKED',
  'CLEAN',
  'DIRTY',
  'DRAFT',
  'HAS_HOOKS',
  'UNKNOWN',
  'UNSTABLE',
] as const;
export type MergeStateStatus = (typeof MERGE_STATE_VALUES)[number];

/** A value this ghx doesn't know reads as UNKNOWN: never mergeable by accident. */
export function toMergeable(v: string): Mergeable {
  return (MERGEABLE_VALUES as readonly string[]).includes(v) ? (v as Mergeable) : 'UNKNOWN';
}
export function toMergeState(v: string): MergeStateStatus {
  return (MERGE_STATE_VALUES as readonly string[]).includes(v) ? (v as MergeStateStatus) : 'UNKNOWN';
}

/** The sleeps for a budget: the schedule, then 5 s steps, never past the budget in total. */
export function backoffDelays(budgetMs: number): number[] {
  const out: number[] = [];
  let total = 0;
  for (let i = 0; ; i++) {
    const next = MERGEABLE_BACKOFF_MS[i] ?? 5000;
    if (total + next > budgetMs) return out;
    out.push(next);
    total += next;
  }
}

export const MERGEABLE_QUERY =
  'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){' +
  'pullRequest(number:$number){state headRefOid mergeable mergeStateStatus}}}';

const MergeableData = z.object({
  repository: z
    .object({
      pullRequest: z
        .object({ state: z.string(), headRefOid: z.string(), mergeable: z.string(), mergeStateStatus: z.string() })
        .nullable(),
    })
    .nullable(),
});

export type MergeableRetry =
  | {
      kind: 'settled';
      mergeable: Exclude<Mergeable, 'UNKNOWN'>;
      mergeStateStatus: MergeStateStatus;
      queries: number;
      waitedMs: number;
    }
  | {
      kind: 'unknown';
      mergeStateStatus: MergeStateStatus;
      /** The last mergeable read: known when only mergeStateStatus stayed UNKNOWN. */
      mergeable?: Mergeable;
      queries: number;
      waitedMs: number;
    }
  | { kind: 'head-changed'; headSha: string; queries: number; waitedMs: number }
  | {
      kind: 'not-open';
      /** The state GitHub reported (a PR merged or closed mid-retry). */
      state?: 'CLOSED' | 'MERGED';
      queries: number;
      waitedMs: number;
    };

export interface MergeableRetryOptions {
  gh: Gh;
  clock: Clock;
  signal?: AbortSignal;
  repo: RepoRef;
  number: number;
  /** The head the snapshot was read at; a different head ends the retry with `head-changed`. */
  headSha: string;
  budgetMs?: number;
}

/**
 * Re-query until both mergeable and mergeStateStatus are known (an UNKNOWN merge state would otherwise
 * pass the BEHIND/BLOCKED/DIRTY checks), the budget is spent, the head moves or the PR stops being open.
 */
export async function retryMergeable(o: MergeableRetryOptions): Promise<MergeableRetry> {
  let queries = 0;
  let waitedMs = 0;
  let lastState: MergeStateStatus = 'UNKNOWN';
  let lastMergeable: Mergeable = 'UNKNOWN';
  for (const delay of backoffDelays(o.budgetMs ?? MERGEABLE_BUDGET_MS)) {
    await o.clock.sleep(delay, o.signal);
    waitedMs += delay;
    queries++;
    const data = await o.gh.graphql(
      MERGEABLE_QUERY,
      { owner: o.repo.owner, name: o.repo.name, number: o.number },
      MergeableData,
      { repo: o.repo, notFound: 'PR_NOT_FOUND' },
    );
    const pr = data.repository?.pullRequest;
    if (!pr) continue;
    if (pr.headRefOid !== o.headSha) return { kind: 'head-changed', headSha: pr.headRefOid, queries, waitedMs };
    if (pr.state !== 'OPEN') {
      const state = pr.state === 'MERGED' || pr.state === 'CLOSED' ? pr.state : undefined;
      return { kind: 'not-open', ...(state ? { state } : {}), queries, waitedMs };
    }
    const mergeable = toMergeable(pr.mergeable);
    lastMergeable = mergeable;
    lastState = toMergeState(pr.mergeStateStatus);
    if (mergeable !== 'UNKNOWN' && lastState !== 'UNKNOWN') {
      return { kind: 'settled', mergeable, mergeStateStatus: lastState, queries, waitedMs };
    }
  }
  return { kind: 'unknown', mergeStateStatus: lastState, mergeable: lastMergeable, queries, waitedMs };
}
