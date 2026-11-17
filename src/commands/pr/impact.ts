import { z } from 'zod';
import { describeSource } from '../../config/load.ts';
import { isoNow } from '../../core/clock.ts';
import { defineCommand } from '../../core/command.ts';
import { rethrowControlFlow } from '../../core/control-flow.ts';
import { exitCodeFor, GhxError, isErrorCode, toErrorObject } from '../../core/errors.ts';
import { ExitCode } from '../../core/exit.ts';
import { createDeadline } from '../../core/signals.ts';
import { resolveTarget } from '../../pr/feedback-writes/read.ts';
import { deriveImpact } from '../../pr/impact/derive.ts';
import { readImpactFiles } from '../../pr/impact/read.ts';
import { PrImpactCommandOutput } from '../../pr/impact/schema.ts';
import { checkSelectors, mapLimit, shareMs } from '../../pr/status/batch.ts';

export default defineCommand({
  name: ['pr', 'impact'],
  summary: 'Read components and the risk floor from any PR’s changed paths',
  description:
    'Derives current-config component matches independently of a ghx block. Merged PRs and deleted head branches work. Incomplete file lists fail closed. Several PRs return ordered results.',
  kind: 'read',
  input: z.strictObject({ pr: z.array(z.string().min(1)).min(1).max(10) }),
  positionals: ['pr'],
  needs: { repo: 'inferred', config: 'required' },
  output: PrImpactCommandOutput,
  timeout: { defaultMs: 120_000, maxMs: 300_000 },
  examples: [{ argv: 'ghx pr impact 12 13 -R owner/repo', note: 'Classify current and historical PRs' }],
  exitCode(out) {
    const errors = out.results?.filter((entry) => 'error' in entry) ?? [];
    if (!errors.length) return ExitCode.OK;
    if (errors.length < (out.results?.length ?? 0)) return ExitCode.GH_FAILED;
    const error = errors[0]?.error;
    return error && isErrorCode(error.code) ? exitCodeFor(error.code, error.details ?? undefined) : ExitCode.INTERNAL;
  },
  async run(input, ctx) {
    checkSelectors(input.pr);
    const read = async (selector: string, signal = ctx.signal) => {
      const target = await resolveTarget(ctx, selector);
      const loaded = await ctx.config({ ref: target.repo });
      const { pr, files } = await readImpactFiles(ctx.gh.withSignal?.(signal) ?? ctx.gh, target.repo, target.number);
      return {
        ref: target.ref,
        headSha: pr.head.sha,
        baseSha: pr.base.sha,
        ...deriveImpact(files, loaded.config.components),
        config: describeSource(loaded.source),
        fetchedAt: isoNow(ctx.clock),
      };
    };
    const only = input.pr[0] as string;
    if (input.pr.length === 1) return read(only);
    let finished = 0;
    const results = await mapLimit(input.pr, 5, async (selector) => {
      const share = createDeadline(
        ctx.clock,
        shareMs(ctx, input.pr.length - finished) ?? null,
        ctx.signal,
        `Reading ${selector}`,
      );
      try {
        return await read(selector, share.signal);
      } catch (e) {
        if (ctx.signal.aborted) rethrowControlFlow(e);
        if (!(e instanceof GhxError)) throw e;
        return { selector, ref: null, error: toErrorObject(e).error };
      } finally {
        share.cancel();
        finished++;
      }
    });
    return { results };
  },
});
