// ghx pr ready <pr> [--undo]: toggle draft on any open PR, ghx block or not (gh pr ready). Draft is not
// in the body, so nothing needs validating or adopting: snapshot, one GraphQL transition, read back.
import { z } from 'zod';
import { defineCommand } from '../../core/command.ts';
import { GhxError } from '../../core/errors.ts';
import { formatPrRef, parseTargetRef } from '../../gh/refs.ts';
import { enrichNotFound } from '../../gh/repo.ts';
import { fetchPrSnapshot, setDraft } from '../../pr/edit/snapshot.ts';
import { PrRef } from '../../schemas/common.ts';

export default defineCommand({
  name: ['pr', 'ready'],
  summary: 'Mark a PR ready for review, or back to draft with --undo; any PR, no ghx block needed',
  description:
    'Toggles draft through GraphQL and reads it back. A PR already in the wanted state is a no-op (changed: false). ' +
    'Works on PRs ghx did not open; for other edits use ghx pr edit.',
  kind: 'write',
  input: z.strictObject({
    pr: z.string().min(1).describe('PR: 3198, #3198, owner/repo#3198 or a PR URL'),
    undo: z.boolean().optional().describe('Convert the PR back to a draft (gh pr ready --undo)'),
    draft: z.boolean().optional().describe('Same as --undo'),
  }),
  output: z.object({
    ref: PrRef.describe('owner/repo#N'),
    url: z.string().url(),
    draft: z.boolean().describe('The draft state after the command'),
    changed: z.boolean().describe('false when the PR was already in that state'),
    next: z.array(z.string()),
  }),
  positionals: ['pr'],
  needs: { repo: 'inferred', config: 'none' },
  brief: ['ref', 'draft', 'changed', 'next'],
  replaces: ['gh pr ready'],
  examples: [
    { argv: 'ghx pr ready octo/demo#12', note: 'mark it ready for review' },
    { argv: 'ghx pr ready 12 --undo', note: 'convert it back to a draft' },
  ],
  async run(input, ctx) {
    const target = parseTargetRef(input.pr);
    if (target.kind !== 'pr') {
      throw new GhxError('USAGE_BAD_SELECTOR', `'${input.pr}' is not a PR selector.`, {
        hint: 'Use 3198, #3198, owner/repo#3198 or a PR URL.',
      });
    }
    const resolved = await ctx.repo({ ref: target.repo });
    const repo = resolved.repo;
    const ref = formatPrRef(repo, target.number);
    const want = input.undo === true || input.draft === true;
    try {
      const pr = await fetchPrSnapshot(ctx.gh, repo, target.number);
      if (pr.state !== 'OPEN') {
        throw new GhxError('PR_NOT_OPEN', `${ref} is ${pr.state}.`, {
          hint: 'Reopen it in the UI or create a new PR.',
          details: { state: pr.state },
        });
      }
      const next = [`ghx pr status ${ref}`];
      if (pr.isDraft === want) return { ref, url: pr.url, draft: want, changed: false, next };
      ctx.preview({ ref, draft: want });
      await setDraft(ctx.gh, repo, pr.id, want);
      const after = await fetchPrSnapshot(ctx.gh, repo, target.number);
      if (after.isDraft !== want) {
        throw new GhxError('READBACK_MISMATCH', `${ref} was edited, but GitHub stored draft ${after.isDraft}.`, {
          hint: `Re-read it with ghx pr status ${ref}, then re-run ghx pr ready if it is still wrong.`,
          details: { field: 'draft', sent: want, stored: after.isDraft },
        });
      }
      return { ref, url: after.url, draft: want, changed: true, next };
    } catch (e) {
      throw enrichNotFound(e, resolved, `PR #${target.number}`);
    }
  },
});
