// ghx pr create (02 §2, 03 M9.3, M9.4): open a PR from a validated object, or several with --batch.
// The flow is 02 §2.6: config → zod + createRules → one GraphQL preflight → compare → local head check
// → render (--dry-run halts at the POST) → POST /pulls via `gh api --input -` → exact read-back.
import { z } from 'zod';
import { defineCommand } from '../../core/command.ts';
import { GhxError, type IssueDetail } from '../../core/errors.ts';
import { repoSlug } from '../../gh/types.ts';
import { BATCH_MAX_ITEMS, BatchDefaults, BatchItem, runBatch } from '../../pr/create/batch.ts';
import { lenientFields } from '../../pr/create/check.ts';
import { createExampleOutput, ExampleFields } from '../../pr/create/example.ts';
import { PrCreateCommandOutput } from '../../pr/create/output.ts';
import { checkCreate, isLocalTarget, outputOf, PR_FIELDS, previewOf, renderPlan } from '../../pr/create/plan.ts';
import { validationError } from '../../pr/create/rules.ts';
import { PrCreateInput } from '../../pr/create/schema.ts';
import { createSchemaView } from '../../pr/create/schema-view.ts';
import { submitPull } from '../../pr/create/submit.ts';

// Every PR field arrives through --input only (02 §0: prose is JSON, never flags). The runner accepts any
// value for them and any extra key (lenientFields, catchall), so the handler reports every issue at once.
const Input = z
  .object({
    ...lenientFields(PrCreateInput.shape),
    example: z.boolean().optional().describe('Print a valid input for this repo (its component names) and the rules'),
    batch: z.boolean().optional().describe('Create several PRs from {defaults, items}'),
    defaults: BatchDefaults.optional(),
    items: z
      .array(BatchItem)
      .min(1)
      .max(BATCH_MAX_ITEMS)
      .optional()
      .describe('--batch: one partial PR per item, merged over defaults'),
  })
  .catchall(z.unknown())
  .describe('A structured PR, or {defaults, items} with --batch. ghx pr create --example prints one for this repo');

// No scope and no components: valid in any repo whose components have paths (ghx derives them from the
// diff). base and head are given only so the smoke fixture needs no git; they default when omitted.
const EXAMPLE = {
  title: 'feat: show a banner when a request is retried',
  description: 'Requests retried after a transient failure now show a dismissable banner.',
  testing: [{ kind: 'unit', command: 'pnpm test', result: 'pass' }],
  risk: 'low',
  revertPolicy: 'revert-safe',
  base: 'main',
  head: 'feat/retry-banner',
};

export default defineCommand({
  name: ['pr', 'create'],
  summary: 'Open a PR from validated JSON: compact body, hidden ghx block, exact read-back',
  description:
    'ghx pr create --example prints a valid input for this repo; write it to pr.json, edit it, and pass --input pr.json. ' +
    'Required: title, description, testing, risk, revertPolicy. base and head default to the default and current branch; ' +
    'components the diff touches are added (past 5, ghx records the rest as alsoTouched); draft and stackedOn follow the base. ' +
    'Validation runs before any write and reports every issue at once (VALIDATION); DUPLICATE_PR when the head already has an open PR.',
  kind: 'write',
  input: Input,
  output: z.object(ExampleFields).extend(PrCreateCommandOutput.shape),
  needs: { repo: 'inferred', config: 'required' },
  jsonInput: 'optional',
  timeout: { defaultMs: 120_000, maxMs: 600_000 },
  brief: ['ref', 'number', 'url', 'draft', 'head.sha', 'next'],
  replaces: ['gh pr create'],
  schemaView: createSchemaView,
  examples: [
    { argv: 'ghx pr create -R octo/demo --input -', note: 'or --input pr.json', input: EXAMPLE },
    { argv: 'ghx pr create --example', note: 'a valid input for this repo, with its component names and the rules' },
    { argv: 'ghx pr create --input pr.json --dry-run', note: 'preview the rendered body without creating' },
    { argv: 'ghx pr create --batch --input prs.json', note: 'several PRs: {defaults, items}; stacked items in order' },
  ],
  async run(raw, ctx) {
    const { example, ...given } = raw;
    if (example !== true && Object.keys(given).length === 0) {
      throw new GhxError('USAGE_INPUT_MISSING', 'ghx pr create needs the PR as JSON and --input was not given.', {
        hint: 'Run ghx pr create --example for a valid input for this repo, write it to pr.json with your file tool, then: ghx pr create --input pr.json',
      });
    }
    const resolved = await ctx.repo();
    const { config } = await ctx.config();
    const slug = repoSlug(resolved.repo);
    if (resolved.cwdRepo !== undefined && !isLocalTarget(resolved)) {
      ctx.warn({
        code: 'CWD_REPO_MISMATCH',
        message: `The cwd is ${repoSlug(resolved.cwdRepo)} but the target is ${slug}: config came from ${slug} and local git checks were skipped.`,
      });
    }
    if (example === true) return createExampleOutput(config);
    const { batch, defaults, items, ...pr } = given;
    if (batch === true) {
      const stray = PR_FIELDS.filter((k) => k in pr);
      if (stray.length > 0 || items === undefined) {
        const issues: IssueDetail[] = stray.map((k) => ({
          path: k,
          code: 'batch.top_level_field',
          message: `with --batch, '${k}' goes in defaults or in each item`,
        }));
        if (items === undefined) issues.push({ path: 'items', code: 'invalid_type', message: '--batch needs items[]' });
        throw validationError(issues);
      }
      return runBatch({ ...(defaults ? { defaults } : {}), items }, { ctx, repo: resolved, config });
    }
    if (defaults !== undefined || items !== undefined) {
      throw validationError([
        {
          path: defaults !== undefined ? 'defaults' : 'items',
          code: 'batch.flag_required',
          message: 'defaults and items are --batch input; pass --batch to create several PRs',
        },
      ]);
    }
    const { plan } = await checkCreate(pr, { ctx, repo: resolved, config });
    const { input, body } = renderPlan(plan, config);
    ctx.preview(previewOf(plan, input, body, slug));
    const submitted = await submitPull(
      ctx,
      resolved.repo,
      { title: input.title, head: input.head, base: input.base, body, draft: plan.draft },
      plan.blockId,
    );
    return outputOf(plan, input, submitted, slug);
  },
});
