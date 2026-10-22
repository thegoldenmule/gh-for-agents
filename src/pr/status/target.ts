// Selector, repo and config for the PR read commands (02 §1.2, §4.2), shared by pr status and pr feedback.
import type { GhxConfig } from '../../config/schema.ts';
import type { Context } from '../../core/command.ts';
import { GhxError } from '../../core/errors.ts';
import { parseTargetRef } from '../../gh/refs.ts';
import { enrichNotFound, type ResolvedRepo } from '../../gh/repo.ts';
import { repoSlug, sameRepo } from '../../gh/types.ts';
import type { Warning } from '../../schemas/common.ts';

export interface PrReadContext {
  resolved: ResolvedRepo;
  number: number;
  config: GhxConfig;
  /** No .github/ghx.json in the target repo: defaults are used and pr status adds the CONFIG_MISSING blocker. */
  configMissing: boolean;
  /** CWD_REPO_MISMATCH and CONFIG_MISSING, for the command's own warnings list. */
  warnings: Warning[];
}

export async function prContext(ctx: Context, selector: string): Promise<PrReadContext> {
  const target = parseTargetRef(selector);
  if (target.kind !== 'pr') {
    throw new GhxError('USAGE_BAD_SELECTOR', `'${selector}' is not a PR selector.`, {
      hint: 'Use 3198, #3198, owner/repo#3198 or a PR URL.',
    });
  }
  const resolved = await ctx.repo({ ref: target.repo });
  const warnings: Warning[] = [];
  if (resolved.source !== 'cwd' && resolved.cwdRepo && !sameRepo(resolved.cwdRepo, resolved.repo)) {
    warnings.push({
      code: 'CWD_REPO_MISMATCH',
      message: `Reading ${repoSlug(resolved.repo)}; the cwd checkout is ${repoSlug(resolved.cwdRepo)}.`,
    });
  }
  const loaded = await ctx.config({ ref: resolved.repo });
  const configMissing = loaded.source.kind === 'default';
  if (configMissing) {
    warnings.push({
      code: 'CONFIG_MISSING',
      message: `${repoSlug(resolved.repo)} has no .github/ghx.json; defaults apply and merge readiness is blocked (CONFIG_MISSING).`,
    });
  }
  return { resolved, number: target.number, config: loaded.config, configMissing, warnings };
}

/** Rethrow, giving a not-found for a cwd-inferred repo the 02 §1.2 rule 3 hint. */
export function rethrowNotFound(e: unknown, resolved: ResolvedRepo, number: number, verb: string): never {
  const enriched = enrichNotFound(e, resolved, `PR #${number}`);
  if (enriched instanceof GhxError && enriched !== e && enriched.code === 'PR_NOT_FOUND') {
    const slug = repoSlug(resolved.repo);
    throw new GhxError('PR_NOT_FOUND', `No PR #${number} in ${slug} (repo resolved from cwd).`, {
      hint: `Pass the repo: ghx pr ${verb} owner/repo#${number} (or -R owner/repo); the cwd checkout is ${slug}.`,
      details: enriched.details,
      cause: e,
    });
  }
  throw enriched;
}
