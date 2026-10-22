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
export type PrFeedbackOutput = z.infer<typeof PrFeedbackOutput>;
