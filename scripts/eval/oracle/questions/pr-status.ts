// "What's the state of PR #3301, and is CI passing?" World: smoke/pr-status (#3301 open, mergeable, one
// failing check of 25) plus the gh porcelain replies rendered from the same PR (oracle/pr-status.json).
import type { Question } from '../types.ts';

const FAILING = 'Test Reactor \\(shard 1\\/3\\)';

export const question: Question = {
  id: 'pr-status',
  ask: 'What is the state of PR #3301, can it merge, and is CI passing?',
  world: { repo: 'powerhouse-inc/powerhouse', base: [{ scenario: 'smoke/pr-status' }], extras: 'pr-status' },
  truth: [
    { id: 'state-open', kind: 'seen', pattern: /\bOPEN\b/ },
    { id: 'mergeable', kind: 'seen', pattern: /\bMERGEABLE\b/ },
    {
      id: 'failing-check',
      kind: 'seen',
      pattern: new RegExp(`"failing":\\[\\{?("name":)?"${FAILING}"|${FAILING}\\tfail`),
    },
  ],
  answers: [
    {
      arm: 'ghx',
      source: 'CLAUDE.md block: ghx pr status <pr>',
      steps: [{ tool: 'bash', command: 'ghx pr status 3301' }],
    },
    {
      arm: 'gh-expert',
      source: 'one gh pr view with --json and --jq over the merge and check fields',
      steps: [
        {
          tool: 'bash',
          command:
            'gh pr view 3301 --json state,mergeable,mergeStateStatus,reviewDecision,headRefOid,statusCheckRollup --jq \'{state, mergeable, mergeStateStatus, reviewDecision, headRefOid, failing: [.statusCheckRollup[] | select(.conclusion == "FAILURE") | .name], pending: [.statusCheckRollup[] | select(.status != "COMPLETED") | .name]}\'',
        },
      ],
    },
    {
      arm: 'gh-typical',
      source:
        'gh-usage-findings §8(b): the description, then the checks table (106 of 308 pairs read only the description)',
      steps: [
        { tool: 'bash', command: 'gh pr view 3301' },
        { tool: 'bash', command: 'gh pr checks 3301' },
      ],
    },
  ],
};
