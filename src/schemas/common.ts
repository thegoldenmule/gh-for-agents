// Primitive schemas shared by every command (02 §1.4, §1.5, §7.1; 03 M2.1, §5.1).
//
// Rules for everything under src/schemas/:
// - No transforms: every schema must export to JSON Schema (test/registry.test.ts). `.trim()` is an
//   in-place overwrite, not a transform, and exports cleanly.
// - Write-side inputs are strict; read-side (lenient) variants are named `<Name>Read` (02 §9.3).
import { z } from 'zod';

/** A full lowercase commit SHA. */
export const Sha = z.string().regex(/^[0-9a-f]{40}$/, 'expected a 40-char lowercase hex commit SHA');

/** A SHA as a caller may type it: 7–40 lowercase hex chars. */
export const ShaInput = z
  .string()
  .regex(/^[0-9a-f]{7,40}$/, 'expected 7–40 lowercase hex chars (lowercase the SHA if it has capitals)');

/** `#12` or `owner/repo#12`. Numbers start at 1. */
export const PrRef = z
  .string()
  .regex(/^(?:[\w.-]+\/[\w.-]+)?#[1-9]\d*$/, 'expected #N or owner/repo#N')
  .describe('PR reference: #N or owner/repo#N');
export const IssueRef = PrRef;

/** ISO 8601 date-time. GitHub emits `Z`; offsets are accepted for caller input. */
export const Iso = z.iso.datetime({ offset: true });

/** One trimmed, non-empty line of at most `max` chars. */
export const OneLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !/[\r\n]/.test(s), 'must be a single line');

/** A repo-relative path: no leading `/`, no `..` segment. */
export const RepoPath = z
  .string()
  .min(1)
  .max(400)
  .refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), 'must be repo-relative with no ".." segment');

/** Free prose for comments and reviews (02 §7.1). It may not carry a ghx block; ghx adds those. */
export const Body = (maxChars: number, maxLines: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maxChars)
    .refine((s) => s.split('\n').length <= maxLines, `at most ${maxLines} lines`)
    .refine((s) => !s.includes('<!-- ghx:'), 'must not contain a ghx block marker');

// The one Warning shape: the runner extends every output with core's Warning, so it is re-exported, not copied.
export { Warning } from '../core/command.ts';

// ── IDs (02 §1.4) ─────────────────────────────────────────────────────────
/** Lowercase Crockford base32: digits and a–z without i, l, o, u. */
export const CROCKFORD_CLASS = '[0-9a-hjkmnp-tv-z]';
export const ID_PREFIXES = { pr: 'p', review: 'r', finding: 'f', comment: 'c' } as const;

const idOf = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_${CROCKFORD_CLASS}{6}$`), `expected ${prefix}_ plus 6 Crockford chars`);

/** Any ghx-generated id: `p_`, `r_`, `f_` or `c_` plus 6 Crockford chars. */
export const Id = idOf('[prfc]');
export const PrBlockId = idOf('p');
export const ReviewId = idOf('r');
export const FindingId = idOf('f');
export const CommentId = idOf('c');
/** Ids for unstructured GitHub items: `ic:` issue comment, `rc:` review comment, `rv:` review. */
export const SyntheticId = z.string().regex(/^(?:ic|rc|rv):\d+$/, 'expected ic:N, rc:N or rv:N');
/** Any feedback item id: a ghx id or a synthetic one. */
export const FeedbackId = z
  .string()
  .regex(new RegExp(`^(?:[prfc]_${CROCKFORD_CLASS}{6}|(?:ic|rc|rv):\\d+)$`), 'expected a ghx id or ic:/rc:/rv:N');

/** The `gen` field of every block: `ghx/<semver>`. */
export const Gen = z.string().regex(/^ghx\/\d+\.\d+\.\d+(?:[-+][\w.+-]*)?$/, 'expected ghx/<semver>');

// ── Authors ───────────────────────────────────────────────────────────────
export const Association = z.enum([
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
  'CONTRIBUTOR',
  'FIRST_TIME_CONTRIBUTOR',
  'FIRST_TIMER',
  'MANNEQUIN',
  'NONE',
]);

export const Author = z.object({
  login: z.string(),
  isViewer: z.boolean(),
  isBot: z.boolean(),
  association: Association,
});

export type Sha = z.infer<typeof Sha>;
export type PrRef = z.infer<typeof PrRef>;
export type Association = z.infer<typeof Association>;
export type Author = z.infer<typeof Author>;
