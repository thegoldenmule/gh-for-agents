// gh/logs/no-runner-cancelled/: a job that never got a runner. thegoldenmule/gh-for-agents run
// 40523740737 attempt 1, job `pack-test (macos-latest)`: queued about 15 minutes, then cancelled by
// GitHub with `runner_name: ""`, `runner_id: 0` and `steps: []` (the run concluded `failure`, not
// `cancelled`: nobody cancelled it). Its log does not exist (Azure BlobNotFound 404). A plain rerun
// passed (attempt 2). Job ids are per attempt, so the row stays attempt 1's.
import { defineScenario } from '../scenario-api.ts';

const DIR = 'logs/no-runner-cancelled';
const REPO = 'thegoldenmule/gh-for-agents';
const JOB = 122257509597;
const NOTE = `${REPO} run 40523740737 attempt 1: pack-test (macos-latest) cancelled after 15m queued, no runner`;

const get = (path: string) => ['api', '--include', '-X', 'GET', path];

export default defineScenario({
  name: 'no-runner',
  description:
    'a job GitHub cancelled before any runner picked it up: jobs-API row (no runner, no steps) and its log 404',
  source: 'live:public',
  outDirs: [DIR],
  record(ctx) {
    ctx.capture(DIR, '001-job', get(`repos/${REPO}/actions/jobs/${JOB}`), { note: NOTE });
    ctx.capture(DIR, '002-logs', get(`repos/${REPO}/actions/jobs/${JOB}/logs`), { note: NOTE });
  },
});
