// ghx pr status <pr>… (02 §4; 03 M6.5): what is this PR, can it land, and what's left, in one bounded object.
// The composition lives in src/pr/status/compose.ts (shared with pr merge and ci wait --until mergeable);
// this file resolves the repo and config, maps a cwd-inferred not-found to the 02 §1.2 hint, and applies
// the 16 KB budget to what --fields/--brief will print. Warnings are returned in the output, never sent to ctx.warn. Several selectors
// (02 §4.4) give {results}, one entry per selector; src/pr/status/batch.ts reads them.
import { z } from 'zod';
import { type Context, defineCommand } from '../../core/command.ts';
import { ExitCode } from '../../core/exit.ts';
import { DEFAULT_MAX_BYTES } from '../../core/output.ts';
import { COMPARE_BUDGET_MS } from '../../pr/ci-summary.ts';
import { checkSelectors, readStatuses, statusesExitCode } from '../../pr/status/batch.ts';
import { loadPrStatus } from '../../pr/status/compose.ts';
import { statusOutput } from '../../pr/status/output.ts';
import { PrStatusCommandOutput, type PrStatusOutput, STATUS_MAX_PRS } from '../../pr/status/schema.ts';
import { prContext, rethrowNotFound } from '../../pr/status/target.ts';
import { fitStatus, fitStatuses } from '../../pr/status/truncate.ts';

/** Time kept back from the deadline for the output, so a slow comparison ends partial, not in TIMEOUT. */
const OUTPUT_MARGIN_MS = 10_000;

const Input = z.strictObject({
  pr: z
    .array(z.string().min(1))
    .min(1)
    .max(STATUS_MAX_PRS)
    .describe(`PRs: 3198, #3198, owner/repo#3198 or a PR URL; 2 to ${STATUS_MAX_PRS} print {results: […]}`),
  compareMain: z
    .boolean()
    .default(true)
    .describe('Compare failing checks with the default branch; --no-compare-main skips it'),
  waitMergeable: z
    .boolean()
    .default(true)
    .describe('Retry an UNKNOWN mergeable for up to 20 s; --no-wait-mergeable reads it once'),
});

export default defineCommand({
  name: ['pr', 'status'],
  summary: 'One object: description, block, merge readiness, CI for the head, feedback, preconditions, stack',
  description:
    'Answers "can this PR land, and what is left" in one call. merge.ready is exactly what ghx pr merge would ' +
    'decide now (same policy engine); merge.blockers say why not. CI is reported for the head SHA only. ' +
    'Feedback from all three GitHub sources is folded; bodies are capped, and the full text is in ghx pr feedback. ' +
    `Several PRs (up to ${STATUS_MAX_PRS}) give {results: [...]}, one object per PR in argument order, read concurrently; ` +
    'a PR that cannot be read is {selector, ref, error} there, and the exit is 7 when some failed.',
  kind: 'read',
  input: Input,
  positionals: ['pr'],
  output: PrStatusCommandOutput,
  needs: { repo: 'inferred', config: 'optional' },
  timeout: { defaultMs: 120_000, maxMs: 300_000 },
  brief: [
    'ref',
    'state',
    'draft',
    'head.sha',
    'merge.mergeable',
    'merge.mergeStateStatus',
    'merge.ready',
    'merge.blockers[].code',
    'merge.mergedAt',
    'merge.mergeCommit',
    'ci.state',
    'ci.phase',
    'ci.counts',
    'ci.failing[].name',
    'ci.expectedMissing[].name',
    'feedback.counts',
  ],
  replaces: ['gh pr view', 'gh pr checks', 'gh pr view --json mergeable,mergeStateStatus,reviews,comments'],
  examples: [
    { argv: 'ghx pr status 3301 -R powerhouse-inc/powerhouse', note: 'Everything about PR #3301' },
    { argv: 'ghx pr status owner/repo#12 --no-compare-main', note: 'Skip the comparison with the default branch' },
    { argv: 'ghx pr status 12 --no-wait-mergeable', note: 'Read mergeable once, even if GitHub says UNKNOWN' },
    { argv: 'ghx pr status 3264 3267 3268 -R owner/repo', note: 'Several PRs in one call: {results: [...]}' },
  ],
  exitCode: (out) => (out.results ? statusesExitCode(out.results) : ExitCode.OK),
  async run(input, ctx) {
    const opts = { compareMain: input.compareMain, waitMergeable: input.waitMergeable };
    const [only, ...rest] = input.pr;
    // The budget is measured on what --fields/--brief keep (ctx.project): unselected parts are never cut.
    if (only !== undefined && rest.length === 0) {
      return fitStatus(await readStatus(ctx, only, opts), DEFAULT_MAX_BYTES, ctx.project);
    }
    checkSelectors(input.pr);
    const results = await readStatuses(ctx, input.pr, (selector) => readStatus(ctx, selector, opts));
    return { results: fitStatuses(results, DEFAULT_MAX_BYTES, ctx.project) };
  },
});

/** One PR's status before the size budget; a not-found for a cwd-inferred repo gets the 02 §1.2 hint. */
async function readStatus(
  ctx: Context,
  selector: string,
  o: { compareMain: boolean; waitMergeable: boolean },
): Promise<PrStatusOutput> {
  const { resolved, number, config, configMissing, warnings } = await prContext(ctx, selector);
  const remaining = ctx.deadline === undefined ? Infinity : ctx.deadline - ctx.clock.monotonic() - OUTPUT_MARGIN_MS;
  let state: Awaited<ReturnType<typeof loadPrStatus>>;
  try {
    state = await loadPrStatus({
      gh: ctx.gh,
      clock: ctx.clock,
      artifacts: ctx.artifacts,
      signal: ctx.signal,
      repo: resolved.repo,
      number,
      config,
      configMissing,
      waitMergeable: o.waitMergeable,
      compareMain: o.compareMain,
      compareBudgetMs: Math.max(0, Math.min(COMPARE_BUDGET_MS, remaining)),
    });
  } catch (e) {
    rethrowNotFound(e, resolved, number, 'status');
  }
  return statusOutput(state, { footer: config.render.footer, warnings });
}
