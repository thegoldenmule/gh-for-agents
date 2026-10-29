// "Rerun the flaky job on #3301." World: smoke/ci-rerun (#3301, run 37948190914: Test Reactor (shard 1/3)
// failed on ECONNRESET) with lint failing on a real eslint error in the same run, so a correct answer reruns the
// flaky job and leaves the real failure alone (oracle/ci-rerun.json).
import type { Question } from '../types.ts';

const STRIP = "sed 's/\\x1b\\[[0-9;]*m//g'";

export const question: Question = {
  id: 'ci-rerun',
  ask: 'CI on PR #3301 failed. Rerun the job that failed for flaky reasons, not the real failure.',
  world: {
    repo: 'powerhouse-inc/powerhouse',
    base: [{ scenario: 'smoke/ci-rerun', skip: ['002-graphql.json'] }],
    extras: 'ci-rerun',
  },
  truth: [
    { id: 'flake-reason', kind: 'seen', pattern: /ECONNRESET/ },
    {
      id: 'flaky-job-rerun',
      kind: 'call',
      pattern: /actions\/jobs\/111978835495\/rerun|^run rerun --job 111978835495$|^run rerun 37948190914 --failed/,
    },
    {
      id: 'real-failure-not-rerun',
      kind: 'no-call',
      pattern: /^run rerun (37948190914|--job 111978835496)|rerun-failed-jobs|actions\/jobs\/111978835496\/rerun/,
    },
  ],
  answers: [
    {
      arm: 'ghx',
      source: 'CLAUDE.md exit-code table and ghx ci rerun examples[0]: ghx ci rerun <pr> --flaky',
      steps: [{ tool: 'bash', command: 'ghx ci rerun 3301 --flaky' }],
    },
    {
      arm: 'gh-expert',
      source: 'failing checks via --json/--jq, both failed logs in one loop, then a single-job rerun',
      steps: [
        {
          tool: 'bash',
          command: `gh pr checks 3301 --json name,bucket,link --jq '.[] | select(.bucket == "fail") | [.name, .link] | @tsv'`,
        },
        {
          tool: 'bash',
          command: `for j in 111978835495 111978835496; do echo "== $j"; gh run view --job $j --log-failed | ${STRIP} | grep -E 'Error|error|ECONN|FAIL|✖' | head -10; done`,
        },
        { tool: 'bash', command: 'gh run rerun --job 111978835495' },
      ],
    },
    {
      arm: 'gh-typical',
      source: 'gh-usage-findings §5.4: checks, the failed log, then the verbatim guarded rerun loop',
      steps: [
        { tool: 'bash', command: 'gh pr checks 3301' },
        { tool: 'bash', command: 'gh run view 37948190914 --log-failed | tail -50' },
        {
          tool: 'bash',
          command: `for r in $(gh pr checks 3301 --json bucket,link --jq '.[]|select(.bucket=="fail")|.link' | sed -E 's#.*/runs/([0-9]+)/.*#\\1#' | sort -u); do st=$(gh run view $r --json status --jq .status); [ "$st" = completed ] && gh run rerun $r --failed; done`,
        },
      ],
    },
  ],
};
