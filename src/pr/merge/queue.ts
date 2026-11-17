// The merge queue (GitHub rulesets' "Require merge queue"): where the base branch has one, GitHub refuses
// the REST merge ("Changes must be made through the merge queue"), so pr merge adds the PR to the queue
// instead and pr land waits for the queue to merge or drop it.
// - Enqueue is the GraphQL enqueuePullRequest mutation with {pullRequestId, expectedHeadOid: H}: pinned
//   like the REST merge, GitHub refuses it server-side if the head moved after the snapshot.
// - A failed enqueue never blindly re-sends: it re-reads first. A moved head is HEAD_MOVED; a PR found in
//   the queue is a success (alreadyQueued); open at H after a transient failure gets exactly one more
//   attempt; anything else is MERGE_BLOCKED with GitHub's own message.
// - The wait polls one small query. Merged ends it; an open PR seen out of the queue on
//   DROP_CONFIRM_READS reads in a row was dropped (MERGE_QUEUE_DROPPED, with the reason GitHub recorded in
//   the timeline). One read is not enough: the entry and the PR state are not updated together. The
//   timeline event alone never means dropped: GitHub records one with reason "merged" on success too
//   (seen live).
// Field, enum and mutation names were read from the live schema (GraphQL introspection), not from memory.
import { z } from 'zod';
import type { Context } from '../../core/command.ts';
import { rethrowControlFlow } from '../../core/control-flow.ts';
import { GhxError } from '../../core/errors.ts';
import { GhFailure } from '../../gh/index.ts';
import type { RepoRef } from '../../gh/types.ts';
import { ENQUEUE_MUTATION } from '../../policy/merge.ts';
import type { MergePlan } from '../../policy/schemas.ts';
import { RawQueueEntry } from '../snapshot/query.ts';
import { headMovedError } from './plan.ts';
import { blockedAtPut } from './put.ts';

/** How often the queue is read while the PR is in it. */
export const QUEUE_POLL_MS = 10_000;
/** Reads in a row that must show an open PR out of the queue before it counts as dropped. */
export const DROP_CONFIRM_READS = 2;
/**
 * The same, when the timeline says the queue removed the PR because it merged it (GitHub records a
 * RemovedFromMergeQueueEvent with reason "merged" on success too): the PR state is about to follow.
 */
export const MERGED_EVENT_CONFIRM_READS = 6;
/** Consecutive failed queue reads after which the wait gives up (the gh error, exit 7). */
export const MAX_QUEUE_READ_FAILURES = 5;
/** Enqueue attempts in total: the first, plus one after a transient failure re-read open at H, not queued. */
export const ENQUEUE_ATTEMPTS = 2;
/** Per enqueue attempt (the gh layer still caps it at the command deadline). */
export const ENQUEUE_TIMEOUT_MS = 60_000;

export const QUEUE_QUERY =
  'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){' +
  'pullRequest(number:$number){state headRefOid mergedAt mergeCommit{oid} isInMergeQueue ' +
  'mergeQueueEntry{state position enqueuedAt} ' +
  'timelineItems(last:1,itemTypes:[REMOVED_FROM_MERGE_QUEUE_EVENT]){nodes{__typename ' +
  '... on RemovedFromMergeQueueEvent{createdAt reason actor{login}}}}}}}';

const QueueData = z.object({
  repository: z
    .object({
      pullRequest: z
        .object({
          state: z.string(),
          headRefOid: z.string(),
          mergedAt: z.string().nullable(),
          mergeCommit: z.object({ oid: z.string() }).nullable(),
          isInMergeQueue: z.boolean(),
          mergeQueueEntry: RawQueueEntry.nullable(),
          timelineItems: z.object({
            nodes: z.array(
              z
                .looseObject({
                  createdAt: z.string().optional(),
                  reason: z.string().nullable().optional(),
                  actor: z.looseObject({ login: z.string() }).nullable().optional(),
                })
                .nullable(),
            ),
          }),
        })
        .nullable(),
    })
    .nullable(),
});

const EnqueueData = z.object({
  enqueuePullRequest: z.object({ mergeQueueEntry: RawQueueEntry.nullable() }).nullable(),
});

export interface QueueEntry {
  state: string;
  position: number;
  enqueuedAt: string | null;
}

/** One read of the PR as the queue sees it. */
export interface QueueRead {
  state: string;
  headSha: string;
  mergedAt: string | null;
  mergeCommit: string | null;
  entry: QueueEntry | null;
  /** The last time the PR was removed from a queue (GitHub's timeline); null when it never was. */
  removed: { at: string; reason: string | null; by: string | null } | null;
}

export interface QueueTarget {
  ctx: Context;
  repo: RepoRef;
  number: number;
  ref: string;
  /** The pinned head. */
  head: string;
}

const short = (sha: string) => sha.slice(0, 7);
const entryOf = (e: RawQueueEntry | null): QueueEntry | null =>
  e ? { state: e.state, position: e.position, enqueuedAt: e.enqueuedAt ?? null } : null;

export async function readQueue(o: QueueTarget): Promise<QueueRead> {
  const data = await o.ctx.gh.graphql(
    QUEUE_QUERY,
    { owner: o.repo.owner, name: o.repo.name, number: o.number },
    QueueData,
    { repo: o.repo, notFound: 'PR_NOT_FOUND' },
  );
  const pr = data.repository?.pullRequest;
  if (!pr) throw new GhxError('PR_NOT_FOUND', `PR ${o.ref} was not found.`, { details: { ref: o.ref } });
  const ev = pr.timelineItems.nodes.at(-1) ?? null;
  return {
    state: pr.state,
    headSha: pr.headRefOid,
    mergedAt: pr.mergedAt,
    mergeCommit: pr.mergeCommit?.oid ?? null,
    // isInMergeQueue and the entry are read together; either one says the PR is in the queue.
    entry:
      entryOf(pr.mergeQueueEntry) ?? (pr.isInMergeQueue ? { state: 'QUEUED', position: 0, enqueuedAt: null } : null),
    removed: ev?.createdAt ? { at: ev.createdAt, reason: ev.reason ?? null, by: ev.actor?.login ?? null } : null,
  };
}

async function tryReadQueue(o: QueueTarget): Promise<QueueRead | null> {
  try {
    return await readQueue(o);
  } catch (e) {
    rethrowControlFlow(e);
    return null;
  }
}

function notOpen(o: QueueTarget, state: string, extra: object = {}): GhxError {
  return new GhxError('PR_NOT_OPEN', `${o.ref} is ${state}.`, {
    hint: 'Reopen it in the UI or create a new PR.',
    details: { state, ...extra },
  });
}

export type EnqueueOutcome =
  | { kind: 'queued'; entry: QueueEntry | null; alreadyQueued: boolean }
  /** Merged at H by the time the failed mutation was re-read. */
  | { kind: 'merged'; mergeCommit: string | null; mergedAt: string | null };

/** Send the plan's enqueuePullRequest mutation and classify the result. */
export async function enqueue(o: QueueTarget & { plan: MergePlan }): Promise<EnqueueOutcome> {
  const { query, variables } = o.plan.request.body as {
    query?: unknown;
    variables?: { input?: Record<string, unknown> };
  };
  const input = variables?.input;
  if (o.plan.via !== 'queue' || query !== ENQUEUE_MUTATION || typeof input?.pullRequestId !== 'string') {
    throw new GhxError('INTERNAL', `The merge plan of ${o.ref} is not a merge queue request.`, {
      details: { request: o.plan.request },
    });
  }
  for (let attempt = 1; ; attempt++) {
    let failure: GhFailure;
    try {
      const r = await o.ctx.gh.graphql(ENQUEUE_MUTATION, { input }, EnqueueData, {
        repo: o.repo,
        mutates: true,
        notFound: 'PR_NOT_FOUND',
      });
      return { kind: 'queued', entry: entryOf(r.enqueuePullRequest?.mergeQueueEntry ?? null), alreadyQueued: false };
    } catch (e) {
      rethrowControlFlow(e);
      if (!(e instanceof GhFailure)) throw e;
      failure = e;
    }
    const github = failure.message.replace(/^GraphQL: /, '');
    // The mutation may have gone through, or the PR may have changed under it: look before deciding.
    const now = await tryReadQueue(o);
    if (now === null) {
      throw new GhxError('GH_FAILED', `Adding ${o.ref} to the merge queue failed: ${github}`, {
        hint: `The PR could not be re-read, so whether it is queued is unknown: run ghx pr status ${o.ref} before retrying.`,
        details: { ...(failure.details ?? {}), github },
        cause: failure,
      });
    }
    if (now.headSha !== o.head)
      throw headMovedError(o.ref, o.head, now.headSha, { github, queued: now.entry !== null });
    if (now.state === 'MERGED') return { kind: 'merged', mergeCommit: now.mergeCommit, mergedAt: now.mergedAt };
    if (now.state !== 'OPEN') throw notOpen(o, now.state, { github });
    if (now.entry) return { kind: 'queued', entry: now.entry, alreadyQueued: true };
    if (failure.failure.transient && attempt < ENQUEUE_ATTEMPTS) continue;
    throw blockedAtPut(
      o.plan,
      'BLOCKED_BY_PROTECTION',
      `GitHub refused to add ${o.ref} to the merge queue: ${github}`,
      {
        status: failure.failure.status ?? null,
        github,
        hint: `Check why it cannot be queued (required checks, reviews, the ruleset of the base branch): ghx pr status ${o.ref}`,
      },
    );
  }
}

export type QueueWait =
  | { kind: 'merged'; mergeCommit: string | null; mergedAt: string | null }
  /** `returnAt` came first: the PR is still in the queue. */
  | { kind: 'pending'; entry: QueueEntry | null };

export interface QueueWaitOptions extends QueueTarget {
  /** clock.monotonic() at which to stop waiting and return `pending`; Infinity waits to the end. */
  returnAt: number;
  /** The entry as last seen (from the enqueue or the snapshot), for the first report. */
  entry: QueueEntry | null;
  /** Called with each read that shows the PR in the queue. */
  onEntry?: (entry: QueueEntry) => void;
}

/** The timeline's last removal, when it is this entry's: not older than the entry it would have ended. */
function removalOf(last: QueueEntry | null, read: QueueRead): QueueRead['removed'] {
  const since = last?.enqueuedAt ? Date.parse(last.enqueuedAt) : Number.NaN;
  return read.removed && !(Date.parse(read.removed.at) < since) ? read.removed : null;
}

function droppedError(o: QueueTarget, last: QueueEntry | null, read: QueueRead): GhxError {
  const ev = removalOf(last, read);
  const why = ev?.reason ? `: ${ev.reason}` : '';
  const by = ev?.by ? ` by ${ev.by}` : '';
  return new GhxError('MERGE_QUEUE_DROPPED', `${o.ref} was removed from the merge queue${by} without merging${why}.`, {
    hint:
      `See what blocks it: ghx pr status ${o.ref} (the checks of its merge group failed, it conflicts with ` +
      `the base, or someone removed it). Fix that, then queue it again: ghx pr land ${o.ref}.`,
    details: {
      ref: o.ref,
      headSha: o.head,
      reason: ev?.reason ?? null,
      removedBy: ev?.by ?? null,
      removedAt: ev?.at ?? null,
      lastState: last?.state ?? null,
    },
  });
}

/**
 * Wait until the queue has merged the PR (`merged`), dropped it (MERGE_QUEUE_DROPPED), the head moved
 * (HEAD_MOVED), the PR was closed (PR_NOT_OPEN) or `returnAt` passed (`pending`). An abort rejects.
 */
export async function waitForQueue(o: QueueWaitOptions): Promise<QueueWait> {
  const { clock } = o.ctx;
  let last = o.entry;
  let out = 0;
  let failures = 0;
  for (;;) {
    let read: QueueRead | null = null;
    try {
      read = await readQueue(o);
      failures = 0;
    } catch (e) {
      rethrowControlFlow(e);
      // Like a failed ci wait tick: a gh failure is retried on the next poll, a few times in a row.
      if (!(e instanceof GhFailure) || e.code === 'PR_NOT_FOUND' || ++failures >= MAX_QUEUE_READ_FAILURES) throw e;
      o.ctx.warn({
        code: 'MERGE_QUEUE_RETRY',
        message: `The merge queue could not be read (${e.message}); retrying on the next poll.`,
      });
    }
    if (read !== null) {
      if (read.state === 'MERGED') {
        if (read.headSha !== o.head) {
          throw new GhxError(
            'READBACK_MISMATCH',
            `${o.ref} was merged, but at head ${short(read.headSha)}, not ${short(o.head)}.`,
            {
              hint: `Check the merge: ghx pr status ${o.ref}.`,
              details: { ref: o.ref, field: 'head', sent: o.head, stored: read.headSha },
            },
          );
        }
        return { kind: 'merged', mergeCommit: read.mergeCommit, mergedAt: read.mergedAt };
      }
      if (read.state !== 'OPEN') throw notOpen(o, read.state);
      // A push takes the PR out of the queue: the queued commit is no longer the one that was evaluated.
      if (read.headSha !== o.head) throw headMovedError(o.ref, o.head, read.headSha, { queued: read.entry !== null });
      if (read.entry) {
        last = read.entry;
        out = 0;
        o.onEntry?.(read.entry);
      } else {
        const mergedEvent = removalOf(last, read)?.reason?.toLowerCase() === 'merged';
        if (++out >= (mergedEvent ? MERGED_EVENT_CONFIRM_READS : DROP_CONFIRM_READS)) throw droppedError(o, last, read);
      }
    }
    if (clock.monotonic() + QUEUE_POLL_MS > o.returnAt) return { kind: 'pending', entry: last };
    await clock.sleep(QUEUE_POLL_MS, o.ctx.signal);
  }
}
