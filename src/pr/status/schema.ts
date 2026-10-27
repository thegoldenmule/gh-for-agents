// `pr status` output (02 §4.1 PrStatusOutput) and `pr feedback` output (02 §5). Composed from the shared
// schemas: feedback items (src/feedback/schemas.ts), MergeState (src/policy/schemas.ts), CiSummary and
// Stack. No transforms (test/registry.test.ts exports every output to JSON Schema).
import { z } from 'zod';
import { Feedback, Precondition } from '../../feedback/schemas.ts';
import { MergeState } from '../../policy/schemas.ts';
import { CiSummary } from '../../schemas/ci.ts';
import { Author, Iso, PrRef, Sha, Warning } from '../../schemas/common.ts';
import { RefsRead, RevertPolicyRead, RiskRead, TestingItemRead } from '../../schemas/pr.ts';
import { Stack } from '../snapshot/stack.ts';

/** The PR body's ghx block as pr status reports it (lenient: unknown enum values pass through). */
export const PrMeta = z.object({
  id: z.string(),
  rev: z.number(),
  gen: z.string(),
  risk: RiskRead,
  riskNote: z.string().nullable(),
  components: z.array(z.string()),
  /** Components the diff touched beyond `components`, recorded by ghx (06); [] when none. */
  alsoTouched: z.array(z.string()),
  revertPolicy: RevertPolicyRead,
  revertNote: z.string().nullable(),
  revertWith: z.array(PrRef),
  testing: z.array(TestingItemRead),
  refs: RefsRead,
});

export const DriftField = z.enum(['title', 'description', 'trailer']);

export const PrStatusOutput = z.object({
  ref: PrRef,
  url: z.string(),
  number: z.number(),
  title: z.string(),
  author: Author,
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  draft: z.boolean(),
  createdAt: Iso,
  updatedAt: Iso,
  base: z.object({ ref: z.string(), isDefault: z.boolean() }),
  head: z.object({ ref: z.string(), sha: Sha }),
  changes: z.object({ files: z.number(), additions: z.number(), deletions: z.number(), commits: z.number() }),
  description: z.object({ text: z.string(), structured: z.boolean(), drift: z.array(DriftField) }),
  meta: PrMeta.nullable(),
  metaError: z.object({ code: z.string(), message: z.string() }).nullable(),
  merge: MergeState,
  ci: CiSummary,
  feedback: Feedback,
  openFindings: z.array(z.string()),
  preconditions: z.array(Precondition),
  stack: Stack,
  warnings: z.array(Warning),
  fetchedAt: Iso,
});

/** Most selectors one `pr status` call takes (as ci wait's targets). */
export const STATUS_MAX_PRS = 10;

/**
 * A selector that failed in a several-PR call: the 02 §1.3 error envelope plus what it was asked for.
 * `ref` is owner/repo#N once the repo resolved, else null.
 */
export const PrStatusErrorEntry = z.object({
  selector: z.string(),
  ref: PrRef.nullable(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    hint: z.string().nullable(),
    details: z.record(z.string(), z.unknown()).nullable(),
  }),
});

export const PrStatusEntry = z.union([PrStatusOutput, PrStatusErrorEntry]);

/**
 * One schema for both modes (a spec has one output object, as PrCreateCommandOutput): one selector prints
 * PrStatusOutput itself; 2+ print {results}, one PrStatusOutput or PrStatusErrorEntry per selector, in order.
 */
export const PrStatusCommandOutput = PrStatusOutput.partial().extend({
  results: z
    .array(PrStatusEntry)
    .optional()
    .describe('2+ selectors: one entry per selector, in argument order; a failed one is {selector, ref, error}'),
});

export const PrFeedbackOutput = z.object({
  ref: PrRef,
  headSha: Sha,
  feedback: Feedback,
  openFindings: z.array(z.string()),
  preconditions: z.array(Precondition),
  /** The same document with every body in full (no 2,000-char cap). */
  artifactPath: z.string(),
  warnings: z.array(Warning),
});

export type PrMeta = z.infer<typeof PrMeta>;
export type PrStatusOutput = z.infer<typeof PrStatusOutput>;
export type PrStatusErrorEntry = z.infer<typeof PrStatusErrorEntry>;
export type PrStatusEntry = z.infer<typeof PrStatusEntry>;
export type PrStatusCommandOutput = z.infer<typeof PrStatusCommandOutput>;
export type PrFeedbackOutput = z.infer<typeof PrFeedbackOutput>;
