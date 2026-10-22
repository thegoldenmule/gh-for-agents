// The `pr create` write (02 §2.6 steps 7–8): POST /pulls as JSON on stdin, never `gh pr create`; a 422
// "already exists" is DUPLICATE_PR; a transient failure re-checks for an open PR before re-posting
// (POST is not idempotent); then the PR is read back and its title and body must match byte for byte
// (title drift, 03 §5.2 R11).
import { z } from 'zod';
import type { Context } from '../../core/command.ts';
import { rethrowControlFlow } from '../../core/control-flow.ts';
import { GhxError } from '../../core/errors.ts';
import { parseIncludeOutput } from '../../gh/api.ts';
import { GhFailure } from '../../gh/index.ts';
import { backoffMs, DEFAULT_RETRY } from '../../gh/retry.ts';
import { type RepoRef, repoSlug } from '../../gh/types.ts';
import { openPrOnHead } from './preflight.ts';

/** POST attempts in total, including the first. */
export const POST_ATTEMPTS = 3;

export interface PullPayload {
  title: string;
  head: string;
  base: string;
  body: string;
  draft: boolean;
}

export const PullData = z.object({
  number: z.number().int().positive(),
  html_url: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  draft: z.boolean().optional(),
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string() }),
});
export type PullData = z.infer<typeof PullData>;

export interface Submitted {
  pull: PullData;
  recoveredFromTransient: boolean;
}

export function prRef(repo: RepoRef, number: number): string {
  return `${repoSlug(repo)}#${number}`;
}

export function duplicateError(repo: RepoRef, head: string, number: number): GhxError {
  const ref = prRef(repo, number);
  return new GhxError('DUPLICATE_PR', `${head} already has open PR ${ref}.`, {
    hint: `Update it instead: ghx pr edit ${ref} --input patch.json`,
    details: { existing: ref },
  });
}

/** GitHub's own message for a 422 (the body's errors[].message, else message). */
function unprocessable(e: GhFailure): string {
  const body = e.result ? parseIncludeOutput(e.result.stdout).body : '';
  try {
    const j = JSON.parse(body) as { message?: string; errors?: { message?: string; code?: string }[] };
    const parts = (j.errors ?? []).map((x) => x.message ?? x.code ?? '').filter((s) => s !== '');
    return parts.length > 0 ? parts.join('; ') : (j.message ?? '');
  } catch {
    return body.trim().slice(0, 300);
  }
}

/** True when an existing PR body carries this run's block id: an earlier attempt that did go through. */
export function isOurs(body: string, blockId: string): boolean {
  return body.includes(`"id":"${blockId}"`);
}

/** POST the PR; returns its number and whether it was found after a transient failure. */
async function post(ctx: Context, repo: RepoRef, payload: PullPayload, blockId: string): Promise<Submitted> {
  const recheck = async (): Promise<Submitted | null> => {
    const open = await openPrOnHead(ctx.gh, repo, payload.head);
    if (open === null) return null;
    if (!isOurs(open.body, blockId)) throw duplicateError(repo, payload.head, open.number);
    return { pull: await readPull(ctx, repo, open.number), recoveredFromTransient: true };
  };
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await ctx.gh.api(
        { method: 'POST', path: 'repos/{owner}/{repo}/pulls', repo, body: payload },
        PullData,
        { retry: 'none' },
      );
      if (r.notModified) throw new GhxError('INTERNAL', 'POST /pulls returned 304.');
      return { pull: r.data, recoveredFromTransient: false };
    } catch (e) {
      rethrowControlFlow(e);
      if (!(e instanceof GhFailure)) throw e;
      if (e.failure.status === 422) {
        const why = unprocessable(e);
        if (/already exists/i.test(why)) {
          const found = await recheck();
          if (found) return found;
          throw new GhxError('DUPLICATE_PR', `GitHub says a PR already exists for ${payload.head}: ${why}`, {
            hint: `Find it with: ghx pr status <ref> -R ${repoSlug(repo)}, then update it with ghx pr edit.`,
            details: { existing: null, github: why },
          });
        }
        if (/no commits between/i.test(why)) {
          throw new GhxError('NO_COMMITS', `${payload.head} has no commits ahead of ${payload.base}.`, {
            hint: 'Commit and push your change first.',
            details: { aheadBy: 0, github: why },
          });
        }
        throw new GhxError('GH_FAILED', `POST /pulls was rejected: ${why || 'HTTP 422'}`, {
          hint: 'Fix the input GitHub rejected, then re-run.',
          details: { status: 422, github: why },
        });
      }
      if (!e.failure.transient) throw e;
      // POST is not idempotent: look before posting again.
      const found = await recheck();
      if (found) return found;
      const wait = backoffMs(attempt, DEFAULT_RETRY, ctx.random, e.failure.retryAfterMs);
      const pastDeadline = ctx.deadline !== undefined && ctx.clock.monotonic() + wait >= ctx.deadline;
      if (attempt >= POST_ATTEMPTS || pastDeadline) {
        throw new GhxError(
          'GH_FAILED',
          `POST /pulls failed after ${attempt} attempt${attempt === 1 ? '' : 's'}: ${e.message}`,
          {
            hint: 'Retry; ghx re-checks for a created PR before re-posting.',
            details: { ...(e.details ?? {}), attempts: attempt },
            cause: e,
          },
        );
      }
      await ctx.clock.sleep(wait, ctx.signal);
    }
  }
}

async function readPull(ctx: Context, repo: RepoRef, number: number): Promise<PullData> {
  const r = await ctx.gh.api({ path: `repos/{owner}/{repo}/pulls/${number}`, repo }, PullData, {
    notFound: 'PR_NOT_FOUND',
  });
  if (r.notModified) throw new GhxError('INTERNAL', 'GET pulls returned 304 without a conditional request.');
  return r.data;
}

/** POST, then read back and assert the exact title and body. */
export async function submitPull(
  ctx: Context,
  repo: RepoRef,
  payload: PullPayload,
  blockId: string,
): Promise<Submitted> {
  const sent = await post(ctx, repo, payload, blockId);
  const stored = sent.recoveredFromTransient ? sent.pull : await readPull(ctx, repo, sent.pull.number);
  const ref = prRef(repo, stored.number);
  for (const field of ['title', 'body'] as const) {
    const want = payload[field];
    const got = stored[field] ?? '';
    if (got !== want) {
      throw new GhxError('READBACK_MISMATCH', `${ref} was created, but GitHub stored a different ${field}.`, {
        hint: `Fix it with: ghx pr edit ${ref} --input patch.json (the PR exists; do not re-run pr create).`,
        details: { ref, url: stored.html_url, field, sent: want, stored: got },
      });
    }
  }
  return { pull: stored, recoveredFromTransient: sent.recoveredFromTransient };
}
