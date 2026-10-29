// "Why is CI failing on #3301?" while it is still running (in progress). World: smoke/ci-why with Test Reactor
// (shard 1/3) in progress and nothing failed yet.
import type { Question } from '../types.ts';
import { expertChecks } from './ci-why-shared.ts';

export const question: Question = {
  id: 'ci-why-pending',
  ask: 'Why is CI failing on PR #3301?',
  world: {
    repo: 'powerhouse-inc/powerhouse',
    base: [{ scenario: 'smoke/ci-why', skip: ['002-graphql.json'] }],
    extras: 'ci-why-pending',
  },
  truth: [
    {
      id: 'pending-check',
      kind: 'seen',
      pattern:
        /"pending":\[\{"name":"Test Reactor \(shard 1\/3\)"|"name":"Test Reactor \(shard 1\/3\)"[^}]*"bucket":"pending"|Test Reactor \(shard 1\/3\)\tpending|pending\tTest Reactor \(shard 1\/3\)/,
    },
    { id: 'no-false-failure', kind: 'not-seen', pattern: /\tfail\t|"failing":\[\{|"fail":[1-9]/ },
  ],
  answers: [
    {
      arm: 'ghx',
      source: 'CLAUDE.md block: ghx ci why <pr>',
      steps: [{ tool: 'bash', command: 'ghx ci why 3301' }],
    },
    {
      arm: 'gh-expert',
      source: 'checks with --json/--jq; one check pending and none failing, so no log fetch',
      steps: [{ tool: 'bash', command: expertChecks(3301) }],
    },
    {
      arm: 'gh-typical',
      source: 'gh-usage-findings §5.1 verbatim chain: checks, then the log of a run that is still in progress',
      steps: [
        { tool: 'bash', command: 'gh pr checks 3301' },
        { tool: 'bash', command: 'gh run view 37948190914 --log-failed | tail -50' },
      ],
    },
  ],
};
