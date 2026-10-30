// ghx pr land <pr>: wait until the PR is mergeable, then merge it, in one call (research: lifecycles §5
// avenue 2). The wait is `ci wait --until mergeable` (src/ci/wait/driver.ts with the merge gate), bound to
// one head and stopping if it moves (exit 12); the merge is `pr merge` pinned to that head, with the same
// policy checks. It never merges on red CI, a conflict, a moved head or a policy refusal: it returns the
// wait's diagnosis, or the merge refusal as `error`, with that error's exit code. Placement follows ci
// wait: the main thread runs it in the background, a subagent in the foreground with --foreground.
import { z } from 'zod';
import { runWait } from '../../ci/wait/driver.ts';
import { createMergeGate } from '../../ci/wait/mergeable.ts';
import { compactTarget, fitDocument, shellArg } from '../../ci/wait/summary.ts';
import { MergeMethod } from '../../config/sections/_shared.ts';
import { defineStreamCommand, type StreamContext } from '../../core/command.ts';
import { GhxError, toErrorObject } from '../../core/errors.ts';
import { ExitCode as Exit, type ExitCode } from '../../core/exit.ts';
import { DEFAULT_MAX_BYTES } from '../../core/output.ts';
import { MergePlan } from '../../policy/schemas.ts';
import { planMerge } from '../../pr/merge/plan.ts';
import { PrMergeOutput } from '../../pr/merge/schema.ts';
import { TargetSummary, WaitEvent } from '../../schemas/ci.ts';
import { Sha, ShaInput } from '../../schemas/common.ts';
import mergeCommand from './merge.ts';

const Input = z.strictObject({
  pr: z.string().min(1).describe('PR: 3198, #3198, owner/repo#3198 or a PR URL'),
  expectHead: ShaInput.optional().describe(
    'Land only this head (7–40 hex): wait for the PR to reach it; default the local HEAD when on the PR branch and pushed',
  ),
  method: MergeMethod.optional().describe('merge (default: merge.method); squash or rebase only when config allows'),
  override: z
    .array(z.string().min(1))
    .optional()
    .describe('Overridable blocker codes the user accepted (CODE or CODE,CODE); needs --reason'),
  reason: z.string().optional().describe('Why the override is allowed (who asked); one line, ≤200 chars'),
  deleteBranch: z
    .boolean()
    .optional()
    .describe('Delete the same-repo head branch after merging (default: merge.deleteBranch); remote ref only'),
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
    .enum(['merged', 'already-merged', 'would-merge', 'not-merged', 'pending', 'interrupted'])
    .describe(
      'merged; already-merged (at the evaluated head); would-merge (--dry-run); not-merged (see reason, wait, error); pending (exit 15: re-run the identical command); interrupted',
    ),
  exitCode: z.number().int(),
  reason: z
    .string()
    .nullable()
    .describe(
      "Why it did not merge: the wait's reason (first-failure, settled, merge-blocked, …) or the merge error code",
    ),
  headSha: Sha.nullable().describe('The head the wait judged and the merge was pinned to'),
  wait: TargetSummary.nullable().describe('The ci wait --until mergeable result: CI, diagnosis, merge gate'),
  merge: PrMergeOutput.nullable().describe('The pr merge result, once merged'),
  plan: MergePlan.nullable().describe('--dry-run: the merge that would be sent'),
  error: LandError.nullable().describe(
    'The merge refusal (MERGE_BLOCKED, HEAD_MOVED, …), with its exit code as exitCode',
  ),
  diagnosisPath: z.string().nullable(),
  eventsPath: z.string(),
  next: z.array(z.string()),
});
export type LandSummary = z.infer<typeof LandSummary>;

type Flags = z.output<typeof Input>;

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

async function merge(i: Flags, t: TargetSummary, ctx: StreamContext) {
  const flags = {
    pr: t.target,
    expectHead: t.headSha ?? undefined,
    method: i.method,
    override: i.override,
    reason: i.reason,
  };
  if (ctx.dryRun) {
    // A stream command cannot halt at a mutation: plan it (every check, no PUT) and say what would be sent.
    const d = await planMerge(ctx, flags);
    return { kind: 'dry' as const, plan: d.plan, already: d.kind === 'already-merged' };
  }
  const out = await mergeCommand.run({ ...flags, deleteBranch: i.deleteBranch }, ctx);
  return { kind: 'merged' as const, out: PrMergeOutput.parse(out) };
}

export default defineStreamCommand({
  name: ['pr', 'land'],
  summary: 'Wait until a PR is mergeable, then merge it pinned to that head; one JSON outcome',
  description:
    'ci wait --until mergeable, then pr merge, in one call. The wait binds one head (--expect-head, or the ' +
    'local HEAD when the cwd is on the PR branch and pushed) and stops with exit 12 if the head moves; the ' +
    "merge is pinned to that head and runs pr merge's policy checks. Never merges on red CI (exit 10, with " +
    'the diagnosis), no checks or a conflict (13), a stall (14), a moved head (12) or a merge refusal ' +
    '(error: MERGE_BLOCKED exit 9 or 6, HEAD_MOVED 9). Run it like ci wait: in the background on the main ' +
    'thread; in a subagent in the foreground with --foreground (the ghx hook arranges both), re-running ' +
    'the identical command on exit 15. --dry-run waits, then plans the merge without sending it.',
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
    const gate = createMergeGate(ctx, { compareMain: true, useAgedOut: true });
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
        const m = await merge(input, t, ctx);
        doc =
          m.kind === 'dry'
            ? {
                ...base,
                outcome: m.already ? 'already-merged' : 'would-merge',
                exitCode: Exit.OK,
                reason: null,
                plan: m.plan,
                next: m.already ? [] : [again],
              }
            : {
                ...base,
                outcome: m.out.alreadyMerged ? 'already-merged' : 'merged',
                exitCode: Exit.OK,
                reason: null,
                merge: m.out,
                next: m.out.next,
              };
      } catch (e) {
        if (!(e instanceof GhxError)) throw e;
        const { error } = toErrorObject(e);
        doc = {
          ...base,
          outcome: 'not-merged',
          exitCode: e.exitCode,
          reason: e.code,
          error,
          next: error.hint ? [] : [`ghx pr status ${t.target}`],
        };
      }
    }
    // One document within 16 KB: the wait's detail is cut first (its full form is in diagnosisPath).
    return fitDocument((lvl) => ({ ...doc, wait: compactTarget(t, lvl) }), DEFAULT_MAX_BYTES - 3_072, ctx.project).doc;
  },
});
