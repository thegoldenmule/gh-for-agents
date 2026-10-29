// "Is main red, and why?" World: smoke/ci-why's main (head 4b1e7d2: CI fails on Test Reactor (shard 1/3), the
// reactor-api test; Docs passes) plus the branch, runs and gh porcelain replies (oracle/main-health.json).
import type { Question } from '../types.ts';

export const question: Question = {
  id: 'main-health',
  ask: 'Is main green? If not, what is failing?',
  world: { repo: 'powerhouse-inc/powerhouse', base: [{ scenario: 'smoke/ci-why' }], extras: 'main-health' },
  truth: [
    {
      id: 'main-red',
      kind: 'seen',
      pattern: /"target":"branch:main@4b1e7d2"[^\n]*"state":"red"|CI\tfailure\t4b1e7d2|\tfailure\t[^\t\n]*\tCI\tmain\t/,
    },
    { id: 'failing-job', kind: 'seen', pattern: /Test Reactor \(shard 1\/3\)/ },
    { id: 'failing-test', kind: 'seen', pattern: /reactor-api\.test\.ts > should converge after reshuffle/ },
  ],
  answers: [
    {
      arm: 'ghx',
      source: 'ghx ci why examples: ghx ci why branch:main',
      steps: [{ tool: 'bash', command: 'ghx ci why branch:main' }],
    },
    {
      arm: 'gh-expert',
      source: 'recent main runs with --json/--jq, then the failing run log, ANSI stripped and grepped',
      steps: [
        {
          tool: 'bash',
          command:
            "gh run list --branch main --event push --limit 10 --json databaseId,workflowName,headSha,conclusion --jq '.[] | [.workflowName, .conclusion, .headSha[0:7], .databaseId] | @tsv'",
        },
        {
          tool: 'bash',
          command:
            "gh run view 37940000001 --log-failed | sed 's/\\x1b\\[[0-9;]*m//g' | grep -E ' FAIL |Error|×' | head -40",
        },
      ],
    },
    {
      arm: 'gh-typical',
      source: 'gh-usage-findings §5.4 (128 run list --branch main): list, run summary, failed log through tail',
      steps: [
        { tool: 'bash', command: 'gh run list --branch main --limit 5' },
        { tool: 'bash', command: 'gh run view 37940000001' },
        { tool: 'bash', command: 'gh run view 37940000001 --log-failed | tail -50' },
      ],
    },
  ],
};
