// ghx pr merge <pr> (02 §8; 03 M8): merge only when policy allows, pinned to the evaluated head.
// The plan (src/pr/merge/plan.ts) runs every check through the shared pr status composition; the merge is
// REST PUT pulls/N/merge with {sha: H, merge_method}, never `gh pr merge`, so the head is pinned server-side.
import { z } from 'zod';
import { MergeMethod } from '../../config/sections/_shared.ts';
import { defineCommand } from '../../core/command.ts';
import { DryRunHalt } from '../../gh/index.ts';
import { afterMerge } from '../../pr/merge/branch.ts';
import { planMerge } from '../../pr/merge/plan.ts';
import { putMerge } from '../../pr/merge/put.ts';
import { PrMergeOutput } from '../../pr/merge/schema.ts';
import { ShaInput } from '../../schemas/common.ts';

const Input = z.strictObject({
  pr: z.string().min(1).describe('PR: 3198, #3198, owner/repo#3198 or a PR URL'),
  expectHead: ShaInput.optional().describe('Refuse with HEAD_MOVED unless the head is this SHA (7–40 hex)'),
  method: MergeMethod.optional().describe('merge (default: merge.method); squash or rebase only when config allows'),
  override: z
    .array(z.string().min(1))
    .optional()
    .describe('Overridable blocker codes the user accepted (CODE or CODE,CODE); needs --reason'),
  reason: z.string().optional().describe('Why the override is allowed (who asked); one line, ≤200 chars'),
  deleteBranch: z
    .boolean()
    .optional()
    .describe('Delete the same-repo head branch after merging (default: merge.deleteBranch); remote ref only'),
});

export default defineCommand({
  name: ['pr', 'merge'],
  summary: 'Merge when policy allows, pinned to the evaluated head; every blocker reported together',
  description:
    'Runs the same checks as ghx pr status merge.ready, then merges with REST PUT pulls/N/merge pinned to the ' +
    'evaluated head. MERGE_BLOCKED lists every blocker: exit 9 when all are GitHub state (wait or fix, then ' +
    're-run), 6 when a ghx policy refused (ask the user; --override CODE --reason "…" only if they accept). ' +
    'Squash or rebase only with an explicit --method that config allows. --dry-run prints the exact PUT.',
  kind: 'write',
  input: Input,
  output: PrMergeOutput,
  positionals: ['pr'],
  needs: { repo: 'inferred', config: 'required' },
  timeout: { defaultMs: 180_000, maxMs: 600_000 },
  brief: [
    'ref',
    'merged',
    'alreadyMerged',
    'method',
    'headSha',
    'mergeCommit',
    'mergedAt',
    'plan.blockers[].code',
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
      argv: 'ghx pr merge 12 --expect-head 9f2c4e1 --delete-branch',
      note: 'Merge, then delete the remote head branch',
    },
  ],
  async run(input, ctx) {
    const d = await planMerge(ctx, input);
    const { plan, snapshot } = d;
    const deleteBranch = input.deleteBranch ?? d.config.merge.deleteBranch;
    const after = () => afterMerge({ ctx, repo: d.repo, snapshot, head: d.head, deleteBranch });
    if (d.kind === 'already-merged') {
      if (ctx.dryRun) {
        ctx.preview({ wouldMerge: false, alreadyMerged: true, mergeCommit: d.mergeCommit, deleteBranch, plan });
        // A branch delete halts at its DELETE; with nothing to send, halt with an empty wouldRun.
        await after();
        throw new DryRunHalt([], undefined);
      }
      const { deletedBranch, children } = await after();
      return {
        ref: snapshot.ref,
        merged: true as const,
        alreadyMerged: true,
        recoveredFromTransient: false,
        method: plan.method,
        headSha: d.head,
        mergeCommit: d.mergeCommit,
        mergedAt: d.mergedAt,
        deletedBranch,
        children,
        plan,
        next: [`ghx ci wait branch:${snapshot.defaultBranch}@${d.mergeCommit}`],
        warnings: [],
      };
    }
    ctx.preview({ wouldMerge: true, deleteBranch, plan });
    const outcome = await putMerge({
      ctx,
      repo: d.repo,
      number: snapshot.number,
      ref: snapshot.ref,
      base: snapshot.base.ref,
      plan,
    });
    const { mergeCommit } = outcome;
    const { deletedBranch, children } = await after();
    return {
      ref: snapshot.ref,
      merged: true as const,
      alreadyMerged: outcome.alreadyMerged,
      recoveredFromTransient: outcome.recoveredFromTransient,
      method: plan.method,
      headSha: d.head,
      mergeCommit,
      mergedAt: outcome.mergedAt,
      deletedBranch,
      children,
      plan,
      next: [`ghx ci wait branch:${snapshot.defaultBranch}@${mergeCommit}`],
      warnings: [],
    };
  },
});
