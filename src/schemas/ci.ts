// The CI schemas shared by ci why, ci wait, pr status and pr merge (02 §1.5, §11.9, §12; 03 M2.1, §5.1).
// Outputs are plain z.object (the runner validates and strips); caps are enforced here so an over-long
// list is an output-contract bug, never a silent 16 KB overflow.
import { z } from 'zod';
import { Iso, Sha } from './common.ts';

/** Caps from 03 §5.1. Producers truncate to these; the schemas reject anything longer. */
export const CI_CAPS = {
  /** SameOnMain test lists and FailingJob.tests. */
  tests: 30,
  /** FailingJob.errors. */
  errors: 20,
  /** One test name, error or exit line, ellipsis included. */
  lineChars: 300,
  /** FailingJob.excerpt (the line count is `--excerpt-lines`: default 20, cap 60). */
  excerptChars: 2000,
  excerptLinesDefault: 20,
  excerptLinesMax: 60,
  /** Diagnosis events (02 §11.4): ≤10 tests, ≤5 errors, ≤10 lines or 1,500 chars. */
  eventTests: 10,
  eventErrors: 5,
  eventExcerptLines: 10,
  eventExcerptChars: 1500,
  /** CompactDiagnosis.tests and TargetSummary.diagnosis.jobs. */
  compactTests: 5,
  compactJobs: 5,
} as const;

const Line = z.string().max(CI_CAPS.lineChars);
const Count = z.number().int().min(0);
const DbId = z.number().int();

// ── Checks (02 §1.5) ──────────────────────────────────────────────────────
export const Bucket = z.enum(['pass', 'fail', 'pending', 'skipped', 'cancelled', 'neutral']);
export const CheckKind = z.enum(['actions', 'status', 'app']);
export const CheckStatus = z.enum(['expected', 'queued', 'in_progress', 'waiting', 'completed']);

export const Check = z.object({
  name: z.string(),
  workflow: z.string().nullable(),
  kind: CheckKind,
  bucket: Bucket,
  status: CheckStatus,
  conclusion: z.string().nullable(),
  required: z.boolean(),
  /** checkSuite.workflowRun.databaseId (no link parsing). */
  runId: DbId.nullable(),
  /** CheckRun.databaseId, which equals the Actions job id. */
  jobId: DbId.nullable(),
  attempt: z.number().int().nullable(),
  /** Never null: a StatusContext without a targetUrl falls back to the commit's checks page. */
  url: z.url(),
  startedAt: Iso.nullable(),
  completedAt: Iso.nullable(),
});

export const PendingCheck = Check.pick({ name: true, workflow: true, status: true, required: true });

export const SameOnMainVerdict = z.enum([
  'same-tests',
  'same-step',
  'different',
  'main-green',
  'no-main-run',
  'not-compared',
]);

export const SameOnMain = z.object({
  verdict: SameOnMainVerdict,
  mainBranch: z.string(),
  mainRunId: DbId.nullable(),
  mainSha: Sha.nullable(),
  mainRunAt: Iso.nullable(),
  prTests: z.array(Line).max(CI_CAPS.tests),
  mainTests: z.array(Line).max(CI_CAPS.tests),
  newTests: z.array(Line).max(CI_CAPS.tests),
});

export const FlakeScore = z.enum(['high', 'medium', 'low', 'none']);
export const FlakeSignalKind = z.enum(['same-sha-passed', 'main-intermittent', 'known-flaky', 'infra-error']);

export const Flake = z.object({
  candidate: z.boolean(),
  score: FlakeScore,
  signals: z.array(z.object({ kind: FlakeSignalKind, detail: z.string() })),
});

/** `sameOnMain` and `flake` are null when not computed. */
export const FailingCheck = Check.extend({ sameOnMain: SameOnMain.nullable(), flake: Flake.nullable() });

export const ExpectedSource = z.enum(['required', 'config', 'baseline']);
export const ExpectedState = z.enum(['missing', 'reported', 'absent']);

export const ExpectedCheck = z.object({
  name: z.string(),
  workflow: z.string().nullable(),
  source: ExpectedSource,
  state: ExpectedState,
});

// ── The summary (02 §1.5) ─────────────────────────────────────────────────
export const CiState = z.enum(['green', 'red', 'pending', 'no-checks']);
export const CiPhase = z.enum(['registering', 'partial', 'running', 'settled']);

export const CiCounts = z.object({
  pass: Count,
  fail: Count,
  pending: Count,
  skipped: Count,
  cancelled: Count,
  neutral: Count,
  ignored: Count,
});

export const Eta = z.object({ seconds: z.number().min(0), p90Seconds: z.number().min(0), basis: z.string() });

export const CiSummary = z.object({
  headSha: Sha,
  /** Always true: CI is never reported for a SHA other than the head. */
  forHeadSha: z.literal(true),
  state: CiState,
  phase: CiPhase,
  counts: CiCounts,
  failing: z.array(FailingCheck),
  pending: z.array(PendingCheck),
  ignored: z.array(z.string()),
  expectedMissing: z.array(ExpectedCheck),
  eta: Eta.nullable(),
  next: z.array(z.string()),
  /**
   * Present (true) only when more checks existed than ghx reads (CI_CHECKS_TRUNCATED). The unread checks
   * may be pending or red, so the state is never green and merge policy fails CI_PENDING.
   */
  truncated: z.literal(true).optional(),
});

// ── Diagnosis (02 §12, §11.9) ─────────────────────────────────────────────
export const FailingJob = z.object({
  workflow: z.string(),
  job: z.string(),
  jobId: DbId,
  runId: DbId,
  attempt: z.number().int(),
  url: z.string(),
  conclusion: z.string(),
  required: z.boolean(),
  /** From the jobs API, never "UNKNOWN STEP". */
  step: z.object({ number: z.number().int(), name: z.string() }).nullable(),
  tests: z.array(Line).max(CI_CAPS.tests),
  errors: z.array(Line).max(CI_CAPS.errors),
  exitLine: Line.nullable(),
  excerpt: z.string().max(CI_CAPS.excerptChars),
  logPath: z.string().nullable(),
  logBytes: z.number().int().min(0).nullable(),
  sameOnMain: SameOnMain,
  flake: Flake,
});

/** The FailingJob inside a `diagnosis` event, with the tighter event caps (02 §11.4: fits in 4 KB). */
export const DiagnosisJob = FailingJob.extend({
  tests: z.array(Line).max(CI_CAPS.eventTests),
  errors: z.array(Line).max(CI_CAPS.eventErrors),
  excerpt: z.string().max(CI_CAPS.eventExcerptChars),
});

export const CompactDiagnosis = z.object({
  job: z.string(),
  workflow: z.string(),
  jobId: DbId,
  step: z.string().nullable(),
  tests: z.array(Line).max(CI_CAPS.compactTests),
  firstError: Line.nullable(),
  logPath: z.string().nullable(),
  sameOnMain: SameOnMainVerdict,
  flake: FlakeScore,
});

// ── ci wait (02 §11.9; 03 §9 Q1 adds stalled state "missing") ─────────────
export const UntilMode = z.enum(['first-failure', 'settled', 'mergeable']);

const T = { target: z.string() };

/** 01's stream runner adds `seq` and `at` to every line. */
export const WaitEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('start'),
    ...T,
    headSha: Sha,
    until: UntilMode,
    phase: CiPhase,
    counts: CiCounts,
    expected: z.array(ExpectedCheck),
    eta: Eta.nullable(),
  }),
  z.object({ type: z.literal('phase'), ...T, headSha: Sha, from: CiPhase, to: CiPhase }),
  z.object({
    type: z.literal('check'),
    ...T,
    headSha: Sha,
    name: z.string(),
    workflow: z.string().nullable(),
    from: z.union([Bucket, z.literal('absent')]),
    to: Bucket,
    conclusion: z.string().nullable(),
    required: z.boolean(),
    runId: DbId.nullable(),
    jobId: DbId.nullable(),
    url: z.string(),
  }),
  z.object({ type: z.literal('expected-absent'), ...T, name: z.string(), source: z.literal('baseline') }),
  z.object({ type: z.literal('diagnosis'), ...T, headSha: Sha, job: DiagnosisJob }),
  z.object({ type: z.literal('progress'), ...T, headSha: Sha, counts: CiCounts, eta: Eta.nullable() }),
  z.object({ type: z.literal('head-changed'), ...T, from: Sha, to: Sha, action: z.enum(['restart', 'stop']) }),
  z.object({ type: z.literal('branch-advanced'), ...T, boundSha: Sha, branchHead: Sha }),
  z.object({
    type: z.literal('rate-limit'),
    ...T,
    remaining: Count,
    resetAt: Iso,
    intervalSec: z.number().min(0),
  }),
]);

export const Outcome = z.enum([
  'green',
  'red',
  'red-shared',
  'superseded',
  'closed',
  'no-checks',
  'stalled',
  'pending',
  'interrupted',
]);

export const StalledCheck = z.object({
  name: z.string(),
  state: z.enum(['queued', 'running', 'missing']),
  forSec: z.number().min(0),
  thresholdSec: z.number().min(0),
  basis: z.string(),
});

export const TargetSummary = z.object({
  target: z.string(),
  outcome: Outcome,
  reason: z.string().nullable(),
  headSha: Sha,
  restarts: Count,
  elapsedSec: z.number().min(0),
  ci: z.object({
    state: CiState,
    phase: CiPhase,
    counts: CiCounts,
    failing: z.array(
      z.object({ name: z.string(), workflow: z.string().nullable(), jobId: DbId.nullable(), runId: DbId.nullable() }),
    ),
    expectedMissing: z.array(z.string()),
  }),
  diagnosis: z.object({ jobs: z.array(CompactDiagnosis).max(CI_CAPS.compactJobs), partial: z.boolean() }).nullable(),
  stalled: z.array(StalledCheck),
  /** Job ids. */
  rerunCandidates: z.array(DbId),
  merge: z
    .object({
      mergeable: z.string(),
      ready: z.boolean(),
      blockers: z.array(z.string()),
      waivers: z.array(z.string()),
    })
    .nullable(),
  next: z.array(z.string()),
});

/** The only stdout of the default (non --stream) ci wait protocol. Never spilled (03 §1 row 2). */
export const WaitSummary = z.object({
  outcome: Outcome,
  exitCode: z.number().int(),
  results: z.array(TargetSummary),
  diagnosisPath: z.string().nullable(),
  eventsPath: z.string(),
  resumed: z.boolean(),
});

export type Bucket = z.infer<typeof Bucket>;
export type Check = z.infer<typeof Check>;
export type PendingCheck = z.infer<typeof PendingCheck>;
export type SameOnMain = z.infer<typeof SameOnMain>;
export type SameOnMainVerdict = z.infer<typeof SameOnMainVerdict>;
export type Flake = z.infer<typeof Flake>;
export type FailingCheck = z.infer<typeof FailingCheck>;
export type ExpectedCheck = z.infer<typeof ExpectedCheck>;
export type CiCounts = z.infer<typeof CiCounts>;
export type CiSummary = z.infer<typeof CiSummary>;
export type FailingJob = z.infer<typeof FailingJob>;
export type DiagnosisJob = z.infer<typeof DiagnosisJob>;
export type CompactDiagnosis = z.infer<typeof CompactDiagnosis>;
export type WaitEvent = z.infer<typeof WaitEvent>;
export type Outcome = z.infer<typeof Outcome>;
export type StalledCheck = z.infer<typeof StalledCheck>;
export type TargetSummary = z.infer<typeof TargetSummary>;
export type WaitSummary = z.infer<typeof WaitSummary>;
