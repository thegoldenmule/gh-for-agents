// ghx pr edit <pr> (02 §3, 03 M10.1): patch a ghx PR. The patch merges into the hidden `pr` block (arrays
// replace), the result passes the full createRules plus the network checks, the body is re-rendered with
// rev+1, and the PR is PATCHed via `gh api --input -` and read back exactly. draft:false replaces
// `gh pr ready`; base replaces `gh pr edit --base`.
import { z } from 'zod';
import { defineCommand } from '../../core/command.ts';
import { GhxError } from '../../core/errors.ts';
import { parseTargetRef } from '../../gh/refs.ts';
import { enrichNotFound } from '../../gh/repo.ts';
import { repoSlug, sameRepo } from '../../gh/types.ts';
import { lenientFields, normalizeInput, structureIssues } from '../../pr/create/check.ts';
import { EDIT_EXAMPLE_HINT, ExampleFields, editExampleOutput } from '../../pr/create/example.ts';
import { validationError } from '../../pr/create/rules.ts';
import { PrCreateInput, type PrEditInput } from '../../pr/create/schema.ts';
import { planEdit } from '../../pr/edit/plan.ts';
import { applyEdit } from '../../pr/edit/submit.ts';
import { PrRef } from '../../schemas/common.ts';

// Every patch field arrives through --input only (02 §0: prose is JSON, never flags). The runner accepts
// any value and any extra key; the handler checks them (with the merged object's rules) in one pass.
const PatchSchema = PrCreateInput.omit({ head: true })
  .partial()
  .extend({ adopt: z.boolean().optional().describe('Adopt a PR that has no ghx block (needs every field)') });
const PATCH_FIELDS = Object.keys(PatchSchema.shape);

const Input = z
  .object({
    pr: z.string().min(1).optional().describe('PR: 3198, #3198, owner/repo#3198 or a PR URL'),
    discardUiEdits: z
      .boolean()
      .optional()
      .describe('Proceed when the visible description or title was edited outside ghx; the block wins'),
    example: z.boolean().optional().describe('Print an example patch and the rules for this repo'),
    ...lenientFields(PatchSchema.shape),
  })
  .catchall(z.unknown())
  .describe('A patch of the PR object (02 §3): any pr create field except head; arrays replace');

const Result = z.object({
  ref: PrRef.describe('owner/repo#N'),
  url: z.string().url(),
  rev: z.number().int().min(1).nullable().describe('The block revision after the edit; null without a block'),
  blockId: z.string().nullable().describe('null when the PR has no ghx block (a draft or base change alone)'),
  adopted: z.boolean().describe('true when this edit wrote the first ghx block'),
  changed: z.array(z.enum(['title', 'body', 'base', 'draft'])).describe('Empty when the PR already matched'),
  title: z.string(),
  base: z.string(),
  draft: z.boolean(),
  body: z.string(),
  next: z.array(z.string()),
});

/** One schema for both modes: the edit result, or --example's fields. */
const Output = z.object(ExampleFields).extend(Result.partial().shape);

const EXAMPLE = { description: 'Requests retried after a transient failure now show a banner the user can dismiss.' };

export default defineCommand({
  name: ['pr', 'edit'],
  summary: 'Patch a ghx PR: re-validated, block rev+1, retarget or draft toggle, exact read-back',
  description:
    'Write the patch with your file tool and pass --input patch.json; only the fields to change (ghx pr edit --example shows one). ' +
    'Every issue comes back at once (VALIDATION), before any write. ' +
    'DESCRIPTION_DRIFT when the visible text was edited in the UI (include it, or --discard-ui-edits); ' +
    '{"draft": …} or {"base": …} alone works on any PR; other fields on a PR without a ghx block are NO_BLOCK unless "adopt": true with the full object. ' +
    'components follows pr create: past 5 touched, the 5 primary ones (ghx records the rest). ' +
    'GH_FORBIDDEN unless you have write access or opened the PR yourself (GitHub lets authors edit their own PRs). ' +
    'CONCURRENT_EDIT when the title or body changed since the read; GitHub has no If-Match, so an edit made ' +
    'in the moment between the final re-read and the PATCH is still overwritten.',
  kind: 'write',
  input: Input,
  output: Output,
  positionals: ['pr'],
  needs: { repo: 'inferred', config: 'required' },
  jsonInput: 'optional',
  timeout: { defaultMs: 120_000, maxMs: 600_000 },
  brief: ['ref', 'url', 'rev', 'changed', 'draft', 'next'],
  replaces: ['gh pr edit'],
  examples: [
    { argv: 'ghx pr edit octo/demo#12 --input -', note: 'or --input patch.json', input: EXAMPLE },
    { argv: 'ghx pr edit --example', note: 'an example patch and the rules for this repo' },
    { argv: 'ghx pr edit 12 --input patch.json --dry-run', note: 'preview the rendered body without editing' },
    { argv: 'ghx pr ready 12', note: 'mark it ready for review (any PR; --undo converts back to draft)' },
  ],
  async run(raw, ctx) {
    const { pr: selector, discardUiEdits, example, ...rawPatch } = raw;
    if (example === true) {
      const { config } = await ctx.config();
      return editExampleOutput(config);
    }
    if (selector === undefined) {
      throw validationError([
        {
          path: 'pr',
          code: 'invalid_type',
          message: "missing required argument 'pr': ghx pr edit <pr> --input patch.json",
        },
      ]);
    }
    if (Object.keys(rawPatch).length === 0) {
      throw validationError(
        [{ path: '', code: 'custom', message: 'empty patch: give at least one field to change' }],
        null,
        EDIT_EXAMPLE_HINT,
      );
    }
    const target = parseTargetRef(selector);
    if (target.kind !== 'pr') {
      throw new GhxError('USAGE_BAD_SELECTOR', `'${selector}' is not a PR selector.`, {
        hint: 'Use 3198, #3198, owner/repo#3198 or a PR URL.',
      });
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
    // The patch's own issues are collected, not thrown: planEdit reports them with the merged object's.
    const n = normalizeInput(rawPatch, config, PATCH_FIELDS);
    for (const w of n.warnings) ctx.warn(w);
    const s = structureIssues(n.value, PatchSchema, []);
    const issues = [...n.issues, ...s.issues];
    if (Object.keys(s.parsed).length === 0) throw validationError(issues, null, EDIT_EXAMPLE_HINT);
    let plan: Awaited<ReturnType<typeof planEdit>>;
    try {
      plan = await planEdit({
        ctx,
        repo: resolved,
        config,
        number: target.number,
        patch: s.parsed as PrEditInput,
        issues,
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
      title: plan.title,
      base: plan.base,
      draft: plan.draft ?? plan.snapshot.isDraft,
      patch: plan.rest,
      body: plan.body,
    });
    const applied = await applyEdit(ctx, resolved.repo, plan);
    return { ...result, ...applied, next: [`ghx pr status ${plan.ref}`] };
  },
});
