import { z } from 'zod';
import { GhxError } from '../../core/errors.ts';
import type { Gh } from '../../gh/index.ts';
import type { RepoRef } from '../../gh/types.ts';

export const ImpactPr = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  updated_at: z.string(),
  changed_files: z.number().int().nonnegative(),
  head: z.object({ sha: z.string(), ref: z.string() }),
  base: z.object({ sha: z.string(), ref: z.string() }),
});
export type ImpactPr = z.infer<typeof ImpactPr>;

export async function readImpactPr(gh: Gh, repo: RepoRef, number: number): Promise<ImpactPr> {
  const response = await gh.api({ path: `repos/{owner}/{repo}/pulls/${number}`, repo }, ImpactPr, {
    notFound: 'PR_NOT_FOUND',
  });
  if (response.notModified) throw new GhxError('GH_OUTPUT_UNEXPECTED', 'PR read unexpectedly returned 304.');
  return response.data;
}

/** PR-file API reads also work after a head branch was deleted; count/identity guards fail closed. */
export async function readImpactFiles(gh: Gh, repo: RepoRef, number: number) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await readImpactPr(gh, repo, number);
    const response = await gh.api(
      { path: `repos/{owner}/{repo}/pulls/${number}/files`, repo, paginate: { maxPages: 100, perPage: 100 } },
      z.array(z.object({ filename: z.string(), previous_filename: z.string().optional() })),
      { notFound: 'PR_NOT_FOUND' },
    );
    const after = await readImpactPr(gh, repo, number);
    if (
      before.head.sha !== after.head.sha ||
      before.base.sha !== after.base.sha ||
      before.updated_at !== after.updated_at ||
      before.changed_files !== after.changed_files
    ) {
      if (attempt === 0) continue;
      throw new GhxError('HEAD_MOVED', 'The PR changed while reading its files; retry the command.');
    }
    if (response.notModified || response.truncated || response.data.length !== after.changed_files) {
      throw new GhxError('GH_OUTPUT_UNEXPECTED', 'The complete PR file list could not be read; impact is unknown.', {
        details: {
          expectedFiles: after.changed_files,
          receivedFiles: response.notModified ? 0 : response.data.length,
        },
      });
    }
    return {
      pr: after,
      files: [
        ...new Set(
          response.data.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename])),
        ),
      ],
    };
  }
  throw new GhxError('INTERNAL', 'Unreachable PR-file retry state.');
}
