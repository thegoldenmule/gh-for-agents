// ghx ci wait <target>… (02 §11; 03 M4.7–M4.9): wait for CI on a bound SHA until a state the agent can
// act on, then print one WaitSummary. The caller never supplies a duration: the wait ends on CI-derived
// states only (green, red, red-shared, no-checks, stalled, superseded/closed), on a signal
// (interrupted), or with `pending` (exit 15) after 25 min in an unattended session.
import { z } from 'zod';
import { runWait } from '../../ci/wait/driver.ts';
import { createMergeGate } from '../../ci/wait/mergeable.ts';
import { defineStreamCommand } from '../../core/command.ts';
import type { ExitCode } from '../../core/exit.ts';
import { WaitEvent, WaitSummary } from '../../schemas/ci.ts';

/** 02 §11.0, verbatim (M12 asserts the same string in the agent docs). */
export const PROTOCOL =
  'Run `ghx ci wait <pr>` with the Bash tool and `run_in_background: true`. Then continue other work or end ' +
  'your turn. Do not poll, sleep, or use Monitor for CI. You will be re-invoked when it exits. Its stdout is ' +
  'the full answer and its exit code is the outcome (§6.1).';

const Input = z.strictObject({
  targets: z
    .array(z.string().min(1))
    .min(1)
    .max(10)
    .describe('PR selectors (3198, owner/repo#3198, a PR URL), branch:<name> or branch:<name>@<sha>'),
  until: z
    .enum(['first-failure', 'settled', 'mergeable'])
    .default('first-failure')
    .describe(
      'first-failure: return at the first new failure or settled green; settled: wait for everything; ' +
        'mergeable: settled, then the merge CI gate (PR targets only)',
    ),
  any: z.boolean().default(false).describe('Return when the first target reaches a terminal state'),
  onHeadChange: z
    .enum(['restart', 'stop', 'stay'])
    .optional()
    .describe('On a head change: restart (PR default), stop (exit 12) or stay (branch default)'),
  check: z.array(z.string().min(1)).optional().describe('Only checks whose name matches (repeatable; globs)'),
  diagnose: z.boolean().default(true).describe('Diagnose each failure as it lands; --no-diagnose skips it'),
  compareMain: z
    .boolean()
    .default(true)
    .describe('Compare failures with the default branch; --no-compare-main skips it'),
  stream: z.boolean().default(false).describe('Print every event as NDJSON (for humans; agents use the default)'),
});

export default defineStreamCommand({
  name: ['ci', 'wait'],
  summary: 'Wait for CI on a PR or branch; one JSON summary, exit code = outcome (run in background)',
  description: PROTOCOL,
  kind: 'read',
  input: Input,
  positionals: ['targets'],
  needs: { repo: 'inferred', config: 'optional' },
  timeout: null,
  event: WaitEvent,
  summarySchema: WaitSummary,
  outputMode: (input) => (input.stream ? 'ndjson' : 'final'),
  replaces: ['gh pr checks --watch', 'gh run watch', 'gh pr checks', 'gh run list'],
  examples: [
    { argv: 'ghx ci wait 3301 -R powerhouse-inc/powerhouse', note: 'Run with run_in_background: true' },
    { argv: 'ghx ci wait owner/repo#12 --until settled', note: 'Wait for every check, not the first failure' },
    { argv: 'ghx ci wait owner/repo#12 --until mergeable', note: 'Settled CI, then the merge CI gate' },
    { argv: 'ghx ci wait branch:main@9f2c4e1 -R owner/repo', note: 'CI for one commit on a branch' },
    { argv: 'ghx ci wait owner/repo#12 owner/repo#13 --any', note: 'Return at the first target that finishes' },
  ],
  exitCode: (s) => s.exitCode as ExitCode,
  run(input, ctx) {
    if (input.until !== 'mergeable') return runWait(input, ctx);
    const onSettled = createMergeGate(ctx, { compareMain: input.compareMain, useAgedOut: !input.check?.length });
    return runWait(input, ctx, { onSettled });
  },
});
