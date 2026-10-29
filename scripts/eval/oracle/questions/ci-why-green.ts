// "Why is CI failing on #3302?" when it is not (green). World: ci-why/green (#3302, two passing checks).
import type { Question } from '../types.ts';
import { expertChecks } from './ci-why-shared.ts';

export const question: Question = {
  id: 'ci-why-green',
  ask: 'Why is CI failing on PR #3302?',
  world: { repo: 'powerhouse-inc/powerhouse', base: [{ scenario: 'ci-why/green' }], extras: 'ci-why-green' },
  truth: [
    { id: 'all-pass', kind: 'seen', pattern: /"state":"green"|"pass":2\b|\tpass\t[^\n]*\n[^\n]*\tpass\t/ },
    { id: 'no-false-failure', kind: 'not-seen', pattern: /\tfail\t|"failing":\[\{|"fail":[1-9]/ },
  ],
  answers: [
    {
      arm: 'ghx',
      source: 'CLAUDE.md block: ghx ci why <pr>',
      steps: [{ tool: 'bash', command: 'ghx ci why 3302' }],
    },
    {
      arm: 'gh-expert',
      source: 'checks with --json/--jq; nothing failing, so no log fetch',
      steps: [{ tool: 'bash', command: expertChecks(3302) }],
    },
    {
      arm: 'gh-typical',
      source: 'gh-usage-findings §5.1: the checks table first',
      steps: [{ tool: 'bash', command: 'gh pr checks 3302' }],
    },
  ],
};
