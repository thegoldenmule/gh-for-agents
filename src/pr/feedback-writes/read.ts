// The read behind every feedback write (02 §7): GraphQL Q1 (src/pr/snapshot/query.ts) gives the PR's state,
// head, author and viewer, and every comment, review and thread body. The writes need the bodies for two
// things: ids unique per PR (02 §1.4), and, for `pr resolve`, the fold and the thread ids. No mergeable
// retry, stack query or facts: a write needs none of them.
import type { Context } from '../../core/command.ts';
import { GhxError } from '../../core/errors.ts';
import type { FeedbackInput } from '../../feedback/fold.ts';
import { formatPrRef, parseTargetRef } from '../../gh/refs.ts';
import { enrichNotFound, type ResolvedRepo } from '../../gh/repo.ts';
import type { RepoRef } from '../../gh/types.ts';
import { IdAllocator } from '../../meta/ids.ts';
import { readBlocks } from '../../meta/schemas.ts';
import { fetchQ1, type Q1Result } from '../snapshot/query.ts';

export interface WriteTarget {
  resolved: ResolvedRepo;
  repo: RepoRef;
  number: number;
  /** owner/repo#N. */
  ref: string;
}

/** Resolve `<pr>` (N, #N, owner/repo#N or a PR URL) and the target repo (02 §1.2). */
export async function resolveTarget(ctx: Context, selector: string): Promise<WriteTarget> {
  const target = parseTargetRef(selector);
  if (target.kind !== 'pr') {
    throw new GhxError('USAGE_BAD_SELECTOR', `'${selector}' is not a PR selector.`, {
      hint: 'Use 3198, #3198, owner/repo#3198 or a PR URL.',
    });
  }
  const resolved = await ctx.repo({ ref: target.repo });
  return { resolved, repo: resolved.repo, number: target.number, ref: formatPrRef(resolved.repo, target.number) };
}

export interface PrForWrite {
  q1: Q1Result;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  headSha: string;
  baseSha: string;
  authorLogin: string | null;
  viewerLogin: string;
  /** Every ghx id already on the PR (any author, any block), so new ids never collide. */
  existingIds: Set<string>;
  /** Q1's three sources in the fold's input shape. */
  feedbackInput(config: FeedbackInput['config']): FeedbackInput;
}

/** Every block id in the PR body and its comments, reviews and thread comments. */
export function idsOnPr(q1: Q1Result): Set<string> {
  const bodies = [
    q1.pr.body,
    ...q1.issueComments.map((c) => c.body),
    ...q1.reviews.map((r) => r.body),
    ...q1.threads.flatMap((t) => t.comments.nodes.map((c) => c.body)),
  ];
  const ids = new Set<string>();
  for (const body of bodies) {
    for (const b of readBlocks(body)) {
      if (b.status === 'ok') {
        ids.add(b.block.id);
        if (b.block.t === 'review') for (const f of b.block.findings) ids.add(f);
      } else if (b.status === 'unknown-type') ids.add(b.id);
    }
  }
  return ids;
}

export async function readPrForWrite(ctx: Context, t: WriteTarget): Promise<PrForWrite> {
  let q1: Q1Result;
  try {
    q1 = await fetchQ1({ gh: ctx.gh, repo: t.repo, number: t.number, warn: ctx.warn });
  } catch (e) {
    throw enrichNotFound(e, t.resolved, `PR #${t.number}`);
  }
  return {
    q1,
    state: q1.pr.state,
    headSha: q1.pr.headRefOid,
    baseSha: q1.pr.baseRefOid,
    authorLogin: q1.pr.author?.login ?? null,
    viewerLogin: q1.viewerLogin,
    existingIds: idsOnPr(q1),
    feedbackInput: (config) => ({
      issueComments: q1.issueComments,
      reviews: q1.reviews,
      reviewThreads: q1.threads,
      viewerLogin: q1.viewerLogin,
      headSha: q1.pr.headRefOid,
      config,
    }),
  };
}

export function idAllocator(ctx: Context, pr: PrForWrite): IdAllocator {
  return new IdAllocator(ctx.random, pr.existingIds);
}

/** PR_NOT_OPEN (9) unless the PR is open. */
export function assertOpen(t: WriteTarget, pr: PrForWrite): void {
  if (pr.state === 'OPEN') return;
  throw new GhxError('PR_NOT_OPEN', `${t.ref} is ${pr.state}.`, {
    hint: pr.state === 'MERGED' ? 'It is merged; open a new PR for follow-up work.' : 'Reopen it in the UI first.',
    details: { state: pr.state },
  });
}
