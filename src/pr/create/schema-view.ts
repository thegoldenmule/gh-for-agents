// `ghx schema pr create` (and `--schema`): a compact input schema with `required` first, the rules the
// validator enforces, and — in a repo with .github/ghx.json — its component names and a valid example.
// The derived JSON Schema (single and batch shapes, ~12.5k chars) stays in `ghx schema --all`.
import { defaultConfig, type GhxConfig } from '../../config/schema.ts';
import { RevertPolicy, Risk, TestingKind, TestingResult } from '../../schemas/pr.ts';
import { createExample, createRulesSummary } from './example.ts';
import { TITLE_MAX_CODE_POINTS } from './rules.ts';
import { MAX_COMPONENTS, MAX_TESTING_ITEMS } from './schema.ts';

const REF = { type: 'string' };

/** Types and limits only; `rules` says what each field must hold. */
function inputView(config: GhxConfig): Record<string, unknown> {
  const str = { type: 'string' };
  const refs = { type: 'array', items: REF };
  return {
    type: 'object',
    required: ['title', 'description', 'testing', 'risk', 'revertPolicy'],
    additionalProperties: false,
    properties: {
      title: { type: 'string', maxLength: TITLE_MAX_CODE_POINTS },
      description: { type: 'string', maxLength: config.render.descriptionMaxChars },
      testing: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_TESTING_ITEMS,
        items: {
          type: 'object',
          required: ['kind', 'result'],
          properties: {
            kind: { enum: TestingKind.options },
            command: str,
            cwd: str,
            steps: { type: 'array', items: str, maxItems: 5 },
            result: { enum: TestingResult.options },
            notes: str,
          },
        },
      },
      risk: { enum: Risk.options },
      riskNote: str,
      revertPolicy: { enum: RevertPolicy.options },
      revertNote: str,
      revertWith: refs,
      components: { type: 'array', items: str, maxItems: MAX_COMPONENTS },
      base: str,
      head: str,
      draft: { type: 'boolean' },
      refs: {
        type: 'object',
        properties: { closes: refs, related: refs, stackedOn: REF, splitFrom: REF, supersedes: refs, reverts: REF },
      },
    },
  };
}

const OUTPUT = {
  ref: 'owner/repo#N',
  number: 'integer',
  url: 'string',
  title: 'string',
  base: 'string',
  head: '{ref, sha}',
  draft: 'boolean',
  draftDerived: 'boolean',
  stackedOn: 'owner/repo#N | null',
  blockId: 'string',
  body: 'string',
  next: 'string[]',
  warnings: '[{code, message}]',
};

/** The schema view; `config` is the cwd repo's .github/ghx.json, when one was found. */
export function createSchemaView(config: GhxConfig | undefined): Record<string, unknown> {
  const c = config ?? defaultConfig();
  const names = config === undefined ? null : Object.keys(config.components);
  return {
    input: inputView(c),
    rules: createRulesSummary(c),
    ...(names !== null ? { components: names } : {}),
    example: createExample(c),
    batch:
      '--batch takes {defaults, items[]}: partial PRs merged item over defaults (ghx schema --all has the full schema)',
    output: OUTPUT,
  };
}
