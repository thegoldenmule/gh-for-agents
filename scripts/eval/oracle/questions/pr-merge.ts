// "Merge #3301." World: smoke/pr-merge (#3301 at 9f2c4e1, mergeable, every check green) plus the merge PUT
// pinned to that head, the merged read-back, and the gh replies before and after (oracle/pr-merge.json).
import type { Question } from '../types.ts';

const HEAD = '9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d';
const READY_JQ =
  '{state, mergeable, mergeStateStatus, reviewDecision, headRefOid, failing: [.statusCheckRollup[] | select(.conclusion == "FAILURE") | .name], pending: [.statusCheckRollup[] | select(.status != "COMPLETED") | .name]}';

export const question: Question = {
  id: 'pr-merge',
  ask: 'Merge PR #3301 (head 9f2c4e1) if it is ready, and confirm it merged.',
  world: { repo: 'powerhouse-inc/powerhouse', base: [{ scenario: 'smoke/pr-merge' }], extras: 'pr-merge' },
  truth: [
    { id: 'merge-sent', kind: 'call', pattern: /-X PUT .*pulls\/3301\/merge|^pr merge 3301\b/ },
    { id: 'merged-confirmed', kind: 'seen', pattern: /"mergeCommit":"d8b62c4|MERGED d8b62c474b/ },
  ],
  answers: [
    {
      arm: 'ghx',
      source: 'ghx pr merge examples[0]: one call, pinned to the head, policy-checked and verified',
      steps: [{ tool: 'bash', command: 'ghx pr merge 3301 --expect-head 9f2c4e1' }],
    },
    {
      arm: 'gh-expert',
      source: 'readiness via --json/--jq, a merge pinned with --match-head-commit, then a read-back',
      steps: [
        {
          tool: 'bash',
          command: `gh pr view 3301 --json state,mergeable,mergeStateStatus,reviewDecision,headRefOid,statusCheckRollup --jq '${READY_JQ}'`,
        },
        { tool: 'bash', command: `gh pr merge 3301 --merge --match-head-commit ${HEAD}` },
        {
          tool: 'bash',
          command: `gh pr view 3301 --json state,mergeCommit --jq '.state + " " + .mergeCommit.oid[0:10]'`,
        },
      ],
    },
    {
      arm: 'gh-typical',
      source: 'gh-usage-findings §5.3, the usual sequence (the sleep before the read-back dropped)',
      steps: [
        { tool: 'bash', command: 'gh pr view 3301 --json state,mergeable,mergeStateStatus,headRefOid,reviewDecision' },
        { tool: 'bash', command: 'gh pr checks 3301' },
        { tool: 'bash', command: 'gh pr merge 3301 --merge 2>&1 | tail -2' },
        {
          tool: 'bash',
          command: `gh pr view 3301 --json state,mergeCommit --jq '.state + " " + .mergeCommit.oid[0:10]'`,
        },
      ],
    },
  ],
};
