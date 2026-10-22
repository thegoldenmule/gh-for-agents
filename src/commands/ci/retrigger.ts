// ghx ci retrigger <pr> (02 §13.2; 03 M5.2): fire fresh pull_request workflows by closing and reopening
// the PR, replacing the agents' `close && reopen && sleep` (§5.4). Flow: preflight read (state, head and
// base refs, author, viewer, head) → baseline check suites on H → PATCH closed (--dry-run halts here) →
// PATCH open (retried) → poll for new suites on H within --wait-for-runs (default 60 s, not a CI wait).
import { z } from 'zod';
import { parseCommandOverrides } from '../../ci/rerun/overrides.ts';
import {
  closePr,
  listCheckSuites,
  pollNewSuites,
  preflight,
  readRetriggerPr,
  reopenPr,
} from '../../ci/rerun/retrigger.ts';
import { defineCommand } from '../../core/command.ts';
import { formatDuration, parseDuration } from '../../core/duration.ts';
import { GhxError } from '../../core/errors.ts';
import { formatPrRef, parseTargetRef } from '../../gh/refs.ts';
import { enrichNotFound } from '../../gh/repo.ts';
import { PrRef, Sha, ShaInput } from '../../schemas/common.ts';

const DEFAULT_WINDOW = '60s';
/** The verification window is bounded: it confirms the reopen fired runs, it does not wait for CI. */
const MAX_WINDOW_MS = 300_000;
/** Time kept back from the command deadline for the output. */
const OUTPUT_MARGIN_MS = 10_000;

const Input = z.strictObject({
  pr: z.string().min(1).describe('PR: 3198, #3198, owner/repo#3198 or a PR URL'),
  expectHead: ShaInput.optional().describe('Refuse with HEAD_MOVED unless the head is this SHA'),
  waitForRuns: z
    .string()
    .default(DEFAULT_WINDOW)
    .describe('How long to look for new check suites after the reopen (e.g. 60s, 2m; max 5m)'),
  override: z.array(z.string().min(1)).optional().describe("AUTHOR_NOT_VIEWER: retrigger someone else's PR"),
  reason: z.string().optional().describe('Why the override is allowed (who asked); required with --override'),
});

const Output = z.object({
  ref: PrRef,
  headSha: Sha,
  closedAt: z.string(),
  reopenedAt: z.string(),
  newRuns: z.array(
    z.object({
      checkSuiteId: z.number().int(),
      app: z.string().nullable(),
      status: z.string().nullable(),
      createdAt: z.string().nullable(),
    }),
  ),
  overrides: z.array(z.object({ code: z.literal('AUTHOR_NOT_VIEWER'), reason: z.string() })),
  next: z.array(z.string()),
});

function windowMs(raw: string): number {
  const d = parseDuration(raw);
  const issue = !d.ok ? d.message : d.ms > MAX_WINDOW_MS ? `at most ${formatDuration(MAX_WINDOW_MS)}` : null;
  if (issue === null && d.ok) return d.ms;
  throw new GhxError('VALIDATION', `--wait-for-runs: ${issue}.`, {
    hint: 'Use a duration such as 60s or 2m (max 5m); ci retrigger only confirms new runs started.',
    details: { issues: [{ path: 'waitForRuns', code: 'duration', message: issue ?? '' }] },
  });
}

export default defineCommand({
  name: ['ci', 'retrigger'],
  summary: 'Fire fresh pull_request workflows by closing and reopening the PR (never left closed)',
  description:
    'Closes and reopens the PR so GitHub runs its pull_request workflows on the current merge ref (a rerun ' +
    'reuses the old one). Refuses unless the PR is open, its head and base branches exist and you authored ' +
    'it (AUTHOR_NOT_VIEWER, overridable). A failed reopen is retried, then REOPEN_FAILED. Afterwards it looks ' +
    'for new check suites on the head for --wait-for-runs (default 60s) and warns NO_NEW_RUNS if none appear.',
  kind: 'write',
  input: Input,
  positionals: ['pr'],
  output: Output,
  needs: { repo: 'inferred', config: 'none' },
  timeout: { defaultMs: 180_000, maxMs: 600_000 },
  replaces: ['gh pr close', 'gh pr reopen'],
  examples: [
    { argv: 'ghx ci retrigger powerhouse-inc/powerhouse#3301', note: 'Close and reopen to fire pull_request CI' },
    { argv: 'ghx ci retrigger 3301 --expect-head 9f2c4e1', note: 'Refuse if the head moved' },
    {
      argv: 'ghx ci retrigger 3169 --override AUTHOR_NOT_VIEWER --reason "user asked in chat"',
      note: "Someone else's PR, when the user asked",
    },
  ],
  async run(input, ctx) {
    const target = parseTargetRef(input.pr);
    if (target.kind !== 'pr') {
      throw new GhxError('USAGE_BAD_SELECTOR', `'${input.pr}' is not a PR selector.`, {
        hint: 'Use 3198, #3198, owner/repo#3198 or a PR URL.',
      });
    }
    const overrides = parseCommandOverrides(input.override, input.reason, ['AUTHOR_NOT_VIEWER'] as const);
    const window = windowMs(input.waitForRuns);
    const resolved = await ctx.repo({ ref: target.repo });
    const { repo } = resolved;
    let pr: Awaited<ReturnType<typeof readRetriggerPr>>;
    try {
      pr = await readRetriggerPr(ctx.gh, repo, target.number);
    } catch (e) {
      throw enrichNotFound(e, resolved, `PR #${target.number}`);
    }
    const ref = formatPrRef(repo, pr.number);
    preflight(pr, { ref, repo, expectHead: input.expectHead, overrideAuthor: overrides !== null });

    const baseline = new Set((await listCheckSuites(ctx.gh, repo, pr.headSha)).map((s) => s.id));
    ctx.preview({ ref, headSha: pr.headSha, steps: ['PATCH state:closed', 'PATCH state:open'], windowMs: window });
    // Close and reopen back to back: nothing may run between them.
    const { closedAt } = await closePr({ gh: ctx.gh, clock: ctx.clock, repo, number: pr.number });
    const { reopenedAt } = await reopenPr({ gh: ctx.gh, clock: ctx.clock, repo, number: pr.number, ref, closedAt });

    const left = ctx.deadline === undefined ? window : ctx.deadline - ctx.clock.monotonic() - OUTPUT_MARGIN_MS;
    const newRuns = await pollNewSuites({
      gh: ctx.gh,
      clock: ctx.clock,
      signal: ctx.signal,
      repo,
      sha: pr.headSha,
      baseline,
      windowMs: Math.max(0, Math.min(window, left)),
    });
    if (newRuns.length === 0) {
      ctx.warn({
        code: 'NO_NEW_RUNS',
        message: `No new check suite appeared on ${pr.headSha.slice(0, 7)} within ${formatDuration(window)} of the reopen.`,
        details: {
          hint: `Check the workflows' pull_request triggers (types: reopened is a default); ghx ci wait ${ref} reports NO_CHECKS if nothing registers.`,
        },
      });
    }
    return {
      ref,
      headSha: pr.headSha,
      closedAt,
      reopenedAt,
      newRuns,
      overrides: overrides ? [{ code: 'AUTHOR_NOT_VIEWER' as const, reason: overrides.reason }] : [],
      next: [`ghx ci wait ${ref}`],
    };
  },
});
