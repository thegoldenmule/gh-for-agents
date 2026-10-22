// ghx pr merge <pr> (02 §8; 03 M8): merge only when policy allows, pinned to the evaluated head.
// The plan (src/pr/merge/plan.ts) runs every check through the shared pr status composition; the merge is
// REST PUT pulls/N/merge with {sha: H, merge_method}, never `gh pr merge`, so the head is pinned server-side.
import { z } from 'zod';
import { MergeMethod } from '../../config/sections/_shared.ts';
import { defineCommand } from '../../core/command.ts';
import { GhxError } from '../../core/errors.ts';
import { planMerge } from '../../pr/merge/plan.ts';
import { readMergePull } from '../../pr/merge/pull.ts';
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
});

const PutResponse = z.object({ sha: z.string(), merged: z.boolean(), message: z.string().optional() });

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
  replaces: ['gh pr merge', 'gh pr merge --match-head-commit', 'gh api -X PUT repos/{owner}/{repo}/pulls/{n}/merge'],
  examples: [
    { argv: 'ghx pr merge 3301 -R powerhouse-inc/powerhouse --expect-head 9f2c4e1', note: 'Merge, pinned to 9f2c4e1' },
    { argv: 'ghx pr merge owner/repo#12 --dry-run', note: 'Every check and the exact PUT, without merging' },
    {
      argv: 'ghx pr merge 12 --override AUTHOR_NOT_VIEWER --reason "user asked in chat"',
      note: "Merge someone else's PR because the user asked",
    },
  ],
  async run(input, ctx) {
    const d = await planMerge(ctx, input);
    const { plan, snapshot } = d;
    const children = snapshot.stack.children.map((c) => ({ ref: c.ref, base: snapshot.head.ref }));
    if (d.kind === 'already-merged') {
      return {
        ref: snapshot.ref,
        merged: true as const,
        alreadyMerged: true,
        recoveredFromTransient: false,
        method: plan.method,
        headSha: d.head,
        mergeCommit: d.mergeCommit,
        mergedAt: d.mergedAt,
        deletedBranch: false,
        children,
        plan,
        next: [`ghx ci wait branch:${snapshot.defaultBranch}@${d.mergeCommit}`],
        warnings: [],
      };
    }
    ctx.preview({ wouldMerge: true, plan });
    const put = await ctx.gh.api(
      { method: 'PUT', path: plan.request.path, repo: d.repo, body: plan.request.body },
      PutResponse,
      { retry: 'none', notFound: 'PR_NOT_FOUND' },
    );
    if (put.notModified) throw new GhxError('INTERNAL', 'PUT pulls/N/merge returned 304.');
    const pull = await readMergePull(ctx.gh, d.repo, snapshot.number);
    const mergeCommit = pull.merge_commit_sha ?? put.data.sha;
    return {
      ref: snapshot.ref,
      merged: true as const,
      alreadyMerged: false,
      recoveredFromTransient: false,
      method: plan.method,
      headSha: d.head,
      mergeCommit,
      mergedAt: pull.merged_at ?? new Date(ctx.clock.now()).toISOString(),
      deletedBranch: false,
      children,
      plan,
      next: [`ghx ci wait branch:${snapshot.defaultBranch}@${mergeCommit}`],
      warnings: [],
    };
  },
});
