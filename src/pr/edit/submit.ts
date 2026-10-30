// The `pr edit` write (02 §3 gh calls 3–6): re-read the PR and refuse a concurrent change (CONCURRENT_EDIT),
// PATCH the changed fields as JSON on stdin (`gh api -X PATCH … --input -`), flip draft through GraphQL,
// then read back and require the exact title, body, base and draft (READBACK_MISMATCH, 03 §1 row 11).
import type { Context } from '../../core/command.ts';
import { GhxError } from '../../core/errors.ts';
import { DEFAULT_RETRY } from '../../gh/retry.ts';
import type { RepoRef } from '../../gh/types.ts';
import { assertReadback, PullData, readPull } from '../create/submit.ts';
import type { EditPlan } from './plan.ts';
import { fetchPrSnapshot, setDraft } from './snapshot.ts';

export interface Applied {
  url: string;
  title: string;
  base: string;
  draft: boolean;
  body: string;
}

/** Re-read, PATCH, set draft, read back. A plan with nothing to change makes no call. */
export async function applyEdit(ctx: Context, repo: RepoRef, plan: EditPlan): Promise<Applied> {
  const pr = plan.snapshot;
  const target: Applied = {
    url: pr.url,
    title: plan.title,
    base: plan.base,
    draft: plan.draft ?? pr.isDraft,
    body: plan.body,
  };
  if (plan.changed.length === 0) return target;

  // GitHub's PATCH has no If-Match, so this re-read, right before the PATCH, is the only guard against
  // overwriting a change made since the snapshot (another agent, or a UI edit). It compares what the PATCH
  // would overwrite, the title and body, not updatedAt, which unrelated activity (a comment, a push, a
  // label) also bumps. An edit landing between this read and the PATCH is still lost; that window cannot
  // be closed without an If-Match.
  const now = await fetchPrSnapshot(ctx.gh, repo, pr.number);
  const titleChanged = now.title !== pr.title;
  const bodyChanged = now.body !== pr.body;
  if (titleChanged || bodyChanged) {
    const what = [titleChanged ? 'title' : null, bodyChanged ? 'body' : null].filter((x) => x !== null).join(' and ');
    throw new GhxError('CONCURRENT_EDIT', `The ${what} of ${plan.ref} changed since it was read.`, {
      hint: 'Re-run the same command; it re-reads the PR.',
      details: { before: pr.updatedAt, after: now.updatedAt, titleChanged, bodyChanged },
    });
  }

  if (Object.keys(plan.rest).length > 0) {
    const r = await ctx.gh.api(
      { method: 'PATCH', path: `repos/{owner}/{repo}/pulls/${pr.number}`, repo, body: plan.rest },
      PullData,
      // Setting the same title, body and base twice equals once.
      { notFound: 'PR_NOT_FOUND', retry: { ...DEFAULT_RETRY, idempotent: true } },
    );
    if (r.notModified) throw new GhxError('INTERNAL', 'PATCH pulls returned 304.');
  }
  if (plan.draft !== null) await setDraft(ctx.gh, repo, pr.id, plan.draft);

  const stored = await readPull(ctx, repo, pr.number);
  const { url: _url, ...want } = target;
  assertReadback(repo, stored, want, {
    verb: 'edited',
    hint: (field, ref) =>
      `Re-read it with ghx pr status ${ref}, then re-run ghx pr edit if the ${field} is still wrong.`,
  });
  return { ...target, url: stored.html_url };
}
