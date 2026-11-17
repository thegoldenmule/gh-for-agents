// After the merge (02 §8.1 steps 9–10; 03 M8.3): list the PR's children and, when asked, delete the head
// branch. Children are read fresh (a PR may have been stacked since the snapshot). The branch is deleted
// only when --delete-branch or merge.deleteBranch asks, the head is in this repo, no open PR is based on it,
// it is neither the default nor the base branch, and the remote ref still points at the merged head (a
// later push is never thrown away). Only the remote ref is deleted; local branches are never touched.
// The merge already happened, so nothing here throws: every problem is a warning.
// headBranch reports the branch's state whoever removed it: when ghx did not delete it, the same-repo ref is
// read once, so a repo that deletes head branches on merge (delete_branch_on_merge) reads as deleted by
// GitHub, not as left behind. GitHub deletes asynchronously, so right after the PUT the ref may still be
// there: that is `present` with `autoDelete: true`, never a wait.
import { z } from 'zod';
import type { Context } from '../../core/command.ts';
import { rethrowControlFlow } from '../../core/control-flow.ts';
import { GhFailure } from '../../gh/index.ts';
import { formatPrRef } from '../../gh/refs.ts';
import type { RepoRef } from '../../gh/types.ts';
import type { PrSnapshot } from '../snapshot/index.ts';
import type { HeadBranch, MergeChild } from './schema.ts';

export interface AfterMergeOptions {
  ctx: Context;
  repo: RepoRef;
  snapshot: Pick<PrSnapshot, 'ref' | 'head' | 'base' | 'defaultBranch' | 'stack' | 'repoSettings'>;
  /** The merged (pinned) head. */
  head: string;
  deleteBranch: boolean;
}

export interface AfterMerge {
  deletedBranch: boolean;
  headBranch: HeadBranch;
  children: MergeChild[];
}

const OpenPulls = z.array(z.object({ number: z.number().int(), base: z.object({ ref: z.string() }) }));
const GitRef = z.object({ object: z.object({ sha: z.string() }) });

/** A branch name as a REST path: each segment encoded, the slashes kept. */
const refPath = (branch: string) => branch.split('/').map(encodeURIComponent).join('/');
const short = (sha: string) => sha.slice(0, 7);

function is404(e: unknown): boolean {
  return e instanceof GhFailure && (e.failure.status === 404 || e.failure.code === 'GH_NOT_FOUND');
}

/** Open PRs based on the head branch, read now; null when they could not be read. */
async function freshChildren(o: AfterMergeOptions): Promise<MergeChild[] | null> {
  const branch = o.snapshot.head.ref;
  if (o.snapshot.head.crossRepository) return [];
  try {
    const r = await o.ctx.gh.api(
      {
        path: 'repos/{owner}/{repo}/pulls',
        repo: o.repo,
        fields: { state: 'open', base: branch, per_page: 100 },
      },
      OpenPulls,
    );
    if (r.notModified) return null;
    return r.data.map((p) => ({ ref: formatPrRef(o.repo, p.number), base: p.base.ref }));
  } catch (e) {
    rethrowControlFlow(e);
    return null;
  }
}

/** Why the branch must be kept, or null when it may be deleted. */
function keepReason(o: AfterMergeOptions, children: MergeChild[] | null): string | null {
  const s = o.snapshot;
  const b = s.head.ref;
  if (s.head.crossRepository) return `the head ${s.head.repo ?? 'fork'}:${b} is in another repository`;
  if (b === s.defaultBranch || b === s.base.ref)
    return `${b} is the ${b === s.defaultBranch ? 'default' : 'base'} branch`;
  if (children === null) return `the PRs based on ${b} could not be read`;
  if (children.length > 0) {
    return `${children.map((c) => c.ref).join(', ')} ${children.length === 1 ? 'is' : 'are'} based on ${b}`;
  }
  return null;
}

type RefRead = { kind: 'at'; sha: string } | { kind: 'gone' } | { kind: 'failed'; error: unknown };

/** The head branch's remote ref, read now. */
async function readRef(o: AfterMergeOptions): Promise<RefRead> {
  const b = o.snapshot.head.ref;
  try {
    const r = await o.ctx.gh.api({ path: `repos/{owner}/{repo}/git/ref/heads/${refPath(b)}`, repo: o.repo }, GitRef, {
      notFound: 'REF_NOT_FOUND',
    });
    if (r.notModified) throw new Error('unreachable: unconditional request returned 304');
    return { kind: 'at', sha: r.data.object.sha };
  } catch (e) {
    rethrowControlFlow(e);
    return is404(e) ? { kind: 'gone' } : { kind: 'failed', error: e };
  }
}

const branch = (
  o: AfterMergeOptions,
  state: HeadBranch['state'],
  deletedBy: HeadBranch['deletedBy'] = null,
): HeadBranch => ({ state, deletedBy, autoDelete: o.snapshot.repoSettings.deleteBranchOnMerge });
const present = (o: AfterMergeOptions) => branch(o, 'present');
const unknown = (o: AfterMergeOptions) => branch(o, 'unknown');
/** Deleted, not by ghx: by GitHub when the repo deletes head branches on merge, else by someone unknown. */
const deletedElsewhere = (o: AfterMergeOptions) =>
  branch(o, 'deleted', o.snapshot.repoSettings.deleteBranchOnMerge ? 'github' : 'unknown');

/** Gone, and ghx did not delete it: GitHub did when the repo deletes head branches on merge. */
function goneBefore(o: AfterMergeOptions): HeadBranch {
  if (!o.snapshot.repoSettings.deleteBranchOnMerge) {
    o.ctx.warn({
      code: 'BRANCH_ALREADY_DELETED',
      message: `${o.snapshot.head.ref} no longer exists on the remote, though the repository does not delete merged branches.`,
    });
  }
  return deletedElsewhere(o);
}

/** The branch's state when ghx did not try to delete it. A fork head is not read. */
async function probe(o: AfterMergeOptions): Promise<HeadBranch> {
  if (o.snapshot.head.crossRepository) return unknown(o);
  const r = await readRef(o);
  if (r.kind === 'at') return present(o);
  if (r.kind === 'gone') return deletedElsewhere(o);
  o.ctx.warn({
    code: 'BRANCH_STATE_UNKNOWN',
    message: `Whether ${o.snapshot.head.ref} still exists could not be read (${errText(r.error)}).`,
  });
  return unknown(o);
}

async function deleteRef(o: AfterMergeOptions): Promise<HeadBranch> {
  const { ctx, repo, head } = o;
  const b = o.snapshot.head.ref;
  const r = await readRef(o);
  if (r.kind === 'gone') return goneBefore(o);
  if (r.kind === 'failed') {
    ctx.warn({
      code: 'BRANCH_DELETE_FAILED',
      message: `${b} was kept: its ref could not be read (${errText(r.error)}).`,
    });
    return unknown(o);
  }
  if (r.sha !== head) {
    ctx.warn({
      code: 'BRANCH_NOT_DELETED',
      message: `${b} was kept: it is at ${short(r.sha)}, not the merged head ${short(head)}, so it has newer commits.`,
    });
    return present(o);
  }
  try {
    await ctx.gh.apiText({ method: 'DELETE', path: `repos/{owner}/{repo}/git/refs/heads/${refPath(b)}`, repo });
    return branch(o, 'deleted', 'ghx');
  } catch (e) {
    rethrowControlFlow(e);
    if (
      is404(e) ||
      (e instanceof GhFailure &&
        e.failure.status === 422 &&
        /Reference does not exist/i.test(e.message + (e.result?.stdout ?? '')))
    ) {
      // Gone between the read and the DELETE: GitHub's own delete won the race.
      return goneBefore(o);
    }
    ctx.warn({
      code: 'BRANCH_DELETE_FAILED',
      message: `Deleting ${b} failed: ${errText(e)}. The merge itself succeeded.`,
    });
    return present(o);
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Children, the optional branch delete and the head branch's state. Never throws for a GitHub failure. */
export async function afterMerge(o: AfterMergeOptions): Promise<AfterMerge> {
  const fresh = await freshChildren(o);
  if (fresh === null) {
    o.ctx.warn({
      code: 'CHILDREN_UNKNOWN',
      message: `The PRs based on ${o.snapshot.head.ref} could not be re-read; children are from before the merge.`,
    });
  }
  const children = fresh ?? o.snapshot.stack.children.map((c) => ({ ref: c.ref, base: o.snapshot.head.ref }));
  if (!o.deleteBranch) return { deletedBranch: false, headBranch: await probe(o), children };
  const keep = keepReason(o, fresh);
  if (keep !== null) {
    o.ctx.warn({ code: 'BRANCH_NOT_DELETED', message: `${o.snapshot.head.ref} was kept: ${keep}.` });
    return { deletedBranch: false, headBranch: await probe(o), children };
  }
  const headBranch = await deleteRef(o);
  return { deletedBranch: headBranch.deletedBy === 'ghx', headBranch, children };
}
