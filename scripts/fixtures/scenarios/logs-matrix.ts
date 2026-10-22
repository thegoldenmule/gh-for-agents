// gh/logs/<runner>-fail/ (03 §6.2): one real failed job per test runner, from public repos (the
// sandbox `fail.yml` matrix is deferred, 03 Q2). Each scenario holds the jobs-API row (step list) and
// the raw job log (BOM, timestamps, ANSI, ##[group]/##[error]), captured with the exact argv ghx sends.
import { defineScenario } from '../scenario-api.ts';

const JOBS = [
  {
    dir: 'logs/vitest-fail',
    repo: 'vitest-dev/vitest',
    job: 119784717653,
    note: 'vitest e2e: test/watch/snapshot-review.test.ts > updates accepted snapshots',
  },
  {
    dir: 'logs/jest-fail',
    repo: 'facebook/react',
    job: 119620576517,
    note: 'jest (react www-classic shard 4/5): ReactFlightDOMEdge › can pass a large typed array from two places',
  },
  {
    dir: 'logs/node-test-fail',
    repo: 'nodejs/undici',
    job: 118006467479,
    note: 'node:test spec reporter (windows): Should handle http2 stream timeout (read ECONNRESET)',
  },
  {
    dir: 'logs/pytest-fail',
    repo: 'pytest-dev/pytest',
    job: 118816259139,
    note: 'pytest: TestOverlappingCollectionArguments::test_multiple_file_args_do_not_rescan_parent_directory',
  },
  {
    dir: 'logs/go-fail',
    repo: 'grpc/grpc-go',
    job: 119722003331,
    note: 'go test: Test/BidirectionalDraining_ContinuousStreaming',
  },
] as const;

const get = (path: string) => ['api', '--include', '-X', 'GET', path];

export default defineScenario({
  name: 'logs-matrix',
  description: 'one failed job per runner (vitest, jest, node:test, pytest, go test): jobs-API row and raw log',
  source: 'live:public',
  outDirs: JOBS.map((j) => j.dir),
  record(ctx) {
    for (const j of JOBS) {
      ctx.capture(j.dir, '001-job', get(`repos/${j.repo}/actions/jobs/${j.job}`), { note: `${j.repo} ${j.note}` });
      ctx.capture(j.dir, '002-logs', get(`repos/${j.repo}/actions/jobs/${j.job}/logs`), {
        note: `${j.repo} ${j.note}`,
        stdoutFile: true,
      });
    }
  },
});
