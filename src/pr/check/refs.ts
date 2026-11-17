import { z } from 'zod';
import type { IssueDetail } from '../../core/errors.ts';
import { type Gh, GhFailure } from '../../gh/index.ts';
import { type RepoRef, repoSlug, sameRepo } from '../../gh/types.ts';
import { readPrBlock } from '../../meta/schemas.ts';
import { collectRefs } from '../create/rules.ts';
import { PrCreateInput } from '../create/schema.ts';
import { parsePrRef } from '../snapshot/stack.ts';
import { mapLimit } from '../status/batch.ts';

/** Check external refs independently of local branches, including the PR-only meaning of refs.fixes. */
export async function validateRefs(
  gh: Gh,
  repo: RepoRef,
  body: string,
  base?: { ref: string; sha: string },
): Promise<IssueDetail[]> {
  const read = readPrBlock(body);
  if (read.status !== 'ok') return [];
  const refs = PrCreateInput.shape.refs.safeParse(read.block.refs);
  const revertWith = PrCreateInput.shape.revertWith.safeParse(read.block.revertWith);
  const requested = collectRefs({
    ...(refs.success ? { refs: refs.data } : {}),
    ...(revertWith.success ? { revertWith: revertWith.data } : {}),
  });
  const found = await mapLimit(requested, 5, async (item): Promise<IssueDetail | null> => {
    const target = parsePrRef(item.ref, repo);
    if (!target) return null;
    try {
      const response = await gh.api(
        { path: `repos/{owner}/{repo}/issues/${target.number}`, repo: target.repo },
        z.object({ number: z.number().int(), pull_request: z.object({ url: z.string() }).optional() }),
        { notFound: 'REF_NOT_FOUND' },
      );
      if (response.notModified) throw new Error('Unexpected unconditional ref response.');
      if (item.path.startsWith('refs.fixes[') && !response.data.pull_request) {
        return {
          path: item.path,
          code: 'refs.not_pr',
          message: `${item.ref} is an issue; refs.fixes requires a pull request.`,
        };
      }
      return null;
    } catch (e) {
      if (!(e instanceof GhFailure) || e.failure.code !== 'GH_NOT_FOUND') throw e;
      return { path: item.path, code: 'refs.not_found', message: `${item.ref} does not exist or cannot be read.` };
    }
  });
  const issues = found.filter((issue): issue is IssueDetail => issue !== null);
  const stackedOn = refs.success ? refs.data?.stackedOn : undefined;
  if (stackedOn !== undefined && base !== undefined) {
    issues.push(...(await validateStack(gh, repo, stackedOn, base)));
  }
  return issues;
}

/** The target repo and declared parent are GitHub reads, independent of local branches and PR policy edits. */
async function validateStack(
  gh: Gh,
  repo: RepoRef,
  stackedOn: string,
  base: { ref: string; sha: string },
): Promise<IssueDetail[]> {
  const issues: IssueDetail[] = [];
  const repository = await gh.api({ path: 'repos/{owner}/{repo}', repo }, z.object({ default_branch: z.string() }));
  if (repository.notModified) throw new Error('Unexpected unconditional repository response.');
  if (base.ref === repository.data.default_branch) {
    issues.push({
      path: 'refs.stackedOn',
      code: 'refs.stacked_on_default_base',
      message: `A PR based on the default branch '${base.ref}' is not stacked; drop stackedOn or use the parent's head branch.`,
    });
  }
  const target = parsePrRef(stackedOn, repo);
  const mismatch = (): IssueDetail => ({
    path: 'refs.stackedOn',
    code: 'refs.stack_mismatch',
    message: `stackedOn ${stackedOn} must name an open PR in ${repoSlug(repo)} whose same-repo head is '${base.ref}' at ${base.sha}.`,
  });
  if (!target || !sameRepo(target.repo, repo)) return [...issues, mismatch()];
  try {
    const parent = await gh.api(
      { path: `repos/{owner}/{repo}/pulls/${target.number}`, repo },
      z.object({
        state: z.string(),
        head: z.object({ ref: z.string(), sha: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
      }),
      { notFound: 'REF_NOT_FOUND' },
    );
    if (parent.notModified) throw new Error('Unexpected unconditional parent response.');
    if (
      parent.data.state !== 'open' ||
      parent.data.head.ref !== base.ref ||
      parent.data.head.sha !== base.sha ||
      parent.data.head.repo?.full_name.toLowerCase() !== repoSlug(repo).toLowerCase()
    ) {
      issues.push(mismatch());
    }
  } catch (e) {
    if (!(e instanceof GhFailure) || e.failure.code !== 'GH_NOT_FOUND') throw e;
    issues.push(mismatch());
  }
  return issues;
}
