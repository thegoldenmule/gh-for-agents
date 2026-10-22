// v1 hidden-block payloads (02 §9.2, §9.3). codec.ts owns the wire format; this module owns what goes inside.
// Write: encodeBlock validates strictly; a failure is a ghx bug (INTERNAL), since inputs were validated earlier.
// Read: readBlocks keeps unknown keys and enum values (UNKNOWN_ENUM; policy fails closed), maps an unknown `t`
// or comment `kind` to `unknown-type` (UNKNOWN_BLOCK_TYPE), and `ghx:v2+` to SCHEMA_NEWER. It never throws.
import { z } from 'zod';
import { GhxError } from '../core/errors.ts';
import {
  CommentId,
  FindingId,
  Gen,
  Id,
  IssueRef,
  OneLine,
  PrBlockId,
  PrRef,
  RepoPath,
  ReviewId,
  Sha,
  type Warning,
} from '../schemas/common.ts';
import {
  CONDITION_TYPES,
  CommentKind,
  ComponentName,
  ComponentRead,
  Condition,
  ConditionRead,
  Location,
  LocationRead,
  Refs,
  RefsRead,
  ResolveStatus,
  ResolveStatusRead,
  RevertPolicy,
  RevertPolicyRead,
  Risk,
  RiskRead,
  Severity,
  SeverityRead,
  Side,
  StatusCommentState,
  StatusCommentStateRead,
  TestingItem,
  TestingItemRead,
  TestingKind,
  TestingResult,
  Verdict,
  VerdictRead,
} from '../schemas/pr.ts';
import { type Decoded, decodeAll, encode, META_VERSION } from './codec.ts';

const Text = z.string().min(1);
const Line = z.number().int().positive();

// ── Strict (write) ────────────────────────────────────────────────────────
/** The PR body block. One per body; a reader takes the first valid one. */
export const PrBlock = z.strictObject({
  t: z.literal('pr'),
  id: PrBlockId,
  gen: Gen,
  rev: z.number().int().min(1),
  title: Text,
  description: Text,
  testing: z.array(TestingItem).min(1).max(20),
  risk: Risk,
  riskNote: Text.optional(),
  components: z.array(ComponentName).min(1),
  revertPolicy: RevertPolicy,
  revertNote: Text.optional(),
  revertWith: z.array(PrRef).min(1).max(10).optional(),
  refs: Refs.optional(),
});

export const ReviewBlock = z.strictObject({
  t: z.literal('review'),
  id: ReviewId,
  gen: Gen,
  verdict: Verdict,
  summary: Text,
  scope: Text.optional(),
  commit: Sha,
  findings: z.array(FindingId).max(50),
});

/** No status field: a finding starts open; status changes are `resolve` comment events (02 §9.4). */
export const FindingBlock = z.strictObject({
  t: z.literal('finding'),
  id: FindingId,
  gen: Gen,
  review: ReviewId,
  severity: Severity,
  path: RepoPath,
  line: Line,
  endLine: Line.optional(),
  side: Side,
  alsoAt: z.array(Location).max(10),
  title: Text,
  body: Text,
  suggestion: z.string().optional(),
  commit: Sha,
});

export const ResolveTarget = z.strictObject({
  id: Id,
  status: ResolveStatus,
  commit: Sha.optional(),
  note: OneLine(200).optional(),
  tracking: IssueRef.optional(),
});

const commentBase = { t: z.literal('comment'), id: CommentId, gen: Gen } as const;
export const CommentBlock = z.discriminatedUnion('kind', [
  z.strictObject({ ...commentBase, kind: z.literal('note') }),
  z.strictObject({ ...commentBase, kind: z.literal('precondition'), condition: Condition }),
  z.strictObject({
    ...commentBase,
    kind: z.literal('status'),
    state: StatusCommentState,
    refs: z.array(PrRef).max(10).optional(),
  }),
  z.strictObject({ ...commentBase, kind: z.literal('supersede'), by: PrRef }),
  z.strictObject({ ...commentBase, kind: z.literal('resolve'), targets: z.array(ResolveTarget).min(1).max(50) }),
]);

/** Every v1 block a writer may emit. */
export const BlockV1 = z.discriminatedUnion('t', [PrBlock, ReviewBlock, FindingBlock, CommentBlock]);

// ── Lenient (read) ────────────────────────────────────────────────────────
const readBase = { id: z.string().min(1), gen: z.string() } as const;

export const PrBlockRead = z.looseObject({
  ...readBase,
  t: z.literal('pr'),
  rev: z.number().int().min(1),
  title: z.string(),
  description: z.string(),
  testing: z.array(TestingItemRead),
  risk: RiskRead,
  riskNote: z.string().optional(),
  components: z.array(ComponentRead),
  revertPolicy: RevertPolicyRead,
  revertNote: z.string().optional(),
  revertWith: z.array(PrRef).optional(),
  refs: RefsRead.optional(),
});

export const ReviewBlockRead = z.looseObject({
  ...readBase,
  t: z.literal('review'),
  verdict: VerdictRead,
  summary: z.string(),
  scope: z.string().optional(),
  commit: Sha,
  findings: z.array(z.string()),
});

export const FindingBlockRead = z.looseObject({
  ...readBase,
  t: z.literal('finding'),
  review: z.string(),
  severity: SeverityRead,
  path: RepoPath,
  line: Line,
  endLine: Line.optional(),
  side: Side.or(z.string()).optional(),
  alsoAt: z.array(LocationRead).optional(),
  title: z.string(),
  body: z.string(),
  suggestion: z.string().optional(),
  commit: Sha,
});

export const ResolveTargetRead = z.looseObject({
  id: z.string().min(1),
  status: ResolveStatusRead,
  commit: Sha.optional(),
  note: z.string().optional(),
  tracking: z.string().optional(),
});

const commentReadBase = { ...readBase, t: z.literal('comment') } as const;
export const CommentBlockRead = z.discriminatedUnion('kind', [
  z.looseObject({ ...commentReadBase, kind: z.literal('note') }),
  z.looseObject({ ...commentReadBase, kind: z.literal('precondition'), condition: ConditionRead }),
  z.looseObject({
    ...commentReadBase,
    kind: z.literal('status'),
    state: StatusCommentStateRead,
    refs: z.array(z.string()).optional(),
  }),
  z.looseObject({ ...commentReadBase, kind: z.literal('supersede'), by: z.string() }),
  z.looseObject({ ...commentReadBase, kind: z.literal('resolve'), targets: z.array(ResolveTargetRead).min(1) }),
]);

/** What the codec checks for v1 before typed parsing: just enough to dispatch on `t`. */
export const BlockEnvelopeV1 = z.looseObject({ t: z.string().min(1), id: z.string().min(1) });
export const META_READ_SCHEMAS = { [META_VERSION]: BlockEnvelopeV1 } as const;

export type PrBlock = z.infer<typeof PrBlock>;
export type ReviewBlock = z.infer<typeof ReviewBlock>;
export type FindingBlock = z.infer<typeof FindingBlock>;
export type CommentBlock = z.infer<typeof CommentBlock>;
export type BlockV1 = z.infer<typeof BlockV1>;
export type PrBlockRead = z.infer<typeof PrBlockRead>;
export type ReviewBlockRead = z.infer<typeof ReviewBlockRead>;
export type FindingBlockRead = z.infer<typeof FindingBlockRead>;
export type CommentBlockRead = z.infer<typeof CommentBlockRead>;
export type ResolveTargetRead = z.infer<typeof ResolveTargetRead>;
export type KnownBlockRead = PrBlockRead | ReviewBlockRead | FindingBlockRead | CommentBlockRead;

// ── Write ─────────────────────────────────────────────────────────────────
/** Validate strictly, then encode as `<!-- ghx:v1 {…} -->`. An invalid block is a ghx bug. */
export function encodeBlock(block: BlockV1): string {
  const r = BlockV1.safeParse(block);
  if (!r.success) {
    throw new GhxError('INTERNAL', `ghx built an invalid ${String((block as { t?: unknown }).t)} block.`, {
      details: { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
    });
  }
  return encode(r.data, META_VERSION);
}

// ── Read ──────────────────────────────────────────────────────────────────
export type BlockInvalidCode = 'SCHEMA_NEWER' | 'BLOCK_INVALID';

export type BlockRead =
  | { status: 'ok'; block: KnownBlockRead; warnings: Warning[]; range: [number, number] }
  /** Structured, but `kind: null` for the caller, and ignored by policy (UNKNOWN_BLOCK_TYPE). */
  | {
      status: 'unknown-type';
      t: string;
      kind: string | null;
      id: string;
      data: Record<string, unknown>;
      warnings: Warning[];
      range: [number, number];
    }
  /** `error` is the item's `blockError`. SCHEMA_NEWER is also the warning code. */
  | { status: 'invalid'; code: BlockInvalidCode; error: string; version: number | null; range: [number, number] };

const KNOWN_T = ['pr', 'review', 'finding', 'comment'] as const;
const READ_BY_T = {
  pr: PrBlockRead,
  review: ReviewBlockRead,
  finding: FindingBlockRead,
  comment: CommentBlockRead,
} as const;

function issueSummary(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .slice(0, 3)
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

function unknownEnum(field: string, value: string, t: string, id: string, note: string): Warning {
  return {
    code: 'UNKNOWN_ENUM',
    message: `Unknown ${field} "${value}" in ${t} block ${id}; ${note}.`,
  };
}

const known = (e: z.ZodType, v: unknown) => typeof v !== 'string' || e.safeParse(v).success;

/** UNKNOWN_ENUM warnings for one block. Policy fails closed on every one of these (02 §9.3). */
export function enumWarnings(b: KnownBlockRead): Warning[] {
  const w: Warning[] = [];
  const add = (field: string, value: string, note: string) => w.push(unknownEnum(field, value, b.t, b.id, note));
  switch (b.t) {
    case 'pr':
      if (!known(Risk, b.risk)) add('risk', b.risk, 'policy treats it as high');
      if (!known(RevertPolicy, b.revertPolicy)) add('revertPolicy', b.revertPolicy, 'kept as is');
      for (const item of b.testing) {
        if (!known(TestingKind, item.kind)) add('testing.kind', item.kind, 'kept as is');
        if (!known(TestingResult, item.result)) add('testing.result', item.result, 'not counted as a pass');
      }
      break;
    case 'review':
      if (!known(Verdict, b.verdict)) add('verdict', b.verdict, 'kept as is');
      break;
    case 'finding':
      if (!known(Severity, b.severity)) add('severity', b.severity, 'policy treats it as high');
      if (b.side !== undefined && !known(Side, b.side)) add('side', b.side, 'kept as is');
      break;
    case 'comment':
      if (b.kind === 'status' && !known(StatusCommentState, b.state)) add('state', b.state, 'kept as is');
      if (b.kind === 'precondition' && !(CONDITION_TYPES as readonly string[]).includes(b.condition.type)) {
        add('condition.type', b.condition.type, 'the precondition counts as unknown');
      }
      if (b.kind === 'resolve') {
        for (const target of b.targets) {
          if (!known(ResolveStatus, target.status)) add('status', target.status, 'the event is ignored');
        }
      }
      break;
  }
  return w;
}

function classify(d: Exclude<Decoded<unknown>, { status: 'absent' }>): BlockRead {
  if (d.status === 'invalid') {
    const version = d.version ?? null;
    if (d.reason === 'unsupported-version') {
      if (version !== null && version > META_VERSION) {
        return { status: 'invalid', code: 'SCHEMA_NEWER', error: `newer schema v${version}`, version, range: d.range };
      }
      return {
        status: 'invalid',
        code: 'BLOCK_INVALID',
        error: `unsupported schema v${version}`,
        version,
        range: d.range,
      };
    }
    const error = d.reason === 'json' ? 'invalid JSON' : `invalid block: ${issueSummary((d.issues ?? []) as never)}`;
    return { status: 'invalid', code: 'BLOCK_INVALID', error, version, range: d.range };
  }
  const env = d.data as z.infer<typeof BlockEnvelopeV1>;
  const t = env.t;
  const unknownType = (kind: string | null): BlockRead => ({
    status: 'unknown-type',
    t,
    kind,
    id: env.id,
    data: env,
    warnings: [
      {
        code: 'UNKNOWN_BLOCK_TYPE',
        message: `Block ${env.id} has unknown ${kind === null ? `type "${t}"` : `comment kind "${kind}"`}; ignored by policy.`,
      },
    ],
    range: d.range,
  });
  if (!(KNOWN_T as readonly string[]).includes(t)) return unknownType(null);
  if (t === 'comment' && typeof env.kind === 'string' && !CommentKind.safeParse(env.kind).success) {
    return unknownType(env.kind);
  }
  const r = READ_BY_T[t as (typeof KNOWN_T)[number]].safeParse(env);
  if (!r.success) {
    return {
      status: 'invalid',
      code: 'BLOCK_INVALID',
      error: `invalid ${t} block: ${issueSummary(r.error.issues)}`,
      version: d.version,
      range: d.range,
    };
  }
  const block = r.data as KnownBlockRead;
  return { status: 'ok', block, warnings: enumWarnings(block), range: d.range };
}

/** Every ghx block in a body, in order, classified for a lenient reader. Never throws. */
export function readBlocks(body: string): BlockRead[] {
  return decodeAll(body, META_READ_SCHEMAS).flatMap((d) => (d.status === 'absent' ? [] : [classify(d)]));
}

export type PrBlockResult =
  | { status: 'absent'; warnings: Warning[] }
  | { status: 'ok'; block: PrBlockRead; warnings: Warning[] }
  | { status: 'invalid'; code: BlockInvalidCode; error: string; warnings: Warning[] };

/**
 * The PR body's `pr` block (02 §9.2): the first valid one wins, and any further `pr` block warns
 * DUPLICATE_BLOCK. With no valid one, the first invalid one is reported (`metaError`).
 */
export function readPrBlock(body: string): PrBlockResult {
  const all = readBlocks(body).filter((b) => b.status === 'invalid' || (b.status === 'ok' && b.block.t === 'pr'));
  if (all.length === 0) return { status: 'absent', warnings: [] };
  const firstOk = all.find((b) => b.status === 'ok');
  const warnings: Warning[] = [];
  if (all.length > 1) {
    warnings.push({
      code: 'DUPLICATE_BLOCK',
      message: `The PR body has ${all.length} pr blocks; the first valid one is used.`,
    });
  }
  if (firstOk?.status === 'ok' && firstOk.block.t === 'pr') {
    return { status: 'ok', block: firstOk.block, warnings: [...warnings, ...firstOk.warnings] };
  }
  const first = all[0];
  if (first?.status === 'invalid') {
    if (first.code === 'SCHEMA_NEWER')
      warnings.push({ code: 'SCHEMA_NEWER', message: `PR body block: ${first.error}.` });
    return { status: 'invalid', code: first.code, error: first.error, warnings };
  }
  return { status: 'absent', warnings };
}
