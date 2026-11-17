// ghx pr land <pr>: wait until the PR is mergeable, then merge it, in one call (research: lifecycles §5
// avenue 2). The wait is `ci wait --until mergeable` (src/ci/wait/driver.ts with the merge gate), bound to
// one head and stopping if it moves (exit 12); the merge is `pr merge` pinned to that head, with the same
// policy checks. It never merges on red CI, a conflict, a moved head or a policy refusal: it returns the
// wait's diagnosis, or the merge refusal as `error`, with that error's exit code. Placement follows ci
// wait: the main thread runs it in the background, a subagent in the foreground with --foreground.
// Where the base branch has a merge queue, the merge step adds the PR to the queue (pinned to the same head)
// and land keeps waiting, under the same self-return rules, until the queue has merged it (`merged`) or
// dropped it (`queue-dropped`, exit 9). A re-run finds the PR in the queue and resumes that wait.
import { z } from 'zod';
import { runWait, type SettleHook, selfReturnAt } from '../../ci/wait/driver.ts';
import type { ExpectedDef } from '../../ci/wait/expected.ts';
import { createMergeGate } from '../../ci/wait/mergeable.ts';
import { compactTarget, fitDocument, shellArg } from '../../ci/wait/summary.ts';
import { MergeMethod } from '../../config/sections/_shared.ts';
import { defineStreamCommand, type StreamContext } from '../../core/command.ts';
import { GhxError, toErrorObject } from '../../core/errors.ts';
import { ExitCode as Exit, type ExitCode } from '../../core/exit.ts';
import { DEFAULT_MAX_BYTES } from '../../core/output.ts';
import { MergePlan } from '../../policy/schemas.ts';
import { planMerge } from '../../pr/merge/plan.ts';
import { waitForQueue } from '../../pr/merge/queue.ts';
import { PrMergeOutput } from '../../pr/merge/schema.ts';
import { TargetSummary, WaitEvent } from '../../schemas/ci.ts';
import { Sha, ShaInput } from '../../schemas/common.ts';
import { mergePr } from './merge.ts';

const Input = z.strictObject({
  pr: z.string().min(1).describe('PR: 3198, #3198, owner/repo#3198 or a PR URL'),
  expectHead: ShaInput.optional().describe(
    'Land only this head (7–40 hex): wait for the PR to reach it; default the local HEAD when on the PR branch and pushed',
  ),
  method: MergeMethod.optional().describe(
    'merge (default: merge.method); squash or rebase only when config allows. With a merge queue: must be its method',
  ),
  override: z
    .array(z.string().min(1))
    .optional()
    .describe('Overridable blocker codes the user accepted (CODE or CODE,CODE); needs --reason'),
  reason: z.string().optional().describe('Why the override is allowed (who asked); one line, ≤200 chars'),
  deleteBranch: z
    .boolean()
    .optional()
    .describe(
      'Delete the same-repo head branch after merging (default: merge.deleteBranch); remote ref only. ' +
        'Not needed when the repo deletes head branches on merge: headBranch reports the state either way',
    ),
  foreground: z
    .boolean()
    .default(false)
    .describe(
      'Return pending (exit 15) after 9 min, under the Bash tool cap (a subagent); re-run the identical command',
    ),
});

const LandError = z.object({
  code: z.string(),
  message: z.string(),
  hint: z.string().nullable(),
  details: z.record(z.string(), z.unknown()).nullable(),
});

export const LandSummary = z.object({
  ref: z.string().describe('owner/repo#N'),
  outcome: z
    .enum([
      'merged',
      'already-merged',
      'would-merge',
      'would-queue',
      'not-merged',
      'queue-dropped',
      'pending',
      'interrupted',
    ])
    .describe(
      'merged (directly, or by the merge queue: merge.queue is set); already-merged (at the evaluated head); ' +
        'would-merge (--dry-run); would-queue (--dry-run: it would be added to the merge queue); not-merged ' +
        '(see reason, wait, error); queue-dropped (the merge queue removed it without merging: see error); ' +
        'pending (exit 15: re-run the identical command; reason in-merge-queue once it is queued); interrupted',
    ),
  exitCode: z.number().int(),
  reason: z
    .string()
    .nullable()
    .describe(
      "Why it did not merge: the wait's reason (first-failure, settled, merge-blocked, …), in-merge-queue, or the merge error code",
    ),
  headSha: Sha.nullable().describe('The head the wait judged and the merge was pinned to'),
  wait: TargetSummary.nullable().describe('The ci wait --until mergeable result: CI, diagnosis, merge gate'),
  merge: PrMergeOutput.nullable().describe(
    'The pr merge result, once merged; while pending in the merge queue, queued: true with the queue entry',
  ),
  plan: MergePlan.nullable().describe('--dry-run: the merge (or, via: queue, the enqueue) that would be sent'),
  error: LandError.nullable().describe(
    'The merge refusal (MERGE_BLOCKED, HEAD_MOVED, MERGE_QUEUE_DROPPED, …), with its exit code as exitCode',
  ),
  diagnosisPath: z.string().nullable(),
  eventsPath: z.string(),
  next: z.array(z.string()),
});
export type LandSummary = z.infer<typeof LandSummary>;

type Flags = z.output<typeof Input>;

/** The expected set the merge gate judged, last seen (driver SettleHook). */
type Judged = { defs: readonly ExpectedDef[]; agedOut: readonly string[] };

/** The identical command, for `pending` and `interrupted`. */
function landCommand(i: Flags): string {
  const parts = ['ghx', 'pr', 'land', shellArg(i.pr)];
  if (i.expectHead) parts.push('--expect-head', i.expectHead);
  if (i.method) parts.push('--method', i.method);
  if (i.override?.length) parts.push('--override', shellArg(i.override.join(',')));
  if (i.reason) parts.push('--reason', shellArg(i.reason));
  if (i.deleteBranch !== undefined) parts.push(i.deleteBranch ? '--delete-branch' : '--no-delete-branch');
  if (i.foreground) parts.push('--foreground');
  return parts.join(' ');
}

/** Should the merge be tried: CI let it (green, a shared red the gate waived, or a block that is not CI). */
function mergeable(t: TargetSummary): boolean {
  if (t.outcome === 'green' || (t.outcome === 'red-shared' && t.merge?.ready === true)) return true;
  // Blocked by something other than CI (a review, a draft, a policy the --override may accept): pr merge
  // reports exactly what, with its exit code (9 state, 6 policy).
  if (t.outcome === 'red' && t.reason === 'merge-blocked') return !(t.merge?.blockers ?? []).includes('CI_RED');
  // Merged by someone else meanwhile: pr merge reports alreadyMerged when it was at the evaluated head.
  return t.outcome === 'closed' && t.reason === 'merged';
}

/** The wait's `next`, for land: re-waits become the identical land, pr merge previews go. */
function waitNext(t: TargetSummary, again: string): string[] {
  const out = t.next.flatMap((n) => (n.startsWith('ghx ci wait') ? [again] : n.startsWith('ghx pr merge') ? [] : [n]));
  if (t.outcome === 'red' && !out.some((n) => n.startsWith('ghx ci why'))) out.unshift(`ghx ci why ${t.target}`);
  return [...new Set(out)];
}

async function merge(i: Flags, t: TargetSummary, ctx: StreamContext, expected: Judged | null, returnAt: number) {
  const flags = {
    pr: t.target,
    expectHead: t.headSha ?? undefined,
    method: i.method,
    override: i.override,
    reason: i.reason,
    // The set the gate judged ready: the merge must not re-derive another one (one check set).
    ...(expected ? { expected } : {}),
  };
  if (ctx.dryRun) {
    // A stream command cannot halt at a mutation: plan it (every check, no PUT) and say what would be sent.
    const d = await planMerge(ctx, flags);
    return { kind: 'dry' as const, plan: d.plan, decision: d.kind };
  }
  const out = await mergePr(
    {
      ...flags,
      deleteBranch: i.deleteBranch,
      // Queued is not landed: wait for the merge queue too, until this call's self-return.
      awaitQueue: (q) => waitForQueue({ ...q, returnAt }),
    },
    ctx,
  );
  return { kind: 'merged' as const, out: PrMergeOutput.parse(out) };
}

export default defineStreamCommand({
  name: ['pr', 'land'],
  summary: 'Wait until mergeable, then merge (or queue) pinned to that head; run like ci wait',
  description:
    'ci wait --until mergeable, then pr merge, in one call. The wait binds one head (--expect-head, or the ' +
    'local HEAD when the cwd is on the PR branch and pushed) and stops with exit 12 if the head moves; the ' +
    "merge is pinned to that head and runs pr merge's policy checks. Never merges on red CI (exit 10, with " +
    'the diagnosis), no checks or a conflict (13), a stall (14), a moved head (12) or a merge refusal ' +
    '(error: MERGE_BLOCKED exit 9 or 6, HEAD_MOVED 9). Where the base branch has a merge queue, the PR is ' +
    'added to the queue pinned to that head, and land waits until the queue has merged it (outcome merged, ' +
    'merge.queue set) or removed it (outcome queue-dropped, error MERGE_QUEUE_DROPPED, exit 9); --method ' +
    "must name the queue's method. Run it like ci wait: in the background on the main thread; in a " +
    'subagent in the foreground with --foreground (the ghx hook arranges both), re-running the identical ' +
    'command on exit 15 (it resumes the queue wait too). --dry-run waits, then plans the merge (or the ' +
    'enqueue: outcome would-queue) without sending it.',
  kind: 'write',
  input: Input,
  positionals: ['pr'],
  needs: { repo: 'inferred', config: 'required' },
  timeout: null,
  event: WaitEvent,
  summarySchema: LandSummary,
  outputMode: 'final',
  maxBytes: 'fixed',
  brief: [
    'ref',
    'outcome',
    'reason',
    'headSha',
    'wait.ci.state',
    'wait.ci.failing.name',
    'wait.diagnosis.jobs.job',
    'wait.diagnosis.jobs.firstError',
    'wait.merge.blockers',
    'merge.mergeCommit',
    'merge.queued',
    'merge.queue.state',
    'merge.queue.position',
    'merge.headBranch.state',
    'error.code',
    'error.message',
    'next',
  ],
  examples: [
    { argv: 'ghx pr land 3301 -R owner/repo', note: 'Main thread: run with run_in_background: true' },
    { argv: 'ghx pr land --foreground owner/repo#12', note: 'Subagent: foreground; re-run on exit 15' },
    { argv: 'ghx pr land owner/repo#12 --expect-head 9f2c4e1', note: 'Land exactly 9f2c4e1, after a push' },
  ],
  exitCode: (s) => s.exitCode as ExitCode,
  async *run(input, ctx) {
    const again = landCommand(input);
    // One self-return for the whole call: the CI wait and the merge queue wait share the 9 minutes.
    const returnAt = selfReturnAt(ctx, input.foreground, ctx.clock.monotonic());
    const mergeGate = createMergeGate(ctx, { compareMain: true, useAgedOut: true });
    let judged: Judged | null = null;
    const gate: SettleHook = (a) => {
      judged = { defs: a.expected, agedOut: a.agedOut };
      return mergeGate(a);
    };
    const waited = yield* runWait(
      {
        targets: [input.pr],
        until: 'mergeable',
        any: false,
        onHeadChange: 'stop',
        diagnose: true,
        compareMain: true,
        stream: false,
        foreground: input.foreground,
        expectHead: input.expectHead,
        rerun: again,
      },
      ctx,
      { onSettled: gate },
    );
    const t = waited.results[0] as TargetSummary;
    const base = {
      ref: t.target,
      headSha: t.headSha,
      diagnosisPath: waited.diagnosisPath,
      eventsPath: waited.eventsPath,
      merge: null,
      plan: null,
      error: null,
    };
    let doc: Omit<LandSummary, 'wait'>;
    if (t.outcome === 'pending' || t.outcome === 'interrupted') {
      doc = { ...base, outcome: t.outcome, exitCode: waited.exitCode, reason: t.reason, next: [again] };
    } else if (!mergeable(t)) {
      doc = { ...base, outcome: 'not-merged', exitCode: waited.exitCode, reason: t.reason, next: waitNext(t, again) };
    } else {
      try {
        const m = await merge(input, t, ctx, judged, returnAt);
        if (m.kind === 'dry') {
          const already = m.decision === 'already-merged';
          const queue = m.decision === 'enqueue' || m.decision === 'queued';
          doc = {
            ...base,
            outcome: already ? 'already-merged' : queue ? 'would-queue' : 'would-merge',
            exitCode: Exit.OK,
            reason: m.decision === 'queued' ? 'already-queued' : null,
            plan: m.plan,
            next: already ? [] : [again],
          };
        } else if (m.out.queued) {
          // The self-return came while the PR is in the merge queue: the identical command resumes the wait.
          if (input.foreground) {
            ctx.warn({
              code: 'WAIT_FOREGROUND_RETURN',
              message:
                `Returned before the Bash tool's 10-minute cap; ${t.target} is still in the merge queue. Re-run ` +
                `the identical command in the foreground (next[0]) to keep waiting: ${again}`,
            });
          }
          doc = {
            ...base,
            outcome: 'pending',
            exitCode: Exit.CI_PENDING_RESUME,
            reason: 'in-merge-queue',
            merge: m.out,
            next: [again],
          };
        } else {
          doc = {
            ...base,
            outcome: m.out.alreadyMerged ? 'already-merged' : 'merged',
            exitCode: Exit.OK,
            reason: null,
            merge: m.out,
            next: m.out.next,
          };
        }
      } catch (e) {
        if (!(e instanceof GhxError)) throw e;
        const { error } = toErrorObject(e);
        if (e.code === 'INTERRUPTED') {
          // A signal during the merge queue wait: nothing is lost, the PR stays queued.
          const signal = (e.details as { signal?: string } | null | undefined)?.signal ?? 'SIGTERM';
          doc = { ...base, outcome: 'interrupted', exitCode: e.exitCode, reason: `signal ${signal}`, next: [again] };
        } else {
          const dropped = e.code === 'MERGE_QUEUE_DROPPED';
          doc = {
            ...base,
            outcome: dropped ? 'queue-dropped' : 'not-merged',
            exitCode: e.exitCode,
            reason: e.code,
            error,
            next: dropped || !error.hint ? [`ghx pr status ${t.target}`] : [],
          };
        }
      }
    }
    // One document within 16 KB: the wait's detail is cut first (its full form is in diagnosisPath).
    return fitDocument((lvl) => ({ ...doc, wait: compactTarget(t, lvl) }), DEFAULT_MAX_BYTES - 3_072, ctx.project).doc;
  },
});
