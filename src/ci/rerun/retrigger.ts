// The parts of `ghx ci retrigger` (02 §13.2; 03 M5.2): close and reopen a PR so GitHub fires fresh
// `pull_request` workflows on the current merge ref, which a rerun cannot do. A closed PR is never left
// behind silently: a failed close is re-read (a timed-out PATCH may have landed), the reopen is retried
// (setting state:open twice equals once, so it is marked idempotent; the close is not), and a reopen that
// still fails is REOPEN_FAILED with a hint to reopen in the UI. New check suites on the head are found by
// diffing suite ids against a baseline read before the close, so no clocks are compared.
import { z } from 'zod';
import type { Clock } from '../../core/clock.ts';
import { rethrowControlFlow } from '../../core/control-flow.ts';
import { GhxError } from '../../core/errors.ts';
import type { Gh } from '../../gh/index.ts';
import { GhFailure } from '../../gh/index.ts';
import type { RetryPolicy } from '../../gh/retry.ts';
import type { RepoRef } from '../../gh/types.ts';
import { githubMessage } from '../../pr/feedback-writes/post.ts';
import { assertExpectHead } from './overrides.ts';

/** 02 §13.2: the reopen is tried 3 times. Only the reopen may repeat: state:open is idempotent. */
export const REOPEN_RETRY: RetryPolicy = { attempts: 3, baseMs: 1_000, maxMs: 8_000, jitter: 0.25, idempotent: true };
/** Suite polling after the reopen: first read at once, then 3 s growing to 10 s. */
export const SUITE_POLL = { initialMs: 3_000, maxMs: 10_000, factor: 1.5 };
/** Check-suite pages of 100 read per poll. */
const SUITE_PAGES = 3;

export const RETRIGGER_PR_QUERY =
  'query($owner:String!,$name:String!,$number:Int!){viewer{login} repository(owner:$owner,name:$name){' +
  'pullRequest(number:$number){number state headRefOid headRefName baseRefName author{__typename login} ' +
  'headRef{name} baseRef{name}}}}';

const PrData = z.object({
  viewer: z.object({ login: z.string() }),
  repository: z
    .object({
      pullRequest: z
        .object({
          number: z.number().int(),
          state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
          headRefOid: z.string(),
          headRefName: z.string(),
          baseRefName: z.string(),
          author: z.object({ __typename: z.string().optional(), login: z.string() }).nullable(),
          headRef: z.object({ name: z.string() }).nullable(),
          baseRef: z.object({ name: z.string() }).nullable(),
        })
        .nullable(),
    })
    .nullable(),
});

export interface RetriggerPr {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  headSha: string;
  headRefName: string;
  baseRefName: string;
  headExists: boolean;
  baseExists: boolean;
  authorLogin: string | null;
  viewerLogin: string;
}

export async function readRetriggerPr(gh: Gh, repo: RepoRef, number: number): Promise<RetriggerPr> {
  const data = await gh.graphql(RETRIGGER_PR_QUERY, { owner: repo.owner, name: repo.name, number }, PrData, {
    repo,
    notFound: 'PR_NOT_FOUND',
  });
  const pr = data.repository?.pullRequest;
  if (!pr) {
    throw new GhxError('PR_NOT_FOUND', `PR ${repo.owner}/${repo.name}#${number} was not found.`, {
      details: { repo: `${repo.owner}/${repo.name}`, number },
    });
  }
  return {
    number: pr.number,
    state: pr.state,
    headSha: pr.headRefOid,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    headExists: pr.headRef !== null,
    baseExists: pr.baseRef !== null,
    authorLogin: pr.author?.login ?? null,
    viewerLogin: data.viewer.login,
  };
}

/** An app author is `name` in GraphQL and `name[bot]` as a viewer (src/pr/snapshot authorOf). */
export function isViewer(pr: Pick<RetriggerPr, 'authorLogin' | 'viewerLogin'>): boolean {
  const a = pr.authorLogin;
  return a !== null && (a === pr.viewerLogin || `${a}[bot]` === pr.viewerLogin);
}

/** 02 §13.2 preflight, in its order: open, head branch, base branch, author, --expect-head. */
export function preflight(
  pr: RetriggerPr,
  o: { ref: string; repo: RepoRef; expectHead?: string | undefined; overrideAuthor: boolean },
): void {
  if (pr.state !== 'OPEN') {
    throw new GhxError('PR_NOT_OPEN', `${o.ref} is ${pr.state}.`, {
      hint:
        pr.state === 'MERGED'
          ? 'It is merged; there is no CI to retrigger.'
          : 'Reopen it in the UI (reopening fires the pull_request workflows).',
      details: { state: pr.state },
    });
  }
  if (!pr.headExists) {
    throw new GhxError(
      'HEAD_BRANCH_MISSING',
      `Head branch '${pr.headRefName}' no longer exists, so a closed PR could not be reopened.`,
      {
        hint: `Push the branch again before retriggering: git push -u origin ${pr.headRefName}`,
        details: { branch: pr.headRefName },
      },
    );
  }
  if (!pr.baseExists) {
    throw new GhxError(
      'BRANCH_MISSING',
      `Base branch '${pr.baseRefName}' does not exist on ${o.repo.owner}/${o.repo.name}.`,
      { hint: 'Retarget the PR to an existing base first (ghx pr edit).', details: { branch: pr.baseRefName } },
    );
  }
  if (!isViewer(pr) && !o.overrideAuthor) {
    throw new GhxError(
      'AUTHOR_NOT_VIEWER',
      `${o.ref} is authored by ${pr.authorLogin ?? 'a deleted user'}, not you (${pr.viewerLogin}).`,
      {
        hint: 'Only act on your own PRs; if the user asked for this one, add --override AUTHOR_NOT_VIEWER --reason "<who asked>".',
        details: { author: pr.authorLogin },
      },
    );
  }
  assertExpectHead(o.ref, pr.headSha, o.expectHead);
}

const CheckSuite = z.object({
  id: z.number().int(),
  app: z.object({ slug: z.string() }).nullable(),
  status: z.string().nullable(),
  conclusion: z.string().nullable(),
  created_at: z.string().nullish(),
});
type CheckSuite = z.infer<typeof CheckSuite>;
const SuitesPage = z.object({ total_count: z.number().int(), check_suites: z.array(CheckSuite) });

/** GET commits/{sha}/check-suites (bounded pages). */
export async function listCheckSuites(gh: Gh, repo: RepoRef, sha: string): Promise<CheckSuite[]> {
  const r = await gh.api(
    {
      path: `repos/{owner}/{repo}/commits/${sha}/check-suites`,
      repo,
      paginate: { maxPages: SUITE_PAGES, perPage: 100, itemsKey: 'check_suites' },
    },
    SuitesPage,
    { notFound: 'REF_NOT_FOUND' },
  );
  if (r.notModified) throw new GhxError('INTERNAL', 'GET check-suites returned 304.');
  return r.data.check_suites;
}

const PullState = z.looseObject({
  state: z.string(),
  closed_at: z.string().nullish(),
  updated_at: z.string().nullish(),
});

function patchState(gh: Gh, repo: RepoRef, number: number, state: 'open' | 'closed', retry?: RetryPolicy) {
  return gh.api({ method: 'PATCH', path: `repos/{owner}/{repo}/pulls/${number}`, repo, body: { state } }, PullState, {
    notFound: 'PR_NOT_FOUND',
    ...(retry ? { retry } : {}),
  });
}

const messageOf = (e: unknown): string =>
  e instanceof GhFailure ? githubMessage(e) : e instanceof Error ? e.message : String(e);

/** Close the PR. A failed PATCH is re-read: a close that landed anyway proceeds to the reopen. */
export async function closePr(o: {
  gh: Gh;
  clock: Clock;
  repo: RepoRef;
  number: number;
}): Promise<{ closedAt: string }> {
  try {
    const r = await patchState(o.gh, o.repo, o.number, 'closed');
    if (r.notModified) throw new GhxError('INTERNAL', 'PATCH pulls returned 304.');
    return { closedAt: r.data.closed_at ?? new Date(o.clock.now()).toISOString() };
  } catch (e) {
    rethrowControlFlow(e);
    const now = await readRetriggerPr(o.gh, o.repo, o.number).catch((re: unknown) => {
      rethrowControlFlow(re);
      return null;
    });
    if (now?.state === 'CLOSED') return { closedAt: new Date(o.clock.now()).toISOString() };
    throw e;
  }
}

/**
 * Reopen the PR (REOPEN_RETRY). If that fails, the PR is re-read: it may have reopened anyway. Still closed
 * is REOPEN_FAILED (exit 7), never a silent success or a generic failure.
 */
export async function reopenPr(o: {
  gh: Gh;
  clock: Clock;
  repo: RepoRef;
  number: number;
  ref: string;
  closedAt: string;
}): Promise<{ reopenedAt: string }> {
  let cause: unknown;
  try {
    const r = await patchState(o.gh, o.repo, o.number, 'open', REOPEN_RETRY);
    if (!r.notModified && r.data.state === 'open') {
      return { reopenedAt: r.data.updated_at ?? new Date(o.clock.now()).toISOString() };
    }
    cause = new Error(`GitHub answered state '${r.notModified ? '304' : r.data.state}'`);
  } catch (e) {
    rethrowControlFlow(e);
    cause = e;
  }
  const now = await readRetriggerPr(o.gh, o.repo, o.number).catch((re: unknown) => {
    rethrowControlFlow(re);
    return null;
  });
  if (now?.state === 'OPEN') return { reopenedAt: new Date(o.clock.now()).toISOString() };
  throw new GhxError(
    'REOPEN_FAILED',
    `${o.ref} was closed to retrigger CI but reopening it failed: ${messageOf(cause)}.`,
    {
      hint: `Ask the user to reopen ${o.ref} in the GitHub UI now.`,
      details: { closedAt: o.closedAt, state: now?.state ?? null },
      cause,
    },
  );
}

export interface NewSuite {
  checkSuiteId: number;
  app: string | null;
  status: string | null;
  createdAt: string | null;
}

/**
 * Poll the head's check suites until one not in `baseline` appears or `windowMs` passes (on `clock`).
 * Returns the new suites, possibly none.
 */
export async function pollNewSuites(o: {
  gh: Gh;
  clock: Clock;
  signal: AbortSignal;
  repo: RepoRef;
  sha: string;
  baseline: ReadonlySet<number>;
  windowMs: number;
}): Promise<NewSuite[]> {
  const end = o.clock.monotonic() + o.windowMs;
  let interval = SUITE_POLL.initialMs;
  for (;;) {
    const fresh = (await listCheckSuites(o.gh, o.repo, o.sha)).filter((s) => !o.baseline.has(s.id));
    if (fresh.length > 0) {
      return fresh.map((s) => ({
        checkSuiteId: s.id,
        app: s.app?.slug ?? null,
        status: s.status,
        createdAt: s.created_at ?? null,
      }));
    }
    const left = end - o.clock.monotonic();
    if (left <= 0) return [];
    await o.clock.sleep(Math.min(interval, left), o.signal);
    interval = Math.min(SUITE_POLL.maxMs, interval * SUITE_POLL.factor);
  }
}
