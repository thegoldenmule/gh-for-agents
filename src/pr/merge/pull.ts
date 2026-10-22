// The REST read of one PR that every pr merge re-read uses (02 §8.1 steps 4, 7 and 8): merged, merge commit,
// head and mergeable_state in one call. GET is a read, so the gh layer retries it on transient failures.
import { z } from 'zod';
import { GhxError } from '../../core/errors.ts';
import type { Gh } from '../../gh/index.ts';
import type { RepoRef } from '../../gh/types.ts';

export const MergePull = z.object({
  number: z.number().int(),
  state: z.string(),
  merged: z.boolean(),
  merged_at: z.string().nullable(),
  merge_commit_sha: z.string().nullable(),
  /** dirty | blocked | behind | clean | unstable | unknown | draft | has_hooks (lowercase). */
  mergeable_state: z.string().nullable().optional(),
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string() }),
});
export type MergePull = z.infer<typeof MergePull>;

export async function readMergePull(gh: Gh, repo: RepoRef, number: number): Promise<MergePull> {
  const r = await gh.api({ path: `repos/{owner}/{repo}/pulls/${number}`, repo }, MergePull, {
    notFound: 'PR_NOT_FOUND',
  });
  if (r.notModified) throw new GhxError('INTERNAL', 'GET pulls returned 304 without a conditional request.');
  return r.data;
}
