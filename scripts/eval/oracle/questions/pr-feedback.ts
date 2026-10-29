// "What feedback is there on #3301?" World: smoke/pr-feedback (one structured review with two inline findings,
// one addressed and resolved, one open; a human question; a bot comment) plus the gh replies rendered from the
// same PR (oracle/pr-feedback.json). Inline review comments live only behind the REST pulls/N/comments endpoint.
import type { Question } from '../types.ts';

const VIEW_JQ =
  '(.reviews[] | select(.body != "") | "[REVIEW \\(.author.login) \\(.state)] \\(.body)"), (.comments[] | "[\\(.author.login)] \\(.body)")';
const INLINE_JQ =
  '.[] | "[INLINE \\(.user.login) \\(.path):\\(.line // .original_line)\\(if .in_reply_to_id then " reply" else "" end)] \\(.body)"';

export const question: Question = {
  id: 'pr-feedback',
  ask: 'What review feedback is there on PR #3301, and what is still open?',
  world: { repo: 'powerhouse-inc/powerhouse', base: [{ scenario: 'smoke/pr-feedback' }], extras: 'pr-feedback' },
  truth: [
    { id: 'open-inline-finding', kind: 'seen', pattern: /signature not bound/ },
    { id: 'human-question', kind: 'seen', pattern: /Switchboard release/ },
    { id: 'addressed-finding', kind: 'seen', pattern: /Addressed in 9f2c4e1|"status":"addressed"/ },
  ],
  answers: [
    {
      arm: 'ghx',
      source: 'CLAUDE.md block: ghx pr feedback <pr>',
      steps: [{ tool: 'bash', command: 'ghx pr feedback 3301' }],
    },
    {
      arm: 'gh-expert',
      source: 'gh-usage-findings §8(b) verbatim loop: reviews and comments via --json/--jq, inline comments via gh api',
      steps: [
        { tool: 'bash', command: `gh pr view 3301 --json comments,reviews --jq '${VIEW_JQ}'` },
        { tool: 'bash', command: `gh api repos/powerhouse-inc/powerhouse/pulls/3301/comments --jq '${INLINE_JQ}'` },
      ],
    },
    {
      arm: 'gh-typical',
      source: 'gh-usage-findings §8(b): gh pr view --comments, which covers conversation comments and reviews only',
      steps: [{ tool: 'bash', command: 'gh pr view 3301 --comments' }],
    },
  ],
};
