// The recorded runner logs (gh/logs/<runner>-fail, scripts/fixtures/scenarios/logs-matrix.ts) and the
// hand-written corpus-shape logs (gh/logs/*.log), for the extractor tests.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeJob, type JobAnalysis } from '../../../../src/ci/logs/analyze.ts';
import { stripText } from '../../../../src/ci/logs/strip.ts';
import { GH_FIXTURE_ROOT } from '../../../helpers/fixture-match.ts';
import { ciEnv, repoOf } from '../_helpers.ts';

export const RECORDED = {
  vitest: { scenario: 'logs/vitest-fail', repo: 'vitest-dev/vitest', jobId: 119784717653 },
  jest: { scenario: 'logs/jest-fail', repo: 'facebook/react', jobId: 119620576517 },
  'node-test': { scenario: 'logs/node-test-fail', repo: 'nodejs/undici', jobId: 118006467479 },
  pytest: { scenario: 'logs/pytest-fail', repo: 'pytest-dev/pytest', jobId: 118816259139 },
  go: { scenario: 'logs/go-fail', repo: 'grpc/grpc-go', jobId: 119722003331 },
} as const;

/** Run the whole analyze pipeline (jobs API, log fetch, steps, extract) over a recorded scenario. */
export async function analyzeRecorded(
  runner: keyof typeof RECORDED,
  o: { logPatterns?: string[] } = {},
): Promise<JobAnalysis> {
  const r = RECORDED[runner];
  const env = ciEnv(r.scenario);
  const out = await analyzeJob({ gh: env.gh, artifacts: env.artifacts, repo: repoOf(r.repo), jobId: r.jobId, ...o });
  env.fake.expectNoMutations();
  env.fake.expectNoCall({ prefix: ['run', 'view'] });
  return out;
}

/** A corpus-shape raw log (gh/logs/<name>.log), cleaned. */
export function corpusLog(name: 'cancelled.log' | 'pnpm-err.log' | 'infra-econnreset.log'): string[] {
  return stripText(readFileSync(join(GH_FIXTURE_ROOT, 'logs', name), 'utf8'));
}
