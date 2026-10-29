// "Open a PR for feat/retry-banner." World: smoke/pr-create (octo/demo; feat/retry-banner pushed, no PR yet)
// plus the POST and a read-back that returns what was posted, and the gh pr create replies (oracle/pr-create.json).
import type { Question } from '../types.ts';

const TITLE = 'feat(app): show a banner when a request is retried';
const BODY =
  'Requests retried after a transient failure now show a dismissable banner. Tested with pnpm test (unit, passing).\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)';

/** ghx pr create's own example input (src/commands/pr/create.ts EXAMPLE). */
const PR_JSON = {
  title: TITLE,
  description: 'Requests retried after a transient failure now show a dismissable banner.',
  testing: [{ kind: 'unit', command: 'pnpm test', result: 'pass' }],
  risk: 'low',
  components: ['app'],
  revertPolicy: 'revert-safe',
  base: 'main',
  head: 'feat/retry-banner',
};

export const question: Question = {
  id: 'pr-create',
  ask: 'Open a PR from feat/retry-banner into main (already pushed).',
  world: { repo: 'octo/demo', base: [{ scenario: 'smoke/pr-create' }], extras: 'pr-create' },
  truth: [
    { id: 'pr-created', kind: 'call', pattern: /-X POST .*repos\/octo\/demo\/pulls( |$)|^pr create / },
    { id: 'pr-url', kind: 'seen', pattern: /https:\/\/github\.com\/octo\/demo\/pull\/42/ },
  ],
  answers: [
    {
      arm: 'ghx',
      source: 'CLAUDE.md JSON input: Write the PR object, then ghx pr create --input pr.json',
      steps: [
        { tool: 'write', path: 'pr.json', content: `${JSON.stringify(PR_JSON, null, 2)}\n` },
        { tool: 'bash', command: 'ghx pr create --input pr.json' },
      ],
    },
    {
      arm: 'gh-expert',
      source: 'the body in a file (no shell quoting), then gh pr create --body-file',
      steps: [
        { tool: 'write', path: 'body.md', content: BODY },
        {
          tool: 'bash',
          command: `gh pr create --base main --head feat/retry-banner --title '${TITLE}' --body-file body.md`,
        },
      ],
    },
    {
      arm: 'gh-typical',
      source: 'gh-usage-findings §4.1: --body "$(cat <<\'EOF\' … EOF)" (23 of 72 bodies)',
      steps: [
        {
          tool: 'bash',
          command: `gh pr create --base main --head feat/retry-banner --title "${TITLE}" --body "$(cat <<'EOF'\n${BODY}\nEOF\n)"`,
        },
      ],
    },
  ],
};
