// ghx pr create (02 §2, 03 M9.3, M9.4): open a PR from a validated object, or several with --batch.
// The flow is 02 §2.6: config → zod + createRules → one GraphQL preflight → compare → local head check
// → render (--dry-run halts at the POST) → POST /pulls via `gh api --input -` → exact read-back.
import { z } from 'zod';
import { defineCommand } from '../../core/command.ts';
import type { IssueDetail } from '../../core/errors.ts';
import { repoSlug } from '../../gh/types.ts';
import { BATCH_MAX_ITEMS, BatchDefaults, BatchItem, runBatch } from '../../pr/create/batch.ts';
import { PrCreateCommandOutput } from '../../pr/create/output.ts';
import { isLocalTarget, offlineIssues, outputOf, planCreate, previewOf, renderPlan } from '../../pr/create/plan.ts';
import { validationError } from '../../pr/create/rules.ts';
import { PrCreateInput } from '../../pr/create/schema.ts';
import { submitPull } from '../../pr/create/submit.ts';

// Every PR field arrives through --input only (02 §0: prose is JSON, never flags). The runner checks
// structure loosely; the handler re-validates strictly so all issues come back together.
const prShape = PrCreateInput.partial().shape;
const jsonFields = Object.fromEntries(
  Object.entries(prShape).map(([k, s]) => [k, s.meta({ jsonOnly: true })]),
) as typeof prShape;

const Input = z
  .strictObject({
    ...jsonFields,
    batch: z.boolean().optional().describe('Create several PRs from {defaults, items}'),
    defaults: BatchDefaults.optional(),
    items: z
      .array(BatchItem)
      .min(1)
      .max(BATCH_MAX_ITEMS)
      .optional()
      .describe('--batch: one partial PR per item, merged over defaults'),
  })
  .describe('A structured PR (02 §2.1), or {defaults, items} with --batch');

const PR_FIELDS = Object.keys(prShape);

const EXAMPLE = {
  title: 'feat(app): show a banner when a request is retried',
  description: 'Requests retried after a transient failure now show a dismissable banner.',
  testing: [{ kind: 'unit', command: 'pnpm test', result: 'pass' }],
  risk: 'low',
  components: ['app'],
  revertPolicy: 'revert-safe',
  base: 'main',
  head: 'feat/retry-banner',
};

export default defineCommand({
  name: ['pr', 'create'],
  summary: 'Open a PR from validated JSON: compact body, hidden ghx block, exact read-back',
  description:
    'Write the PR object with your file tool and pass --input pr.json. Draft and stackedOn are derived from the base. ' +
    'components lists every component the diff touches; past 5, list the 5 primary ones and ghx records the rest (alsoTouched). ' +
    'Fails with every input issue at once (VALIDATION), DUPLICATE_PR when the head already has an open PR.',
  kind: 'write',
  input: Input,
  output: PrCreateCommandOutput,
  needs: { repo: 'inferred', config: 'required' },
  jsonInput: 'required',
  timeout: { defaultMs: 120_000, maxMs: 600_000 },
  replaces: ['gh pr create'],
  examples: [
    { argv: 'ghx pr create -R octo/demo --input -', note: 'or --input pr.json', input: EXAMPLE },
    { argv: 'ghx pr create --input pr.json --dry-run', note: 'validate, check and render without creating' },
    { argv: 'ghx pr create --batch --input prs.json', note: 'several PRs: {defaults, items}; stacked items in order' },
  ],
  async run(raw, ctx) {
    const resolved = await ctx.repo();
    const { config } = await ctx.config();
    const slug = repoSlug(resolved.repo);
    if (resolved.cwdRepo !== undefined && !isLocalTarget(resolved)) {
      ctx.warn({
        code: 'CWD_REPO_MISMATCH',
        message: `The cwd is ${repoSlug(resolved.cwdRepo)} but the target is ${slug}: config came from ${slug} and local git checks were skipped.`,
      });
    }
    const { batch, defaults, items, ...pr } = raw;
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
    const offline = offlineIssues(pr, config);
    for (const w of offline.warnings) ctx.warn(w);
    if (offline.input === null || offline.issues.length > 0) throw validationError(offline.issues);
    const plan = await planCreate(offline.input, { ctx, repo: resolved, config });
    for (const w of plan.warnings) ctx.warn(w);
    if (plan.issues.length > 0) throw validationError(plan.issues);
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
