// The pinned merge (02 §8.1 steps 7–8; 03 M8.2): REST PUT pulls/N/merge with exactly the plan's request,
// {sha: H, merge_method}, so GitHub refuses server-side if the head moved after the snapshot.
// - 409 is HEAD_MOVED and is never retried; a re-read names the new head for the hint (R01).
// - 405 re-reads the PR: DIRTY is MERGE_CONFLICT with the fetch/merge/push hint, BLOCKED is
//   BLOCKED_BY_PROTECTION (R05). Both are MERGE_BLOCKED blockers, exit 9, as from the plan.
// - A transient failure never blindly re-sends the PUT: it re-reads first. Merged at H is a success with
//   recoveredFromTransient (R16, #3214); open at H gets exactly one more PUT; anything else is reported.
// - Success is verified by polling GET pulls/N until merged, at most VERIFY_MS on the injected clock.
import { z } from 'zod';
import type { Context } from '../../core/command.ts';
import { rethrowControlFlow } from '../../core/control-flow.ts';
import { GhxError } from '../../core/errors.ts';
import { parseIncludeOutput } from '../../gh/api.ts';
import { GhFailure } from '../../gh/index.ts';
import type { RepoRef } from '../../gh/types.ts';
import { checkSpec } from '../../policy/checks.ts';
import { mergeBlockedError } from '../../policy/merge.ts';
import type { MergePlan } from '../../policy/schemas.ts';
import type { Violation } from '../../schemas/pr.ts';
import { headMovedError } from './plan.ts';
import { type MergePull, readMergePull } from './pull.ts';

/** The verify poll's bound (02 §8.1 step 8) and interval. */
export const VERIFY_MS = 10_000;
export const VERIFY_INTERVAL_MS = 1_000;
/** PUT attempts in total: the first, plus one retry after a transient failure re-read open at H. */
export const PUT_ATTEMPTS = 2;
/** Per PUT attempt (the gh layer still caps it at the command deadline). */
export const PUT_TIMEOUT_MS = 60_000;

export interface PutMergeOptions {
  ctx: Context;
  repo: RepoRef;
  number: number;
  ref: string;
  /** The PR base branch, for the conflict hint. */
  base: string;
  plan: MergePlan;
}

export interface MergeOutcome {
  mergeCommit: string;
  mergedAt: string;
  /** A transient PUT failure was followed by a re-read showing the PR merged at H. */
  recoveredFromTransient: boolean;
  /** GitHub refused the PUT because the PR was already merged at H (someone merged it first). */
  alreadyMerged: boolean;
}

const PutResponse = z.object({ sha: z.string(), merged: z.boolean(), message: z.string().optional() });
const short = (sha: string) => sha.slice(0, 7);

/** GitHub's own message for a failed REST call (the JSON body's message), else gh's stderr headline. */
function githubMessage(e: GhFailure): string {
  const body = e.result ? parseIncludeOutput(e.result.stdout).body : '';
  try {
    const m = (JSON.parse(body) as { message?: unknown }).message;
    if (typeof m === 'string' && m !== '') return m;
  } catch {
    // not JSON
  }
  return e.message;
}

/** MERGE_BLOCKED for a refusal GitHub reported at the PUT, with the plan updated to say so. */
function blockedAtPut(plan: MergePlan, code: string, message: string, details: Record<string, unknown>): GhxError {
  const spec = checkSpec(code);
  const blocker: Violation = { code, message, overridable: spec?.overridable ?? false, details };
  const failed = plan.checks.some((c) => c.code === code);
  const updated: MergePlan = {
    ...plan,
    allowed: false,
    checks: failed
      ? plan.checks.map((c) => (c.code === code ? { ...c, status: 'fail' as const, message } : c))
      : [...plan.checks, { code, status: 'fail', message }],
    blockers: [blocker],
  };
  return mergeBlockedError({
    plan: updated,
    warnings: [],
    notices: [],
    ready: false,
    exitClass: spec?.class === 'policy' ? 'policy' : 'state',
  });
}

/** Re-read the PR; a failed re-read is null (the caller still reports what the PUT said). */
async function tryRead(o: PutMergeOptions): Promise<MergePull | null> {
  try {
    return await readMergePull(o.ctx.gh, o.repo, o.number);
  } catch (e) {
    rethrowControlFlow(e);
    return null;
  }
}

function headOf(o: PutMergeOptions): string {
  return String(o.plan.request.body.sha);
}

const mergedAt = (p: MergePull, o: PutMergeOptions) => p.merged_at ?? new Date(o.ctx.clock.now()).toISOString();

/** The PR as re-read after a refused or failed PUT, when it is not merged at H: the error to report. */
function notMergeable(o: PutMergeOptions, pull: MergePull, github: string, status: number | undefined): GhxError {
  const h = headOf(o);
  if (pull.head.sha !== h) {
    return headMovedError(o.ref, h, pull.head.sha, { status: status ?? null, github, merged: pull.merged });
  }
  if (pull.merged) {
    // Unreachable in practice (merged at H is a success); kept so a merged PR is never re-sent.
    return new GhxError('GH_FAILED', `${o.ref} is merged, but GitHub reported: ${github}`, {
      hint: `Check the result: ghx pr status ${o.ref}.`,
      details: { status: status ?? null, github },
    });
  }
  if (pull.state !== 'open') {
    return new GhxError('PR_NOT_OPEN', `${o.ref} is ${pull.state.toUpperCase()}.`, {
      hint: 'Reopen it in the UI or create a new PR.',
      details: { state: pull.state.toUpperCase(), github },
    });
  }
  const b = o.base;
  const ms = (pull.mergeable_state ?? 'unknown').toLowerCase();
  const details = { status: status ?? null, github, mergeableState: ms };
  if (ms === 'dirty') {
    return blockedAtPut(o.plan, 'MERGE_CONFLICT', `${o.ref} conflicts with ${b}.`, {
      ...details,
      hint: `git fetch origin ${b} && git merge origin/${b}, resolve the conflicts, commit, then git push.`,
    });
  }
  if (ms === 'behind') {
    return blockedAtPut(o.plan, 'BEHIND_BASE', `${o.ref} is behind ${b} and the branch must be up to date.`, {
      ...details,
      hint: `git fetch origin ${b} && git merge origin/${b} && git push`,
    });
  }
  if (ms === 'unknown') {
    return blockedAtPut(o.plan, 'MERGEABLE_UNKNOWN', 'GitHub refused the merge and reports mergeability UNKNOWN.', {
      ...details,
      hint: `Re-run in a minute: ghx pr merge ${o.ref} --expect-head ${short(h)}.`,
    });
  }
  if (ms === 'draft') {
    return blockedAtPut(o.plan, 'PR_DRAFT', `${o.ref} is a draft.`, {
      ...details,
      hint: `Mark it ready: ghx pr edit ${o.ref} --input <file with {"draft":false}>.`,
    });
  }
  if (/merges? (are|is) not allowed|not allowed on this repository/i.test(github)) {
    return blockedAtPut(o.plan, 'METHOD_NOT_ALLOWED', `GitHub refused ${o.plan.method}: ${github}`, {
      ...details,
      hint: 'Merge with the default method (omit --method), or ask the user how this repo merges.',
    });
  }
  // BLOCKED, or refused for any other reason (02 §8.2 row 9).
  return blockedAtPut(o.plan, 'BLOCKED_BY_PROTECTION', `GitHub refused the merge: ${github}`, {
    ...details,
    hint: `Check the branch protection rules or rulesets for the base branch: ghx pr status ${o.ref}`,
  });
}

/** Poll GET pulls/N until it reports merged at H; READBACK_MISMATCH after VERIFY_MS (never a false success). */
async function verify(o: PutMergeOptions, putSha: string): Promise<MergeOutcome> {
  const h = headOf(o);
  const until = o.ctx.clock.monotonic() + VERIFY_MS;
  let last: MergePull | null = null;
  for (;;) {
    last = await tryRead(o);
    if (last?.merged) {
      if (last.head.sha !== h) {
        throw new GhxError(
          'READBACK_MISMATCH',
          `${o.ref} was merged, but at head ${short(last.head.sha)}, not ${short(h)}.`,
          {
            hint: `Check the merge: ghx pr status ${o.ref}. Do not re-run pr merge.`,
            details: { ref: o.ref, field: 'head', sent: h, stored: last.head.sha },
          },
        );
      }
      return {
        mergeCommit: last.merge_commit_sha ?? putSha,
        mergedAt: mergedAt(last, o),
        recoveredFromTransient: false,
        alreadyMerged: false,
      };
    }
    if (o.ctx.clock.monotonic() + VERIFY_INTERVAL_MS > until) break;
    await o.ctx.clock.sleep(VERIFY_INTERVAL_MS, o.ctx.signal);
  }
  throw new GhxError(
    'READBACK_MISMATCH',
    `GitHub accepted the merge of ${o.ref}, but the PR did not read back as merged within ${VERIFY_MS / 1000} s.`,
    {
      hint: `Check it: ghx pr status ${o.ref}. Re-running pr merge is safe: a merged PR reports alreadyMerged.`,
      details: { ref: o.ref, field: 'merged', sent: true, stored: last?.merged ?? null, mergeCommit: putSha },
    },
  );
}

/** Send the plan's PUT and classify the result. */
export async function putMerge(o: PutMergeOptions): Promise<MergeOutcome> {
  const h = headOf(o);
  for (let attempt = 1; ; attempt++) {
    let failure: GhFailure;
    try {
      const r = await o.ctx.gh.api(
        { method: 'PUT', path: o.plan.request.path, repo: o.repo, body: o.plan.request.body },
        PutResponse,
        // Never a retry policy: a repeated PUT goes through the re-read below. A slow merge gets a minute.
        { retry: 'none', notFound: 'PR_NOT_FOUND', timeoutMs: PUT_TIMEOUT_MS },
      );
      if (r.notModified) throw new GhxError('INTERNAL', 'PUT pulls/N/merge returned 304.');
      return await verify(o, r.data.sha);
    } catch (e) {
      rethrowControlFlow(e);
      if (!(e instanceof GhFailure)) throw e;
      failure = e;
    }
    const status = failure.failure.status;
    const github = githubMessage(failure);
    if (status === 409) {
      // The head moved after the snapshot: GitHub refused the pinned sha. Never retried.
      const pull = await tryRead(o);
      throw headMovedError(o.ref, h, pull?.head.sha ?? null, { status, github });
    }
    if (status === 405) {
      const pull = await tryRead(o);
      if (pull === null) {
        throw new GhxError('GH_FAILED', `GitHub refused the merge of ${o.ref}: ${github}`, {
          hint: `Check why: ghx pr status ${o.ref}.`,
          details: { status, github },
          cause: failure,
        });
      }
      if (pull.merged && pull.head.sha === h) {
        const sha = pull.merge_commit_sha;
        if (sha)
          return { mergeCommit: sha, mergedAt: mergedAt(pull, o), recoveredFromTransient: false, alreadyMerged: true };
      }
      throw notMergeable(o, pull, github, status);
    }
    if (!failure.failure.transient) throw failure;
    // Transient (#3214): the PUT may have gone through. Look before sending it again.
    const pull = await tryRead(o);
    if (pull?.merged && pull.head.sha === h && pull.merge_commit_sha) {
      return {
        mergeCommit: pull.merge_commit_sha,
        mergedAt: mergedAt(pull, o),
        recoveredFromTransient: true,
        alreadyMerged: false,
      };
    }
    const openAtH = pull !== null && !pull.merged && pull.state === 'open' && pull.head.sha === h;
    if (pull !== null && !openAtH) throw notMergeable(o, pull, github, status);
    if (attempt >= PUT_ATTEMPTS || pull === null) {
      throw new GhxError(
        'GH_FAILED',
        `PUT pulls/${o.number}/merge failed after ${attempt} attempt${attempt === 1 ? '' : 's'}: ${github}`,
        {
          hint:
            pull === null
              ? `The PR could not be re-read, so the merge state is unknown: run ghx pr status ${o.ref} before retrying.`
              : `${o.ref} is still open at ${short(h)}; retry: ghx pr merge ${o.ref} --expect-head ${short(h)}.`,
          details: { ...(failure.details ?? {}), attempts: attempt },
          cause: failure,
        },
      );
    }
  }
}
