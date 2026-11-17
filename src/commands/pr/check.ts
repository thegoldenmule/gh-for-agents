import { z } from 'zod';
import { describeSource, loadConfigAtRef } from '../../config/load.ts';
import { defineCommand } from '../../core/command.ts';
import { GhxError } from '../../core/errors.ts';
import { ExitCode } from '../../core/exit.ts';
import { validateRefs } from '../../pr/check/refs.ts';
import { PrCheckOutput } from '../../pr/check/schema.ts';
import { validatePr } from '../../pr/check/validate.ts';
import { resolveTarget } from '../../pr/feedback-writes/read.ts';
import { deriveImpact } from '../../pr/impact/derive.ts';
import { readImpactFiles, readImpactPr } from '../../pr/impact/read.ts';
import { loadPrStatus } from '../../pr/status/compose.ts';

export default defineCommand({
  name: ['pr', 'check'],
  summary: 'Validate a PR’s stored block and optional repository merge gates in CI',
  description:
    'Read-only validation against config at the pinned target-branch SHA. No working-tree policy is trusted and no metadata is repaired. The standalone binary needs gh and GITHUB_TOKEN, without an interactive login. --merge-policy excludes CI-user ownership/write permissions. --self-check excludes the supplied running Actions check on this PR head in GITHUB_RUN_ID. The caller must identify its own gate; same-run siblings cannot be distinguished. GitHub still enforces aggregate branch protection.',
  kind: 'read',
  input: z.strictObject({
    pr: z.string().min(1),
    mergePolicy: z.boolean().default(false),
    selfCheck: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Supplied running Actions check-run id on this PR head; caller must identify its own gate. Requires --merge-policy and GITHUB_RUN_ID',
      ),
  }),
  positionals: ['pr'],
  needs: { repo: 'inferred', config: 'none' },
  output: PrCheckOutput,
  timeout: { defaultMs: 120_000, maxMs: 300_000 },
  examples: [
    { argv: 'ghx pr check owner/repo#12', note: 'Validate metadata against the pinned base policy' },
    {
      argv: 'ghx pr check 12 --merge-policy --self-check 123456 -R owner/repo',
      note: 'Evaluate repository gates from Actions with this job excluded',
    },
  ],
  exitCode(out) {
    return out.issues.length ? ExitCode.USAGE : out.mergePolicy?.allowed === false ? ExitCode.POLICY : ExitCode.OK;
  },
  async run(input, ctx) {
    const runId = ctx.env.GITHUB_RUN_ID ? Number(ctx.env.GITHUB_RUN_ID) : undefined;
    if (input.selfCheck !== undefined && (!input.mergePolicy || !Number.isSafeInteger(runId) || (runId ?? 0) <= 0)) {
      throw new GhxError('VALIDATION', '--self-check requires --merge-policy and a positive GITHUB_RUN_ID.', {
        details: {
          issues: [
            {
              path: 'selfCheck',
              code: 'check.self_context',
              message: 'Set GITHUB_RUN_ID and supply this running job’s exact check-run id.',
            },
          ],
        },
      });
    }
    const target = await resolveTarget(ctx, input.pr);
    const { pr, files } = await readImpactFiles(ctx.gh, target.repo, target.number);
    const loaded = await loadConfigAtRef(ctx.gh, target.repo, pr.base.sha);
    const issues = validatePr(pr, files, loaded.config);
    issues.push(...(await validateRefs(ctx.gh, target.repo, pr.body ?? '', pr.base)));
    let mergePolicy: z.input<typeof PrCheckOutput>['mergePolicy'] = null;
    let excludedChecks: z.input<typeof PrCheckOutput>['excludedChecks'] = [];
    let warnings: z.input<typeof PrCheckOutput>['warnings'] = [];
    if (input.mergePolicy) {
      const state = await loadPrStatus({
        gh: ctx.gh,
        clock: ctx.clock,
        artifacts: ctx.artifacts,
        signal: ctx.signal,
        repo: target.repo,
        number: target.number,
        config: loaded.config,
        configSource: loaded.source,
        waitMergeable: false,
        compareMain: loaded.config.merge.sharedRed !== 'off',
        request: { method: loaded.config.merge.method },
        deadline: ctx.deadline,
        scope: 'repository-gate',
        ...(input.selfCheck !== undefined ? { selfCheck: { checkId: input.selfCheck, runId: runId as number } } : {}),
      });
      if (state.snapshot.head.sha !== pr.head.sha || state.snapshot.base.sha !== pr.base.sha) {
        throw new GhxError('HEAD_MOVED', 'The PR head or target branch moved during policy evaluation; retry.');
      }
      mergePolicy = {
        allowed: state.evaluation.ready,
        checks: state.evaluation.plan.checks,
        blockers: state.evaluation.plan.blockers,
      };
      const unavailable = state.warnings.filter((warning) =>
        ['CI_DETAIL_UNAVAILABLE', 'REQUIRED_CHECKS_UNKNOWN'].includes(warning.code),
      );
      if (unavailable.length) {
        mergePolicy.allowed = false;
        mergePolicy.blockers.push({
          code: 'POLICY_FACTS_UNAVAILABLE',
          message: unavailable.map((warning) => warning.message).join(' '),
          overridable: false,
        });
        mergePolicy.checks.push({
          code: 'POLICY_FACTS_UNAVAILABLE',
          status: 'fail',
          message: 'Required policy facts could not be established; retry with sufficient read permissions.',
        });
      }
      excludedChecks = state.excludedChecks;
      warnings = state.warnings;
    }
    const after = await readImpactPr(ctx.gh, target.repo, target.number);
    if (after.head.sha !== pr.head.sha || after.base.sha !== pr.base.sha || after.updated_at !== pr.updated_at) {
      throw new GhxError('HEAD_MOVED', 'The PR changed during validation; retry.');
    }
    return {
      ref: target.ref,
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      valid: issues.length === 0 && mergePolicy?.allowed !== false,
      issues,
      impact: deriveImpact(files, loaded.config.components),
      config: describeSource(loaded.source),
      mergePolicy,
      excludedChecks,
      warnings,
    };
  },
});
