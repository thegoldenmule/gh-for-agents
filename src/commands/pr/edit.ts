// ghx pr edit <pr> (02 §3, 03 M10.1): patch a ghx PR. The patch merges into the hidden `pr` block (arrays
// replace), the result passes the full createRules plus the network checks, the body is re-rendered with
// rev+1, and the PR is PATCHed via `gh api --input -` and read back exactly. draft:false replaces
// `gh pr ready`; base replaces `gh pr edit --base`.
import { z } from 'zod';
import { defineCommand } from '../../core/command.ts';
import { GhxError, mapZodIssues } from '../../core/errors.ts';
import { suggest } from '../../core/suggest.ts';
import { parseTargetRef } from '../../gh/refs.ts';
import { enrichNotFound } from '../../gh/repo.ts';
import { repoSlug, sameRepo } from '../../gh/types.ts';
import { validationError } from '../../pr/create/rules.ts';
import { PrCreateInput, PrEditInput } from '../../pr/create/schema.ts';
import { planEdit } from '../../pr/edit/plan.ts';
import { applyEdit } from '../../pr/edit/submit.ts';
import { PrRef } from '../../schemas/common.ts';

// Every patch field arrives through --input only (02 §0: prose is JSON, never flags).
const patchShape = PrCreateInput.omit({ head: true })
  .partial()
  .extend({ adopt: z.boolean().optional().describe('Adopt a PR that has no ghx block (needs every field)') }).shape;
const jsonFields = Object.fromEntries(
  Object.entries(patchShape).map(([k, s]) => [k, s.meta({ jsonOnly: true })]),
) as typeof patchShape;

const Input = z
  .strictObject({
    pr: z.string().min(1).describe('PR: 3198, #3198, owner/repo#3198 or a PR URL'),
    discardUiEdits: z
      .boolean()
      .optional()
      .describe('Proceed when the visible description or title was edited outside ghx; the block wins'),
    ...jsonFields,
  })
  .describe('A patch of the PR object (02 §3): any pr create field except head; arrays replace');

const Output = z.object({
  ref: PrRef.describe('owner/repo#N'),
  url: z.string().url(),
  rev: z.number().int().min(1).describe('The block revision after the edit'),
  blockId: z.string(),
  adopted: z.boolean().describe('true when this edit wrote the first ghx block'),
  changed: z.array(z.enum(['title', 'body', 'base', 'draft'])).describe('Empty when the PR already matched'),
  title: z.string(),
  base: z.string(),
  draft: z.boolean(),
  body: z.string(),
  next: z.array(z.string()),
});

const EXAMPLE = { description: 'Requests retried after a transient failure now show a banner the user can dismiss.' };

export default defineCommand({
  name: ['pr', 'edit'],
  summary: 'Patch a ghx PR: re-validated, block rev+1, retarget or draft toggle, exact read-back',
  description:
    'Write the patch with your file tool and pass --input patch.json; only the fields to change. ' +
    'DESCRIPTION_DRIFT when the visible text was edited in the UI (include it, or --discard-ui-edits); ' +
    'NO_BLOCK unless "adopt": true with the full object. ' +
    'components follows pr create: past 5 touched, the 5 primary ones (ghx records the rest). ' +
    'GH_FORBIDDEN unless you have write access or opened the PR yourself (GitHub lets authors edit their own PRs). ' +
    'CONCURRENT_EDIT when the title or body changed since the read; GitHub has no If-Match, so an edit made ' +
    'in the moment between the final re-read and the PATCH is still overwritten.',
  kind: 'write',
  input: Input,
  output: Output,
  positionals: ['pr'],
  needs: { repo: 'inferred', config: 'required' },
  jsonInput: 'required',
  timeout: { defaultMs: 120_000, maxMs: 600_000 },
  replaces: ['gh pr edit', 'gh pr ready'],
  examples: [
    { argv: 'ghx pr edit octo/demo#12 --input -', note: 'or --input patch.json', input: EXAMPLE },
    { argv: 'ghx pr edit 12 --input patch.json --dry-run', note: 'validate and render without editing' },
    { argv: 'ghx pr edit 12 --input ready.json', note: '{"draft": false} marks it ready for review' },
  ],
  async run(raw, ctx) {
    const { pr: selector, discardUiEdits, ...rawPatch } = raw;
    const target = parseTargetRef(selector);
    if (target.kind !== 'pr') {
      throw new GhxError('USAGE_BAD_SELECTOR', `'${selector}' is not a PR selector.`, {
        hint: 'Use 3198, #3198, owner/repo#3198 or a PR URL.',
      });
    }
    const patch = PrEditInput.safeParse(rawPatch);
    if (!patch.success) {
      throw validationError(
        mapZodIssues(patch.error, { schema: PrEditInput, input: rawPatch, suggest: (w, c) => suggest(w, c) }),
      );
    }
    const resolved = await ctx.repo({ ref: target.repo });
    const slug = repoSlug(resolved.repo);
    if (resolved.cwdRepo !== undefined && !sameRepo(resolved.cwdRepo, resolved.repo)) {
      ctx.warn({
        code: 'CWD_REPO_MISMATCH',
        message: `The cwd is ${repoSlug(resolved.cwdRepo)} but the target is ${slug}: config came from ${slug} and local git checks were skipped.`,
      });
    }
    const { config } = await ctx.config({ ref: resolved.repo });
    let plan: Awaited<ReturnType<typeof planEdit>>;
    try {
      plan = await planEdit({
        ctx,
        repo: resolved,
        config,
        number: target.number,
        patch: patch.data,
        discardUiEdits: discardUiEdits === true,
      });
    } catch (e) {
      throw enrichNotFound(e, resolved, `PR #${target.number}`);
    }
    for (const w of plan.warnings) ctx.warn(w);
    const result = {
      ref: plan.ref,
      rev: plan.rev,
      blockId: plan.blockId,
      adopted: plan.adopted,
      changed: plan.changed,
    };
    ctx.preview({
      ...result,
      title: plan.input.title,
      base: plan.input.base,
      draft: plan.draft ?? plan.snapshot.isDraft,
      patch: plan.rest,
      body: plan.body,
    });
    const applied = await applyEdit(ctx, resolved.repo, plan);
    return { ...result, ...applied, next: [`ghx pr status ${plan.ref}`] };
  },
});
