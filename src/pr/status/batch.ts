// `pr status` with several selectors (02 §4.4): every selector is read concurrently, a bounded number at a
// time, and lands in `results` in argument order. A selector that fails becomes an error entry instead of
// sinking the rest. Each PR reads within its share of the deadline (PrShare): one that runs out of it becomes
// a TIMEOUT entry, while the command's own deadline or a signal (TIMEOUT, INTERRUPTED) still ends the whole
// call. The exit code follows `pr create --batch`: 0 when every entry is a PR, 7 (PARTIAL_FAILURE's class)
// when some are errors, and the first entry's own exit code when all are.
import type { Context } from '../../core/command.ts';
import { isControlFlow, rethrowControlFlow } from '../../core/control-flow.ts';
import { formatDuration } from '../../core/duration.ts';
import { exitCodeFor, GhxError, isErrorCode, toErrorObject } from '../../core/errors.ts';
import { ExitCode } from '../../core/exit.ts';
import { createDeadline } from '../../core/signals.ts';
import { parseTargetRef } from '../../gh/refs.ts';
import { repoSlug } from '../../gh/types.ts';
import type { PrStatusEntry, PrStatusErrorEntry, PrStatusOutput } from './schema.ts';

/** PRs read at once. Each mostly waits (the mergeable retry, the main comparison); gh bounds its own calls. */
export const STATUS_CONCURRENCY = 5;

/** `fn` over `xs`, at most `limit` at a time; results in input order. */
export async function mapLimit<T, R>(
  xs: readonly T[],
  limit: number,
  fn: (x: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(xs.length);
  let next = 0;
  const worker = async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await fn(xs[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, xs.length) }, worker));
  return out;
}

/** Every selector must parse as a PR before anything is fetched: a typo is a usage error, not an entry. */
export function checkSelectors(selectors: readonly string[]): void {
  for (const s of selectors) {
    if (parseTargetRef(s).kind !== 'pr') {
      throw new GhxError('USAGE_BAD_SELECTOR', `'${s}' is not a PR selector.`, {
        hint: 'Use 3198, #3198, owner/repo#3198 or a PR URL.',
      });
    }
  }
}

export const isErrorEntry = (e: PrStatusEntry): e is PrStatusErrorEntry => 'error' in e;

/** owner/repo#N for a selector whose repo resolves (memoized by ctx.repo), else null. */
async function refOf(ctx: Context, selector: string): Promise<string | null> {
  const t = parseTargetRef(selector);
  if (t.kind !== 'pr') return null;
  const r = await ctx.tryRepo({ ref: t.repo }).catch(() => undefined);
  return r ? `${repoSlug(r.repo)}#${t.number}` : null;
}

/** Kept back from the command deadline for fitting and printing once every PR is read. */
export const BATCH_MARGIN_MS = 2_000;

/** One PR's part of the deadline: read with this signal (it aborts when the share ends) and this deadline. */
export interface PrShare {
  /** clock.monotonic() at which the share ends; undefined for no deadline. */
  deadline: number | undefined;
  signal: AbortSignal;
}

/**
 * The share of a PR starting now: the time left before the command deadline (less BATCH_MARGIN_MS), split
 * over the waves still to run, ceil(unfinished PRs / STATUS_CONCURRENCY). Time a fast PR leaves unused goes
 * to the PRs after it. Undefined without a deadline.
 */
export function shareMs(ctx: Pick<Context, 'clock' | 'deadline'>, unfinished: number): number | undefined {
  if (ctx.deadline === undefined) return undefined;
  const left = ctx.deadline - BATCH_MARGIN_MS - ctx.clock.monotonic();
  return Math.max(0, Math.floor(left / Math.ceil(Math.max(1, unfinished) / STATUS_CONCURRENCY)));
}

/**
 * Read every selector with `read`, each within its share; a GhxError becomes that selector's error entry, and
 * a PR still reading when its share ends becomes a TIMEOUT entry (the others keep reading).
 */
export function readStatuses(
  ctx: Context,
  selectors: readonly string[],
  read: (selector: string, share: PrShare) => Promise<PrStatusOutput>,
): Promise<PrStatusEntry[]> {
  let finished = 0;
  return mapLimit(selectors, STATUS_CONCURRENCY, async (selector): Promise<PrStatusEntry> => {
    const ms = shareMs(ctx, selectors.length - finished);
    const share = createDeadline(ctx.clock, ms ?? null, ctx.signal, `Reading ${selector}`);
    try {
      return await read(selector, { deadline: share.at, signal: share.signal });
    } catch (e) {
      const ref = () => refOf(ctx, selector);
      if (isControlFlow(e) && share.signal.aborted && !ctx.signal.aborted) {
        return { selector, ref: await ref(), error: toErrorObject(shareTimeout(selector, ms ?? 0)).error };
      }
      rethrowControlFlow(e);
      if (!(e instanceof GhxError)) throw e;
      return { selector, ref: await ref(), error: toErrorObject(e).error };
    } finally {
      share.cancel();
      finished++;
    }
  });
}

function shareTimeout(selector: string, ms: number): GhxError {
  return new GhxError(
    'TIMEOUT',
    `Reading ${selector} did not finish within its ${formatDuration(ms)} share of the deadline.`,
    {
      hint: `The other PRs were read. Re-run this one alone (ghx pr status ${selector}), or pass a longer --timeout.`,
      details: { deadlineMs: ms },
    },
  );
}

/** 0 when every entry is a PR; 7 when some are errors; the first error's own code when all are. */
export function statusesExitCode(results: readonly PrStatusEntry[]): ExitCode {
  const errors = results.filter(isErrorEntry);
  if (errors.length === 0) return ExitCode.OK;
  if (errors.length < results.length) return ExitCode.GH_FAILED;
  const first = (errors[0] as PrStatusErrorEntry).error;
  return isErrorCode(first.code) ? exitCodeFor(first.code, first.details ?? undefined) : ExitCode.INTERNAL;
}
