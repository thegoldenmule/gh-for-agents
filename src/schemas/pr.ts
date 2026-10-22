// PR-domain schemas shared by pr create/edit, the hidden blocks, the feedback fold, the policy engine and
// the feedback writes (02 §1.5, §2.1, §4.1, §7, §9.2, §9.3).
//
// Writers are strict; readers use the `<Name>Read` siblings, which keep unknown keys (`.loose()`) and
// accept unknown enum values (`.or(z.string())`). Callers warn UNKNOWN_ENUM for a value the strict enum
// rejects, and policy fails closed: an unknown risk or severity ranks as high (riskRank, severityRank).
import { z } from 'zod';
import { ComponentName } from '../config/sections/components.ts';
import { Iso, IssueRef, OneLine, PrRef, RepoPath, Sha } from './common.ts';

// ── Enums (02 §1.5) ───────────────────────────────────────────────────────
export const RISK_ORDER = ['trivial', 'low', 'medium', 'high'] as const;
export const Risk = z.enum(RISK_ORDER);
export const RiskRead = Risk.or(z.string());

export const RevertPolicy = z.enum(['revert-safe', 'revert-with-followup', 'coordinated', 'forward-fix-only']);
export const RevertPolicyRead = RevertPolicy.or(z.string());

/** Low to high, so the index is the rank. */
export const SEVERITY_ORDER = ['low', 'medium', 'high'] as const;
export const Severity = z.enum(['high', 'medium', 'low']);
export const SeverityRead = Severity.or(z.string());

export const Verdict = z.enum(['approve', 'request-changes', 'comment']);
export const VerdictRead = Verdict.or(z.string());

export const FindingStatus = z.enum(['open', 'addressed', 'wontfix', 'deferred']);
export const FindingStatusRead = FindingStatus.or(z.string());

export const PreconditionStatus = z.enum(['met', 'unmet', 'unknown', 'withdrawn']);
export const PreconditionStatusRead = PreconditionStatus.or(z.string());

/** A `resolve` event target's status (02 §9.2): a finding status or a precondition status. */
export const ResolveStatus = z.union([FindingStatus, PreconditionStatus]);
export const ResolveStatusRead = ResolveStatus.or(z.string());

/** Rank of a risk value, 0 (trivial) to 3 (high). Fails closed: an unknown value ranks as high (02 §9.3). */
export function riskRank(risk: string): number {
  const i = (RISK_ORDER as readonly string[]).indexOf(risk);
  return i === -1 ? RISK_ORDER.length - 1 : i;
}

/** Rank of a severity, 0 (low) to 2 (high). Fails closed: an unknown value ranks as high (02 §9.3, §8.2 #14). */
export function severityRank(severity: string): number {
  const i = (SEVERITY_ORDER as readonly string[]).indexOf(severity);
  return i === -1 ? SEVERITY_ORDER.length - 1 : i;
}

// ── Components (per repo, from .github/ghx.json) ──────────────────────────
/**
 * The static component schema: a scope token. Use it in `spec.input`, which must export to JSON Schema
 * without a config; check membership against the config with componentEnum or a rule.
 */
export { ComponentName };
/** Components as read from a block: any string (a component may have been removed from the config since). */
export const ComponentRead = z.string();

/** The repo's component enum. An empty `components` record yields an enum that rejects every value. */
export function componentEnum(config: { readonly components: Readonly<Record<string, unknown>> }) {
  return z.enum(Object.keys(config.components) as [string, ...string[]]);
}

// ── Testing and refs (02 §2.1; embedded in the pr block, §9.2, and read back by pr status, §4.1) ──
export const TestingKind = z.enum(['unit', 'integration', 'e2e', 'typecheck', 'lint', 'build', 'benchmark', 'manual']);
export const TestingResult = z.enum(['pass', 'fail', 'skipped', 'not-run']);

/** Structure only. The cross-field rules (command_required, not_rerunnable, …) are createRules (02 §2.1). */
export const TestingItem = z.strictObject({
  kind: TestingKind,
  command: OneLine(200).optional(),
  cwd: z
    .string()
    .max(120)
    .regex(/^(?!\/)(?!.*\.\.)[\w@./-]+$/, 'must be a repo-relative directory')
    .optional(),
  steps: z.array(OneLine(160)).min(1).max(5).optional(),
  result: TestingResult,
  notes: OneLine(200).optional(),
});
export const TestingItemRead = TestingItem.extend({
  kind: TestingKind.or(z.string()),
  result: TestingResult.or(z.string()),
}).loose();

export const Refs = z.strictObject({
  stackedOn: PrRef.optional(),
  closes: z.array(IssueRef).max(10).optional(),
  related: z.array(PrRef).max(10).optional(),
  splitFrom: PrRef.optional(),
  supersedes: z.array(PrRef).max(10).optional(),
  reverts: PrRef.optional(),
});
export const RefsRead = Refs.loose();

// ── Preconditions (02 §4.1, §7.1, §9.2) ───────────────────────────────────
export const CONDITION_TYPES = ['pr-merged', 'release-includes', 'manual'] as const;

const PrMergedCondition = z.strictObject({ type: z.literal('pr-merged'), ref: PrRef });
const ReleaseIncludesCondition = z.strictObject({ type: z.literal('release-includes'), ref: PrRef });
const ManualCondition = z.strictObject({ type: z.literal('manual'), text: z.string() });

export const Condition = z.discriminatedUnion('type', [PrMergedCondition, ReleaseIncludesCondition, ManualCondition]);

/**
 * Lenient: a known type must still be well formed; any other type is kept as `{type, …}` and policy treats
 * it as status `unknown` (02 §9.3). The negative lookahead (not a refine) keeps the exclusion in JSON Schema.
 */
export const UnknownCondition = z
  .object({ type: z.string().regex(new RegExp(`^(?!(?:${CONDITION_TYPES.join('|')})$)`), 'unknown condition type') })
  .loose();
export const ConditionRead = z.union([
  PrMergedCondition.loose(),
  ReleaseIncludesCondition.loose(),
  ManualCondition.loose(),
  UnknownCondition,
]);

// ── Policy and status events (02 §4.1, §8) ────────────────────────────────
/** A policy check result: a blocker, a waiver or a warning. */
export const Violation = z.object({
  code: z.string(),
  message: z.string(),
  overridable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

/** The resolve event that set an item's current status (02 §9.4). `verified` is null when there is no commit. */
export const StatusEvent = z.object({
  id: z.string(),
  by: z.string(),
  at: Iso,
  commit: Sha.nullable(),
  note: z.string().nullable(),
  verified: z.boolean().nullable(),
  url: z.string(),
});

// ── Review locations (02 §7.2, §9.2) ──────────────────────────────────────
export const Side = z.enum(['RIGHT', 'LEFT']);
export const Location = z.strictObject({ path: RepoPath, line: z.number().int().positive() });
export const LocationRead = Location.loose();

// ── Comments (02 §4.1, §7.1, §9.2) ────────────────────────────────────────
export const CommentKind = z.enum(['note', 'precondition', 'status', 'supersede', 'resolve']);
export const CommentKindRead = CommentKind.or(z.string());
/** The `state` of a `status` comment. */
export const StatusCommentState = z.enum(['waiting', 'blocked', 'ready', 'rebased', 'split']);
export const StatusCommentStateRead = StatusCommentState.or(z.string());

export type Risk = z.infer<typeof Risk>;
export type RevertPolicy = z.infer<typeof RevertPolicy>;
export type Severity = z.infer<typeof Severity>;
export type Verdict = z.infer<typeof Verdict>;
export type FindingStatus = z.infer<typeof FindingStatus>;
export type PreconditionStatus = z.infer<typeof PreconditionStatus>;
export type ResolveStatus = z.infer<typeof ResolveStatus>;
export type TestingItem = z.infer<typeof TestingItem>;
export type Refs = z.infer<typeof Refs>;
export type Condition = z.infer<typeof Condition>;
export type ConditionRead = z.infer<typeof ConditionRead>;
export type Violation = z.infer<typeof Violation>;
export type StatusEvent = z.infer<typeof StatusEvent>;
export type Location = z.infer<typeof Location>;
export type CommentKind = z.infer<typeof CommentKind>;
