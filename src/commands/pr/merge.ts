// ghx pr merge <pr> (02 §8; 03 M8): merge only when policy allows, pinned to the evaluated head.
// The plan (src/pr/merge/plan.ts) runs every check through the shared pr status composition; the merge is
// REST PUT pulls/N/merge with {sha: H, merge_method}, never `gh pr merge`, so the head is pinned server-side.
// Where the base branch has a merge queue GitHub refuses that PUT, so the PR is added to the queue instead
// (src/pr/merge/queue.ts: enqueuePullRequest with expectedHeadOid: H, the same pin) and the result is
// `queued`, not `merged`: the queue merges it later, and pr land waits for that.
import { z } from 'zod';
import { MergeMethod } from '../../config/sections/_shared.ts';
import { type Context, defineCommand } from '../../core/command.ts';
import { GhxError } from '../../core/errors.ts';
import { DryRunHalt } from '../../gh/index.ts';
import { afterMerge } from '../../pr/merge/branch.ts';
import { type MergeFlags, planMerge } from '../../pr/merge/plan.ts';
import { readMergePull } from '../../pr/merge/pull.ts';
import { putMerge } from '../../pr/merge/put.ts';
import { enqueue, type QueueEntry } from '../../pr/merge/queue.ts';
import { type MergeQueueResult, PrMergeOutput } from '../../pr/merge/schema.ts';
import { ShaInput } from '../../schemas/common.ts';

const Input = z.strictObject({
  pr: z.string().min(1).describe('PR: 3198, #3198, owner/repo#3198 or a PR URL'),
  expectHead: ShaInput.optional().describe('Refuse with HEAD_MOVED unless the head is this SHA (7–40 hex)'),
  method: MergeMethod.optional().describe(
    'merge (default: merge.method); squash or rebase only when config allows. With a merge queue: must be its method',
  ),
  override: z
    .array(z.string().min(1))
    .optional()
    .describe('Overridable blocker codes the user accepted (CODE or CODE,CODE); needs --reason'),
  reason: z.string().optional().describe('Why the override is allowed (who asked); one line, ≤200 chars'),
  deleteBranch: z
    .boolean()
    .optional()
    .describe(
      'Delete the same-repo head branch after merging (default: merge.deleteBranch); remote ref only. ' +
        'Not needed when the repo deletes head branches on merge: headBranch reports the state either way',
    ),
});

export default defineCommand({
  name: ['pr', 'merge'],
  summary: 'Merge (or add to the merge queue) when policy allows, pinned to the evaluated head',
  description:
    'Runs the same checks as ghx pr status merge.ready, then merges with REST PUT pulls/N/merge pinned to the ' +
    'evaluated head. MERGE_BLOCKED lists every blocker: exit 9 when all are GitHub state (wait or fix, then ' +
    're-run), 6 when a ghx policy refused (ask the user; --override CODE --reason "…" only if they accept). ' +
    'Squash or rebase only with an explicit --method that config allows. Where the base branch has a merge ' +
    'queue (pr status merge.queue.required), the PR is added to the queue instead, pinned to the same head: ' +
    'the result is queued: true, merged: false (exit 0), the queue merges it later with its own method ' +
    '(--method must name it), and ghx pr land waits for that. --dry-run prints the exact PUT, or the ' +
    'enqueue mutation (plan.via: queue).',
  kind: 'write',
  input: Input,
  output: PrMergeOutput,
  positionals: ['pr'],
  needs: { repo: 'inferred', config: 'required' },
  timeout: { defaultMs: 180_000, maxMs: 600_000 },
  brief: [
    'ref',
    'merged',
    'queued',
    'queue.state',
    'queue.position',
    'alreadyMerged',
    'method',
    'headSha',
    'mergeCommit',
    'mergedAt',
    'headBranch.state',
    'plan.blockers.code',
    'next',
  ],
  replaces: ['gh pr merge', 'gh pr merge --match-head-commit', 'gh api -X PUT repos/{owner}/{repo}/pulls/{n}/merge'],
  examples: [
    { argv: 'ghx pr merge 3301 -R powerhouse-inc/powerhouse --expect-head 9f2c4e1', note: 'Merge, pinned to 9f2c4e1' },
    { argv: 'ghx pr merge owner/repo#12 --dry-run', note: 'Every check and the exact PUT, without merging' },
    {
      argv: 'ghx pr merge 12 --override AUTHOR_NOT_VIEWER --reason "user asked in chat"',
      note: "Merge someone else's PR because the user asked",
    },
    {
      argv: 'ghx pr merge 12 --expect-head 9f2c4e1 --method rebase',
      note: 'A base branch with a rebase merge queue: adds the PR to the queue (queued: true)',
    },
    {
      argv: 'ghx pr merge 12 --expect-head 9f2c4e1 --delete-branch',
      note: 'Merge, then delete the remote head branch',
    },
  ],
  run: (input, ctx) => mergePr(input, ctx),
});

/** pr merge's body; pr land calls it with the expected set its wait judged (MergeFlags.expected). */
export async function mergePr(
  input: z.output<typeof Input> & Pick<MergeFlags, 'expected' | 'awaitQueue'>,
  ctx: Context,
): Promise<z.output<typeof PrMergeOutput>> {
  const d = await planMerge(ctx, input);
  const { plan, snapshot } = d;
  const deleteBranch = input.deleteBranch ?? d.config.merge.deleteBranch;
  const after = () => afterMerge({ ctx, repo: d.repo, snapshot, head: d.head, deleteBranch });
  const common = { ref: snapshot.ref, method: plan.method, headSha: d.head, plan, warnings: [] };
  /** The merged document: children, the optional branch delete and the head branch's state come after. */
  const merged = async (m: {
    mergeCommit: string;
    mergedAt: string;
    alreadyMerged: boolean;
    recoveredFromTransient?: boolean;
    queue?: MergeQueueResult;
  }) => {
    const { deletedBranch, headBranch, children } = await after();
    return {
      ...common,
      merged: true,
      queued: false,
      queue: m.queue ?? null,
      alreadyMerged: m.alreadyMerged,
      recoveredFromTransient: m.recoveredFromTransient ?? false,
      mergeCommit: m.mergeCommit,
      mergedAt: m.mergedAt,
      deletedBranch,
      headBranch,
      children,
      next: [`ghx ci wait branch:${snapshot.defaultBranch}@${m.mergeCommit}`],
    };
  };
  if (d.kind === 'already-merged') {
    if (ctx.dryRun) {
      ctx.preview({ wouldMerge: false, alreadyMerged: true, mergeCommit: d.mergeCommit, deleteBranch, plan });
      // A branch delete halts at its DELETE; with nothing to send, halt with an empty wouldRun.
      await after();
      throw new DryRunHalt([], undefined);
    }
    return merged({ mergeCommit: d.mergeCommit, mergedAt: d.mergedAt, alreadyMerged: true });
  }
  if (d.kind === 'merge') {
    ctx.preview({ wouldMerge: true, deleteBranch, plan });
    const outcome = await putMerge({
      ctx,
      repo: d.repo,
      number: snapshot.number,
      ref: snapshot.ref,
      base: snapshot.base.ref,
      plan,
    });
    return merged(outcome);
  }

  // The base branch has a merge queue: the PR is added to it (or is in it already), never merged directly.
  const q = snapshot.mergeQueue;
  const queue = (entry: QueueEntry | null, alreadyQueued: boolean): MergeQueueResult => ({
    method: q?.method ?? null,
    url: q?.url ?? null,
    alreadyQueued,
    state: entry?.state ?? null,
    position: entry?.position ?? null,
    enqueuedAt: entry?.enqueuedAt ?? null,
  });
  const target = { ctx, repo: d.repo, number: snapshot.number, ref: snapshot.ref, head: d.head };
  /** Merged while queued: the merge commit comes from the queue's read, else from one REST read. */
  const mergedByQueue = async (
    m: { mergeCommit: string | null; mergedAt: string | null },
    o: { alreadyMerged: boolean; alreadyQueued: boolean; entry: QueueEntry | null },
  ) => {
    let { mergeCommit, mergedAt } = m;
    if (mergeCommit === null || mergedAt === null) {
      const pull = await readMergePull(ctx.gh, d.repo, snapshot.number);
      mergeCommit ??= pull.merge_commit_sha;
      mergedAt ??= pull.merged_at;
    }
    if (mergeCommit === null || mergedAt === null) {
      throw new GhxError('GH_OUTPUT_UNEXPECTED', `${snapshot.ref} is MERGED but GitHub reports no merge commit.`, {
        hint: `Check the PR on GitHub: ghx pr status ${snapshot.ref}.`,
      });
    }
    // It left the queue by merging: no state or position any more, but when it was queued is kept.
    const left = { ...queue(o.entry, o.alreadyQueued), state: null, position: null };
    return merged({ mergeCommit, mergedAt, alreadyMerged: o.alreadyMerged, queue: left });
  };
  let entry: QueueEntry | null;
  let alreadyQueued: boolean;
  if (d.kind === 'queued') {
    if (ctx.dryRun) {
      ctx.preview({ wouldMerge: false, wouldQueue: false, alreadyQueued: true, queue: queue(d.entry, true), plan });
      throw new DryRunHalt([], undefined);
    }
    entry = d.entry;
    alreadyQueued = true;
  } else {
    // Not a merge: the queue merges it later, with its own method. Under --dry-run the mutation halts here.
    ctx.preview({ wouldMerge: false, wouldQueue: true, queue: queue(null, false), deleteBranch, plan });
    const r = await enqueue({ ...target, plan });
    if (r.kind === 'merged') return mergedByQueue(r, { alreadyMerged: true, alreadyQueued: false, entry: null });
    entry = r.entry;
    alreadyQueued = r.alreadyQueued;
  }
  if (input.awaitQueue) {
    const w = await input.awaitQueue({ ...target, entry });
    if (w.kind === 'merged') return mergedByQueue(w, { alreadyMerged: false, alreadyQueued, entry });
    entry = w.entry ?? entry;
  }
  if (deleteBranch) {
    ctx.warn({
      code: 'BRANCH_NOT_DELETED',
      message: `${snapshot.head.ref} was kept: ${snapshot.ref} is in the merge queue, not merged yet. ghx pr land deletes it once the queue has merged.`,
    });
  }
  const land = `ghx pr land ${snapshot.ref}${input.method ? ` --method ${input.method}` : ''}`;
  return {
    ...common,
    merged: false,
    queued: true,
    queue: queue(entry, alreadyQueued),
    alreadyMerged: false,
    recoveredFromTransient: false,
    mergeCommit: null,
    mergedAt: null,
    deletedBranch: false,
    headBranch: {
      state: snapshot.head.crossRepository ? ('unknown' as const) : ('present' as const),
      deletedBy: null,
      autoDelete: snapshot.repoSettings.deleteBranchOnMerge,
    },
    children: snapshot.stack.children.map((c) => ({ ref: c.ref, base: snapshot.head.ref })),
    next: [land],
  };
}
