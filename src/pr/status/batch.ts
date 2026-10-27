// `pr status` with several selectors (02 §4.4): every selector is read concurrently, a bounded number at a
// time, and lands in `results` in argument order. A selector that fails becomes an error entry instead of
// sinking the rest; control flow (TIMEOUT, INTERRUPTED) still ends the whole call. The exit code follows
// `pr create --batch`: 0 when every entry is a PR, 7 (PARTIAL_FAILURE's class) when some are errors, and the
// first entry's own exit code when all are.
import type { Context } from '../../core/command.ts';
import { rethrowControlFlow } from '../../core/control-flow.ts';
import { exitCodeFor, GhxError, isErrorCode, toErrorObject } from '../../core/errors.ts';
import { ExitCode } from '../../core/exit.ts';
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

/** Read every selector with `read`; a GhxError becomes that selector's error entry. */
export function readStatuses(
  ctx: Context,
  selectors: readonly string[],
  read: (selector: string) => Promise<PrStatusOutput>,
): Promise<PrStatusEntry[]> {
  return mapLimit(selectors, STATUS_CONCURRENCY, async (selector): Promise<PrStatusEntry> => {
    try {
      return await read(selector);
    } catch (e) {
      rethrowControlFlow(e);
      if (!(e instanceof GhxError)) throw e;
      return { selector, ref: await refOf(ctx, selector), error: toErrorObject(e).error };
    }
  });
}

/** 0 when every entry is a PR; 7 when some are errors; the first error's own code when all are. */
export function statusesExitCode(results: readonly PrStatusEntry[]): ExitCode {
  const errors = results.filter(isErrorEntry);
  if (errors.length === 0) return ExitCode.OK;
  if (errors.length < results.length) return ExitCode.GH_FAILED;
  const first = (errors[0] as PrStatusErrorEntry).error;
  return isErrorCode(first.code) ? exitCodeFor(first.code, first.details ?? undefined) : ExitCode.INTERNAL;
}
