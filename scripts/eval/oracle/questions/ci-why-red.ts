// "Why is CI failing on #3301?" (red). World: smoke/ci-why (#3301: Test Reactor (shard 1/3) fails), with that
// job's log swapped for the public vitest e2e log so every arm reads the same, realistically sized log.
import type { Question } from '../types.ts';
import { expertChecks } from './ci-why-shared.ts';

export const question: Question = {
  id: 'ci-why-red',
  ask: 'Why is CI failing on PR #3301?',
  world: {
    repo: 'powerhouse-inc/powerhouse',
    base: [
      {
        scenario: 'smoke/ci-why',
        skip: ['003-actions-jobs-111978835495.json', '004-actions-jobs-111978835495-logs.json'],
      },
    ],
    extras: 'ci-why-red',
  },
  truth: [
    {
      id: 'failing-job',
      kind: 'seen',
      pattern:
        /"name":"Test Reactor \(shard 1\/3\)"[^}]*"bucket":"fail"|"job":"Test Reactor \(shard 1\/3\)"|Test Reactor \(shard 1\/3\)\tfail|fail\tTest Reactor \(shard 1\/3\)/,
    },
    { id: 'failing-test', kind: 'seen', pattern: /snapshot-review\.test\.ts[^\n]*updates accepted snapshots/ },
    { id: 'error', kind: 'seen', pattern: /Snapshot `updates accepted snapshots > review-\d+-47 1` mismatched/ },
  ],
  answers: [
    {
      arm: 'ghx',
      source: 'CLAUDE.md block: ghx ci why <pr>',
      steps: [{ tool: 'bash', command: 'ghx ci why 3301' }],
    },
    {
      arm: 'gh-expert',
      source: 'checks with --json/--jq, then only the failing job log, ANSI stripped and grepped',
      steps: [
        { tool: 'bash', command: expertChecks(3301) },
        {
          tool: 'bash',
          command:
            "gh run view --job 111978835495 --log-failed | sed 's/\\x1b\\[[0-9;]*m//g' | grep -E ' FAIL |Error|×' | head -40",
        },
      ],
    },
    {
      arm: 'gh-typical',
      source:
        'gh-usage-findings §5.1 and §5.4: checks table, run summary, failed log through tail, then main to compare',
      steps: [
        { tool: 'bash', command: 'gh pr checks 3301' },
        { tool: 'bash', command: 'gh run view 37948190914' },
        { tool: 'bash', command: 'gh run view 37948190914 --log-failed | tail -50' },
        { tool: 'bash', command: 'gh run list --branch main --workflow ci.yml --limit 5' },
      ],
    },
  ],
};
