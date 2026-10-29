// "Wait for CI on #3301 and tell me how it ends." World: smoke/ci-wait (#3301 at 9f2c4e1: Typecheck and Test,
// both green) plus gh replies that move from pending to green across successive polls (oracle/ci-wait.json).
// ghx ci wait sees CI settled on its first poll; real waits poll for minutes (see the report's caveats).
import type { Question } from '../types.ts';
import { EXPERT_CHECKS_JQ } from './ci-why-shared.ts';

export const question: Question = {
  id: 'ci-wait',
  ask: 'Wait for CI on PR #3301 to finish and report the outcome.',
  world: { repo: 'powerhouse-inc/powerhouse', base: [{ scenario: 'smoke/ci-wait' }], extras: 'ci-wait' },
  truth: [
    { id: 'settled-green', kind: 'seen', pattern: /"outcome":"green"|"pass":2\b|\tpass\t[^\n]*\n[^\n]*\tpass\t/ },
    { id: 'no-false-failure', kind: 'not-seen', pattern: /\tfail\t|"fail":[1-9]|"outcome":"red"/ },
  ],
  answers: [
    {
      arm: 'ghx',
      source: 'CLAUDE.md "Waiting for CI": ghx ci wait <pr> with run_in_background, then read the output on wake',
      steps: [
        { tool: 'bash-background', command: 'ghx ci wait 3301', task: 'wait' },
        { tool: 'read-output', task: 'wait' },
      ],
    },
    {
      arm: 'gh-expert',
      source: 'gh pr checks --watch in the background (its tables discarded), then one --json/--jq summary',
      steps: [
        {
          tool: 'bash-background',
          command: `gh pr checks 3301 --watch --fail-fast --interval 30 >/dev/null 2>&1; gh pr checks 3301 --json name,bucket,link --jq '${EXPERT_CHECKS_JQ}'`,
          task: 'watch',
        },
        { tool: 'read-output', task: 'watch' },
      ],
    },
    {
      arm: 'gh-typical',
      source: 'gh-usage-findings §5.2: sleep-and-poll on gh pr checks (median 3 polls per PR), sleeps removed',
      steps: [
        { tool: 'bash', command: 'gh pr checks 3301' },
        { tool: 'bash', command: 'gh pr checks 3301' },
        { tool: 'bash', command: 'gh pr checks 3301' },
      ],
    },
  ],
};
