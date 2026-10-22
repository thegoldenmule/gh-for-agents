// ghx pr status <pr> (02 §4; 03 M6.5): what is this PR, can it land, and what's left, in one bounded object.
// The composition lives in src/pr/status/compose.ts (shared with pr merge and ci wait --until mergeable);
// this file resolves the repo and config, maps a cwd-inferred not-found to the 02 §1.2 hint, and applies
// the 16 KB budget. Warnings are returned in the output, never sent to ctx.warn.
import { z } from 'zod';
import { defineCommand } from '../../core/command.ts';
import { DEFAULT_MAX_BYTES } from '../../core/output.ts';
import { COMPARE_BUDGET_MS } from '../../pr/ci-summary.ts';
import { loadPrStatus } from '../../pr/status/compose.ts';
import { statusOutput } from '../../pr/status/output.ts';
import { PrStatusOutput } from '../../pr/status/schema.ts';
import { prContext, rethrowNotFound } from '../../pr/status/target.ts';
import { fitStatus } from '../../pr/status/truncate.ts';

/** Time kept back from the deadline for the output, so a slow comparison ends partial, not in TIMEOUT. */
const OUTPUT_MARGIN_MS = 10_000;

const Input = z.strictObject({
  pr: z.string().min(1).describe('PR: 3198, #3198, owner/repo#3198 or a PR URL'),
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
    'Feedback from all three GitHub sources is folded; bodies are capped, and the full text is in ghx pr feedback.',
  kind: 'read',
  input: Input,
  positionals: ['pr'],
  output: PrStatusOutput,
  needs: { repo: 'inferred', config: 'optional' },
  timeout: { defaultMs: 120_000, maxMs: 300_000 },
  replaces: ['gh pr view', 'gh pr checks', 'gh pr view --json mergeable,mergeStateStatus,reviews,comments'],
  examples: [
    { argv: 'ghx pr status 3301 -R powerhouse-inc/powerhouse', note: 'Everything about PR #3301' },
    { argv: 'ghx pr status owner/repo#12 --no-compare-main', note: 'Skip the comparison with the default branch' },
    { argv: 'ghx pr status 12 --no-wait-mergeable', note: 'Read mergeable once, even if GitHub says UNKNOWN' },
  ],
  async run(input, ctx) {
    const { resolved, number, config, configMissing, warnings } = await prContext(ctx, input.pr);
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
        waitMergeable: input.waitMergeable,
        compareMain: input.compareMain,
        compareBudgetMs: Math.max(0, Math.min(COMPARE_BUDGET_MS, remaining)),
      });
    } catch (e) {
      rethrowNotFound(e, resolved, number, 'status');
    }
    return fitStatus(statusOutput(state, { footer: config.render.footer, warnings }), DEFAULT_MAX_BYTES);
  },
});
