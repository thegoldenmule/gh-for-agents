import { GhxError } from '../../core/errors.ts';
import type { PrSnapshot } from '../snapshot/index.ts';

export interface CheckExclusion {
  code: string;
  reason: string;
  checkId?: number;
}

/** Verify a supplied running check on this head/run. The caller identifies its gate; siblings are indistinguishable. */
export function excludeSelfCheck(snapshot: PrSnapshot, checkId: number, runId: number) {
  const own = snapshot.ci.checks.find((check) => check.jobId === checkId);
  if (own?.kind !== 'actions' || own.runId !== runId || own.bucket !== 'pending' || own.status !== 'in_progress') {
    throw new GhxError('VALIDATION', 'The self-check id is not a running Actions check in this workflow run.', {
      details: {
        issues: [
          {
            path: 'selfCheck',
            code: 'check.self_not_running',
            message:
              'Supply a running Actions check-run id on this PR head in GITHUB_RUN_ID. The caller must identify its own gate; a same-run sibling cannot be distinguished.',
          },
        ],
      },
    });
  }
  // Keep its exact name/identity in the expected set, satisfying only that one check hypothetically.
  // Removing it would cause requiredSources/config expectations to re-add it as missing.
  const ci = {
    ...snapshot.ci,
    checks: snapshot.ci.checks.map((check) =>
      check === own
        ? { ...check, bucket: 'pass' as const, status: 'completed' as const, conclusion: 'success' }
        : check,
    ),
  };
  return {
    snapshot: { ...snapshot, ci },
    exclusion: {
      code: 'CI_SELF_CHECK',
      checkId,
      reason: `Supplied running check ${own.name} (${checkId}) in run ${runId} on head ${snapshot.head.sha} is excluded. The caller is responsible for identifying its own gate.`,
    } satisfies CheckExclusion,
  };
}
