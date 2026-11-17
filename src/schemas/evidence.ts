// Review evidence is supplied by the reviewer; ghx records it without fetching or verifying the source.
import { z } from 'zod';
import { Body, OneLine } from './common.ts';

export const Evidence = z.strictObject({
  source: OneLine(200).refine((s) => !s.includes('<!-- ghx:'), 'must not contain a ghx block marker'),
  quote: Body(1000, 10),
  url: z
    .url({ protocol: /^https?$/ })
    .max(2048)
    .optional(),
});

/** Read old and future blocks without applying today's write-side prose limits. */
export const EvidenceRead = z.looseObject({
  source: z.string(),
  quote: z.string(),
  url: z.string().optional(),
});

export function hasFindingLocation<T extends { path?: string | undefined; line?: number | undefined }>(
  finding: T,
): finding is T & { path: string; line: number } {
  return finding.path !== undefined && finding.line !== undefined;
}

/** Complete location, or evidence with no location-only fields. Never accept half a location. */
export function validFindingLocation(f: {
  path?: string | undefined;
  line?: number | undefined;
  endLine?: number | undefined;
  side?: string | undefined;
  alsoAt?: readonly unknown[] | undefined;
  suggestion?: string | undefined;
  evidence?: unknown;
}): boolean {
  if (hasFindingLocation(f)) return true;
  return (
    f.path === undefined &&
    f.line === undefined &&
    f.endLine === undefined &&
    f.side === undefined &&
    (f.alsoAt?.length ?? 0) === 0 &&
    f.suggestion === undefined &&
    f.evidence !== undefined
  );
}
