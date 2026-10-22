// ghx ci why <pr> (02 §12; 03 M3.1): why is CI red, in one call. The rollup is read for the head SHA
// [G-SHA]; each failing Actions job is diagnosed through the jobs API [G-LOGS] by src/ci/diagnose.ts
// (never `gh run view --log`). Red checks outside Actions are listed in nonActionsFailing.
import { z } from 'zod';
import { createDiagnoser, DIAGNOSIS_BUDGET_MS, DIAGNOSIS_MAX_JOBS, isDiagnosable } from '../../ci/diagnose.ts';
import { wildcard } from '../../ci/flake.ts';
import { fetchCiSnapshot, snapshotSummary } from '../../ci/snapshot.ts';
import { isRed } from '../../ci/summary.ts';
import { defineCommand } from '../../core/command.ts';
import { GhxError } from '../../core/errors.ts';
import { formatPrRef, parseTargetRef } from '../../gh/refs.ts';
import { enrichNotFound } from '../../gh/repo.ts';
import { repoSlug, sameRepo } from '../../gh/types.ts';
import { Check, CI_CAPS, CiSummary, FailingJob } from '../../schemas/ci.ts';
import { PrRef, Sha } from '../../schemas/common.ts';

/** Time kept back from the command deadline for the output, so a slow diagnosis ends partial, not in TIMEOUT. */
const OUTPUT_MARGIN_MS = 10_000;

const Output = z.object({
  ref: PrRef.nullable(),
  headSha: Sha,
  ci: CiSummary,
  failing: z.array(FailingJob),
  nonActionsFailing: z.array(Check),
  omitted: z.number().int().min(0),
  next: z.array(z.string()),
});

export default defineCommand({
  name: ['ci', 'why'],
  summary: 'Why CI is red: failing jobs, step, tests, errors, log path, shared-with-main and flake',
  description:
    'Diagnoses the failing checks on a PR head in one call. Logs come from the jobs API, so a finished job is ' +
    'diagnosed while the rest of its run is still going. Full logs are written to files (logPath).',
  kind: 'read',
  input: z.strictObject({
    pr: z.string().min(1).describe('PR: 3198, #3198, owner/repo#3198 or a PR URL'),
    job: z.array(z.string().min(1)).optional().describe('Only failing jobs whose name matches (repeatable; * and ?)'),
    compareMain: z
      .boolean()
      .default(true)
      .describe('Compare failures with the default branch; --no-compare-main skips it'),
    maxJobs: z
      .number()
      .int()
      .min(1)
      .max(DIAGNOSIS_MAX_JOBS)
      .default(DIAGNOSIS_MAX_JOBS)
      .describe('Failing jobs to diagnose'),
    excerptLines: z
      .number()
      .int()
      .min(1)
      .max(CI_CAPS.excerptLinesMax)
      .default(CI_CAPS.excerptLinesDefault)
      .describe('Log excerpt lines per job'),
  }),
  positionals: ['pr'],
  output: Output,
  needs: { repo: 'inferred', config: 'optional' },
  timeout: { defaultMs: 120_000, maxMs: 300_000 },
  replaces: ['gh run view --log', 'gh run view --log-failed', 'gh api repos/{o}/{r}/actions/jobs/{id}/logs'],
  examples: [
    { argv: 'ghx ci why 3301 -R powerhouse-inc/powerhouse', note: 'Diagnose the failing checks on PR #3301' },
    { argv: "ghx ci why owner/repo#12 --job 'Test*'", note: 'Only jobs whose name starts with Test' },
    { argv: 'ghx ci why 12 --no-compare-main', note: 'Skip the comparison with the default branch' },
  ],
  async run(input, ctx) {
    const target = parseTargetRef(input.pr);
    if (target.kind !== 'pr') {
      throw new GhxError('USAGE_BAD_SELECTOR', `'${input.pr}' is a workflow ${target.kind} URL, not a PR.`, {
        hint: 'Pass a PR: 3198, #3198, owner/repo#3198 or a PR URL.',
      });
    }
    const resolved = await ctx.repo({ ref: target.repo });
    const { repo } = resolved;
    if (resolved.source !== 'cwd' && resolved.cwdRepo && !sameRepo(resolved.cwdRepo, repo)) {
      ctx.warn({
        code: 'CWD_REPO_MISMATCH',
        message: `Reading ${repoSlug(repo)}; the cwd checkout is ${repoSlug(resolved.cwdRepo)}.`,
      });
    }
    const ci = (await ctx.config({ ref: repo })).config.ci;
    let snapshot: Awaited<ReturnType<typeof fetchCiSnapshot>>;
    try {
      snapshot = await fetchCiSnapshot({ gh: ctx.gh, repo, number: target.number, ignore: ci.ignore, warn: ctx.warn });
    } catch (e) {
      throw enrichNotFound(e, resolved, `PR #${target.number}`);
    }
    const ref = formatPrRef(repo, snapshot.number);
    const red = snapshot.checks.filter(isRed);
    const patterns = (input.job ?? []).map(wildcard);
    const candidates = red
      .filter(isDiagnosable)
      .filter((c) => patterns.length === 0 || patterns.some((p) => p.test(c.name)));

    const diagnoser = createDiagnoser({
      gh: ctx.gh,
      artifacts: ctx.artifacts,
      clock: ctx.clock,
      repo,
      headSha: snapshot.headSha,
      defaultBranch: snapshot.defaultBranch,
      runs: snapshot.runs,
      config: ci,
      compareMain: input.compareMain,
      excerptLines: input.excerptLines,
      warn: ctx.warn,
    });
    const remaining = ctx.deadline === undefined ? Infinity : ctx.deadline - ctx.clock.monotonic() - OUTPUT_MARGIN_MS;
    const d = await diagnoser.diagnose(candidates, {
      maxJobs: input.maxJobs,
      budgetMs: Math.max(0, Math.min(DIAGNOSIS_BUDGET_MS, remaining)),
    });

    const summary = snapshotSummary(snapshot);
    const next: string[] = [];
    if (summary.state === 'pending') next.push(`ghx ci wait ${ref}`);
    if (d.jobs.some((j) => j.flake.candidate)) next.push(`ghx ci rerun ${ref} --flaky`);
    if (d.omitted > 0) next.push(`ghx ci why ${ref} --job '<name>'`);
    return {
      ref,
      headSha: snapshot.headSha,
      ci: summary,
      failing: d.jobs,
      nonActionsFailing: red.filter((c) => !isDiagnosable(c)),
      omitted: d.omitted,
      next,
    };
  },
});
