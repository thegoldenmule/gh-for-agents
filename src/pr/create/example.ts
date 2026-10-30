// `ghx pr create --example` / `ghx pr edit --example`: a minimal input that validates in THIS repo (its real
// component names), the rules the validator enforces in one screen, and what to run next.
import { z } from 'zod';
import type { CreateRulesConfig } from './rules.ts';
import { DESCRIPTION_MAX_LINES, TITLE_MAX_CODE_POINTS } from './rules.ts';
import { MAX_COMPONENTS, MAX_TESTING_ITEMS } from './schema.ts';

/** Where a pr edit VALIDATION hint sends the caller. */
export const EDIT_EXAMPLE_HINT = 'ghx pr edit --example shows a patch and the rules';

export const ExampleFields = {
  example: z.record(z.string(), z.unknown()).optional().describe('--example: a valid input for this repo'),
  components: z.array(z.string()).optional().describe('--example: the component names in .github/ghx.json'),
  rules: z.array(z.string()).optional().describe('--example: what the validator enforces'),
};

/** The component an example uses: the first with paths (so the diff can confirm it), else the first. */
function exampleComponent(config: Pick<CreateRulesConfig, 'components'>): string | undefined {
  const entries = Object.entries(config.components);
  return (entries.find(([, c]) => c.paths !== undefined) ?? entries[0])?.[0];
}

/** One line per rule group, with this repo's settings (title types, description length, risk floors). */
export function createRulesSummary(config: CreateRulesConfig): string[] {
  const floors = Object.entries(config.components)
    .filter(([, c]) => c.minRisk !== undefined)
    .map(([n, c]) => `${n} ≥ ${c.minRisk}`);
  const aliases = Object.entries(config.components).flatMap(([n, c]) => (c.aliases ?? []).map((a) => `${a} → ${n}`));
  return [
    `title: 'type(scope): summary', ≤${TITLE_MAX_CODE_POINTS} chars, no trailing period; type one of ${config.title.types.join(', ')}; the scope is ${config.title.scopeRequired ? 'required and' : 'optional, and when given'} must be a component name`,
    `description: 1–${DESCRIPTION_MAX_LINES} plain sentences, ≤${config.render.descriptionMaxChars} chars; no headings, lists, tables or footer (ghx renders the footer)`,
    `testing: 1–${MAX_TESTING_ITEMS} items {kind, command, result}; command is one plain command (no &&, |, ;, redirects), its directory goes in cwd; kind manual takes steps instead of a command; a result other than pass needs notes${config.create.requirePassingTest ? '; at least one must pass' : ''}`,
    'risk: trivial|low|medium|high; medium and high need riskNote',
    'revertPolicy: revert-safe|revert-with-followup|forward-fix-only (need revertNote)|coordinated (needs revertWith)',
    `components: up to ${MAX_COMPONENTS} names from .github/ghx.json; ghx adds the ones the diff touches${floors.length > 0 ? `; risk floors: ${floors.join(', ')}` : ''}${aliases.length > 0 ? `; aliases: ${aliases.join(', ')}` : ''}`,
    "optional: base (default branch), head (current branch), draft, refs {closes, related, stackedOn, …} ('#N' or 'owner/repo#N')",
  ];
}

/** A minimal valid `pr create` input for this repo. */
export function createExample(config: CreateRulesConfig): Record<string, unknown> {
  const component = exampleComponent(config);
  const type = config.title.types.includes('feat') ? 'feat' : (config.title.types[0] ?? 'feat');
  return {
    title: `${type}${component !== undefined ? `(${component})` : ''}: show a banner when a request is retried`,
    description: 'Requests retried after a transient failure now show a dismissable banner.',
    testing: [{ kind: 'unit', command: 'pnpm test', result: 'pass' }],
    risk: 'low',
    revertPolicy: 'revert-safe',
    ...(component !== undefined ? { components: [component] } : {}),
  };
}

export function createExampleOutput(config: CreateRulesConfig): {
  example: Record<string, unknown>;
  components: string[];
  rules: string[];
  next: string[];
} {
  return {
    example: createExample(config),
    components: Object.keys(config.components),
    rules: createRulesSummary(config),
    next: ['Write example to pr.json with your file tool, edit it, then run: ghx pr create --input pr.json'],
  };
}

export function editExampleOutput(config: CreateRulesConfig): {
  example: Record<string, unknown>;
  components: string[];
  rules: string[];
  next: string[];
} {
  return {
    example: { description: 'Requests retried after a transient failure now show a banner the user can dismiss.' },
    components: Object.keys(config.components),
    rules: [
      'A patch: only the fields to change, as in pr create (not head); arrays replace',
      '{"draft": false} or {"base": "main"} alone works on any PR, including ones ghx did not open; ghx pr ready <pr> toggles draft',
      'Other fields on a PR without a ghx block need "adopt": true and every pr create field (ghx pr create --example)',
      ...createRulesSummary(config),
    ],
    next: ['Write example to patch.json with your file tool, edit it, then run: ghx pr edit <pr> --input patch.json'],
  };
}
