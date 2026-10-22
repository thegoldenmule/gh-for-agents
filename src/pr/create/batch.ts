// `pr create --batch` (02 §2.4, 03 M9.4): several PRs from {defaults, items}. Each item is
// deepMerge(defaults, item) with arrays replaced. Heads are unique; items stacked on another item's head
// are created after it (topological order; a cycle is VALIDATION). Every item is validated, network
// checks included, before the first POST; the batch stops at the first failure.
import { z } from 'zod';
import type { GhxConfig } from '../../config/schema.ts';
import type { Context } from '../../core/command.ts';
import { rethrowControlFlow } from '../../core/control-flow.ts';
import { GhxError, type IssueDetail } from '../../core/errors.ts';
import type { ResolvedRepo } from '../../gh/repo.ts';
import { repoSlug } from '../../gh/types.ts';
import type { PrCreateOutput } from './output.ts';
import { type CreatePlan, offlineIssues, outputOf, planCreate, previewOf, renderPlan } from './plan.ts';
import { validationError } from './rules.ts';
import { PrCreateInput } from './schema.ts';
import { submitPull } from './submit.ts';

export const BATCH_MAX_ITEMS = 20;

/** Shared fields; every item supplies its own title and head. */
export const BatchDefaults = PrCreateInput.partial()
  .omit({ title: true, head: true })
  .describe('--batch: fields shared by every item (arrays in an item replace these)');
export const BatchItem = PrCreateInput.partial();

export const PrBatchInput = z.strictObject({
  defaults: BatchDefaults.optional(),
  items: z.array(BatchItem).min(1).max(BATCH_MAX_ITEMS),
});
export type PrBatchInput = z.infer<typeof PrBatchInput>;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `over` on top of `base`: objects merge key by key, arrays and scalars replace, undefined is skipped. */
export function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    const prev = out[k];
    out[k] = isPlainObject(prev) && isPlainObject(v) ? deepMerge(prev, v) : v;
  }
  return out;
}

const prefix = (i: number, d: IssueDetail): IssueDetail => ({
  ...d,
  path: d.path === '' ? `items[${i}]` : `items[${i}].${d.path}`,
});

/**
 * Creation order: an item whose base is another item's head comes after it; otherwise input order.
 * Also reports duplicate heads and stacking cycles.
 */
export function batchOrder(items: readonly { base?: unknown; head?: unknown }[]): {
  order: number[];
  issues: IssueDetail[];
} {
  const issues: IssueDetail[] = [];
  const byHead = new Map<string, number>();
  items.forEach((it, i) => {
    if (typeof it.head !== 'string') return;
    const first = byHead.get(it.head);
    if (first !== undefined) {
      issues.push({
        path: `items[${i}].head`,
        code: 'batch.duplicate_head',
        message: `head '${it.head}' is also items[${first}]'s head; each item needs its own branch`,
      });
    } else byHead.set(it.head, i);
  });
  const parent = items.map((it, i) => {
    const p = typeof it.base === 'string' ? byHead.get(it.base) : undefined;
    return p !== undefined && p !== i ? p : null;
  });
  const order: number[] = [];
  const placed = new Set<number>();
  for (let progress = true; progress && placed.size < items.length; ) {
    progress = false;
    for (let i = 0; i < items.length; i++) {
      const p = parent[i];
      if (placed.has(i) || (p !== null && p !== undefined && !placed.has(p))) continue;
      order.push(i);
      placed.add(i);
      progress = true;
    }
  }
  const stuck = items.map((_, i) => i).filter((i) => !placed.has(i));
  if (stuck.length > 0) {
    issues.push({
      path: 'items',
      code: 'batch.cycle',
      message: `items ${stuck.join(', ')} form a stacking cycle: each one's base is another one's head`,
    });
  }
  return { order, issues };
}

/** The failing item's own error, tagged with its index and what was never attempted. */
function tagged(e: GhxError, index: number, notAttempted: number[]): GhxError {
  return new GhxError(e.code, `items[${index}]: ${e.message}`, {
    hint: e.hint,
    details: { ...(e.details ?? {}), index, created: [], notAttempted },
    cause: e,
  });
}

export interface BatchEnv {
  ctx: Context;
  repo: ResolvedRepo;
  config: GhxConfig;
}

export interface BatchResult {
  created: PrCreateOutput[];
  failed: null;
  notAttempted: number[];
}

export async function runBatch(input: PrBatchInput, env: BatchEnv): Promise<BatchResult> {
  const { ctx, config } = env;
  const slug = repoSlug(env.repo.repo);
  const merged = input.items.map((it) => deepMerge(input.defaults ?? {}, it));

  // 1. Offline: structure, createRules, unique heads, order. Every issue of every item at once.
  const issues: IssueDetail[] = [];
  const parsed: PrCreateInput[] = [];
  merged.forEach((raw, i) => {
    const r = offlineIssues(raw, config);
    issues.push(...r.issues.map((d) => prefix(i, d)));
    if (r.input) parsed[i] = r.input;
  });
  const { order, issues: orderIssues } = batchOrder(merged);
  issues.push(...orderIssues);
  if (issues.length > 0) throw validationError(issues);

  // 2. Network checks for every item before the first POST.
  const batchHeads = new Map(parsed.map((p, i) => [p.head, i] as const));
  const plans: CreatePlan[] = [];
  for (const i of order) {
    let plan: CreatePlan;
    try {
      plan = await planCreate(parsed[i] as PrCreateInput, { ctx, repo: env.repo, config, batchHeads });
    } catch (e) {
      rethrowControlFlow(e);
      if (e instanceof GhxError)
        throw tagged(
          e,
          i,
          order.filter((x) => x !== i),
        );
      throw e;
    }
    plans[i] = plan;
    for (const w of plan.warnings) ctx.warn({ ...w, message: `items[${i}]: ${w.message}` });
    issues.push(...plan.issues.map((d) => prefix(i, d)));
  }
  if (issues.length > 0) throw validationError(issues);

  ctx.preview({
    items: order.map((i) => {
      const plan = plans[i] as CreatePlan;
      const { input: rendered, body } = renderPlan(plan, config);
      return { index: i, ...previewOf(plan, rendered, body, slug) };
    }),
  });

  // 3. Create in order, stopping at the first failure.
  const created: PrCreateOutput[] = [];
  const numberOf = new Map<number, number>();
  for (const [k, i] of order.entries()) {
    const plan = plans[i] as CreatePlan;
    const parent = plan.stackedOnItem === null ? undefined : numberOf.get(plan.stackedOnItem);
    try {
      const { input: rendered, body } = renderPlan(plan, config, parent === undefined ? undefined : `#${parent}`);
      const s = await submitPull(
        ctx,
        env.repo.repo,
        { title: rendered.title, head: rendered.head, base: rendered.base, body, draft: plan.draft },
        plan.blockId,
      );
      numberOf.set(i, s.pull.number);
      created.push(outputOf(plan, rendered, s, slug));
    } catch (e) {
      rethrowControlFlow(e);
      const notAttempted = order.slice(k + 1);
      if (!(e instanceof GhxError)) throw e;
      // A read-back mismatch means the PR exists: it counts as created, and re-running it is DUPLICATE_PR.
      const mismatched = e.code === 'READBACK_MISMATCH' && typeof e.details?.ref === 'string' ? e.details.ref : null;
      const createdRefs = [...created.map((c) => c.ref), ...(mismatched ? [mismatched] : [])];
      if (createdRefs.length === 0) throw tagged(e, i, notAttempted);
      const existing = typeof e.details?.ref === 'string' ? { ref: e.details.ref } : {};
      const rerun = mismatched ? notAttempted : [i, ...notAttempted];
      const hint = [
        mismatched
          ? `items[${i}] was created as ${mismatched}, but GitHub stored a different ${String(e.details?.field ?? 'field')}: fix it with ghx pr edit ${mismatched} --input patch.json.`
          : `Fix items[${i}].`,
        rerun.length > 0 ? `Then re-run --batch with only items ${rerun.join(', ')}.` : '',
        'Do not re-run the created PRs; they would now be DUPLICATE_PR.',
      ]
        .filter((x) => x !== '')
        .join(' ');
      throw new GhxError(
        'PARTIAL_FAILURE',
        `Batch created ${createdRefs.length} of ${order.length} PRs; items[${i}] failed with ${e.code}: ${e.message}`,
        {
          hint,
          details: {
            created: createdRefs,
            failed: {
              index: i,
              head: plan.input.head,
              code: e.code,
              message: e.message,
              ...existing,
              ...(mismatched ? { created: true, readbackMismatch: true } : {}),
            },
            notAttempted,
          },
          cause: e,
        },
      );
    }
  }
  return { created, failed: null, notAttempted: [] };
}
