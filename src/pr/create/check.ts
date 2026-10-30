// `pr create` / `pr edit` input checking in one pass (02 §2.1). spec.input accepts any value for the PR
// fields (lenientFields), so the handler sees everything: normalizeInput maps gh names and fixes
// mechanical defects with a warning each; normalizeComponents maps aliases; structureIssues parses each
// field on its own, so one bad field never hides another, and the fields that parsed go on to the rules.
import { z } from 'zod';
import type { Warning } from '../../core/command.ts';
import { type IssueDetail, mapZodIssues } from '../../core/errors.ts';
import { suggest } from '../../core/suggest.ts';
import type { TestingItem } from '../../schemas/pr.ts';
import { resolveComponent } from './components.ts';
import { type CreateRulesConfig, type PartialRulesInput, splitChain, stripFooter } from './rules.ts';
import { MAX_COMPONENTS, MAX_TESTING_ITEMS } from './schema.ts';

/**
 * spec.input fields that take any JSON value (validated by the handler) but keep the strict field's JSON
 * Schema (type, items, description) for help, --schema and flag hints. JSON-only: never flags (02 §0).
 */
export function lenientFields<S extends Record<string, z.ZodType>>(
  shape: S,
): { [K in keyof S]: z.ZodOptional<z.ZodUnknown> } {
  const out: Record<string, z.ZodType> = {};
  for (const [k, s] of Object.entries(shape)) {
    const { $schema: _drop, ...js } = z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as Record<
      string,
      unknown
    >;
    out[k] = z
      .unknown()
      .optional()
      .meta({ ...js, jsonOnly: true });
  }
  return out as { [K in keyof S]: z.ZodOptional<z.ZodUnknown> };
}

/** An example value per field, for "required; e.g." messages and the --example input. */
export const FIELD_EXAMPLES: Readonly<Record<string, unknown>> = {
  title: 'feat(<component>): show a banner when a request is retried',
  description: 'Requests retried after a transient failure now show a dismissable banner.',
  testing: [{ kind: 'unit', command: 'pnpm test', result: 'pass' }],
  risk: 'low',
  revertPolicy: 'revert-safe',
  components: ['<component>'],
  base: 'main',
  head: 'feat/retry-banner',
  kind: 'unit',
  result: 'pass',
  command: 'pnpm test',
  steps: ['Open the settings page', 'Toggle dark mode'],
  riskNote: 'Changes retry timing for every client',
  revertNote: 'Revert together with the migration',
};

const TESTING_ITEM_EXAMPLE = { kind: 'unit', command: 'pnpm test', result: 'pass' };

/** What a required field holds, for the message. */
const FIELD_SHAPES: Readonly<Record<string, string>> = {
  title: "a conventional-commit title 'type(scope): summary', ≤72 chars",
  description: '1–3 plain sentences (no headings, lists or footer)',
  testing: '1–10 items {kind, command, result} (manual: {kind, steps, result})',
  risk: 'one of trivial, low, medium, high',
  revertPolicy: 'one of revert-safe, revert-with-followup, coordinated, forward-fix-only',
  components: 'component names from .github/ghx.json',
  base: 'the branch to merge into',
  head: 'the branch with the change',
  kind: 'one of unit, integration, e2e, typecheck, lint, build, benchmark, manual',
  result: 'one of pass, fail, skipped, not-run',
};

/**
 * Keys agents carry over from gh (and other near misses), with what ghx uses instead. `rename` keys are
 * taken as that field (with a warning) when it is not also given; the others are VALIDATION issues.
 */
const GH_KEYS: Readonly<Record<string, { rename?: string; message: string }>> = {
  body: { rename: 'description', message: "ghx's field for the PR text is 'description' (1–3 plain sentences)" },
  bodyFile: { message: "ghx has no body file; put 1–3 plain sentences in 'description'" },
  body_file: { message: "ghx has no body file; put 1–3 plain sentences in 'description'" },
  summary: { message: "ghx's field for the PR text is 'description' (1–3 plain sentences)" },
  closes: { message: 'closing issues go in refs.closes: {"refs": {"closes": ["#12"]}}' },
  fixes: { message: 'closing issues go in refs.closes: {"refs": {"closes": ["#12"]}}' },
  resolves: { message: 'closing issues go in refs.closes: {"refs": {"closes": ["#12"]}}' },
  related: { message: 'related PRs go in refs.related: {"refs": {"related": ["#12"]}}' },
  stackedOn: { message: 'the parent PR goes in refs.stackedOn (ghx fills it from the base when omitted)' },
  labels: { message: 'ghx does not set labels; remove the key' },
  label: { message: 'ghx does not set labels; remove the key' },
  reviewers: { message: 'ghx does not request reviewers; remove the key' },
  reviewer: { message: 'ghx does not request reviewers; remove the key' },
  assignees: { message: 'ghx does not set assignees; remove the key' },
  assignee: { message: 'ghx does not set assignees; remove the key' },
  milestone: { message: 'ghx does not set a milestone; remove the key' },
  projects: { message: 'ghx does not set projects; remove the key' },
  project: { message: 'ghx does not set projects; remove the key' },
  tests: { message: "ghx's field is 'testing': [{kind, command, result}]" },
  test: { message: "ghx's field is 'testing': [{kind, command, result}]" },
  testPlan: { message: "ghx's field is 'testing': [{kind, command, result}]" },
  component: { message: "ghx's field is 'components': [\"<component>\"]" },
  scope: { message: "the scope goes in the title, 'type(scope): summary', and in components" },
  type: { message: "the type goes in the title, 'type(scope): summary'" },
  revert: { message: "ghx's field is 'revertPolicy'" },
  base_branch: { message: "ghx's field is 'base'" },
  baseBranch: { message: "ghx's field is 'base'" },
  branch: { message: "ghx's field is 'head' (it defaults to the current branch)" },
  headBranch: { message: "ghx's field is 'head' (it defaults to the current branch)" },
};

export interface Normalized {
  value: Record<string, unknown>;
  warnings: Warning[];
  issues: IssueDetail[];
}

const TITLE_SCOPE = /^([^\s():!]+)\(([^()]*)\)(!?: .*)$/s;

/**
 * Key-level and mechanical fixes on a create input or an edit patch. `known` is the keys the command
 * takes; any other key is an issue, with gh's name mapped where ghx has one.
 */
export function normalizeInput(
  raw: Record<string, unknown>,
  config: Pick<CreateRulesConfig, 'render'>,
  known: readonly string[],
): Normalized {
  const warnings: Warning[] = [];
  const issues: IssueDetail[] = [];
  const value: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (known.includes(k)) {
      value[k] = v;
      continue;
    }
    const gh = GH_KEYS[k];
    if (gh?.rename !== undefined && known.includes(gh.rename) && !(gh.rename in raw)) {
      value[gh.rename] = v;
      warnings.push({ code: 'FIELD_RENAMED', message: `Read '${k}' as '${gh.rename}': ${gh.message}.` });
      continue;
    }
    const d: IssueDetail = {
      path: k,
      code: 'unrecognized_keys',
      message: gh !== undefined ? `unknown key '${k}': ${gh.message}` : `unknown key '${k}'`,
    };
    const s = gh?.rename ?? suggest(k, known)[0];
    if (s !== undefined && known.includes(s)) d.suggestion = s;
    issues.push(d);
  }

  if (typeof value.description === 'string') {
    const stripped = stripFooter(value.description, config);
    if (stripped.warning !== null) {
      value.description = stripped.description;
      warnings.push(stripped.warning);
    }
  }

  if (typeof value.title === 'string') {
    const t = value.title.replace(/\s+$/, '');
    // One trailing period, not an ellipsis: "…retried." → "…retried".
    if (/[^.]\.$/.test(t)) {
      value.title = t.slice(0, -1);
      warnings.push({ code: 'TITLE_PERIOD_REMOVED', message: 'Removed the trailing period from the title.' });
    }
  }

  if (Array.isArray(value.testing)) {
    const split = splitTesting(value.testing);
    if (split !== null) {
      value.testing = split.items;
      warnings.push(...split.warnings);
    }
  }
  return { value, warnings, issues };
}

/** A repo-relative directory for cwd (TestingItem's rule), or null. */
const CWD = /^(?!\/)(?!.*\.\.)[\w@./-]+$/;

/** `cd DIR && CMD` → {cwd: DIR, command: CMD}; `a && b` → two items. Null when nothing changes. */
function splitTesting(items: readonly unknown[]): { items: unknown[]; warnings: Warning[] } | null {
  const out: unknown[] = [];
  const warnings: Warning[] = [];
  items.forEach((item, i) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      out.push(item);
      return;
    }
    const t = item as Record<string, unknown>;
    const parts = typeof t.command === 'string' ? splitChain(t.command) : null;
    if (parts === null) {
      out.push(item);
      return;
    }
    let cwd = typeof t.cwd === 'string' ? t.cwd : undefined;
    const cd = /^cd\s+(\S+)$/.exec(parts[0] ?? '');
    let commands = parts;
    if (cd?.[1] !== undefined) {
      const dir = cd[1].replace(/^\.\//, '').replace(/\/+$/, '');
      const joined = cwd === undefined || dir === '.' ? (dir === '.' ? cwd : dir) : `${cwd}/${dir}`;
      if (joined !== undefined && !CWD.test(joined)) {
        out.push(item);
        return;
      }
      cwd = joined;
      commands = parts.slice(1);
    }
    for (const command of commands) out.push({ ...t, command, ...(cwd !== undefined ? { cwd } : {}) });
    const what = [
      cd ? `moved '${cd[0]}' into cwd '${cwd ?? '.'}'` : null,
      commands.length > 1 ? `split ${commands.length} chained commands into separate items` : null,
    ]
      .filter((x) => x !== null)
      .join(' and ');
    warnings.push({
      code: 'TESTING_SPLIT',
      message: `testing[${i}]: ${what} (each keeps kind '${String(t.kind)}' and result '${String(t.result)}'; adjust if they differ).`,
    });
  });
  if (warnings.length === 0 || out.length > MAX_TESTING_ITEMS) return null;
  return { items: out, warnings };
}

/**
 * Aliases → component names in the title scope and `components` (an old name from an existing block
 * included), duplicates dropped, and — when `addScope` — the title scope added to components (or
 * starting it, when components is absent and will be derived from the diff).
 */
export function normalizeComponents(
  value: Record<string, unknown>,
  config: Pick<CreateRulesConfig, 'components'>,
  o: { addScope: boolean },
): Warning[] {
  const warnings: Warning[] = [];
  const aliased: string[] = [];
  let scope: string | null = null;
  if (typeof value.title === 'string') {
    const m = TITLE_SCOPE.exec(value.title);
    if (m?.[2] !== undefined) {
      const canonical = resolveComponent(m[2], config.components);
      if (canonical !== null && canonical !== m[2]) {
        value.title = `${m[1]}(${canonical})${m[3]}`;
        aliased.push(`title scope '${m[2]}' → '${canonical}'`);
      }
      scope = canonical;
    }
  }
  if (Array.isArray(value.components)) {
    const seen = new Set<string>();
    const dupes: string[] = [];
    const list: unknown[] = [];
    for (const c of value.components) {
      if (typeof c !== 'string') {
        list.push(c);
        continue;
      }
      const canonical = resolveComponent(c, config.components) ?? c;
      if (canonical !== c) aliased.push(`'${c}' → '${canonical}'`);
      if (seen.has(canonical)) {
        dupes.push(canonical);
        continue;
      }
      seen.add(canonical);
      list.push(canonical);
    }
    value.components = list;
    if (dupes.length > 0) {
      warnings.push({ code: 'COMPONENTS_DEDUPED', message: `Dropped repeated components: ${dupes.join(', ')}.` });
    }
  }
  if (aliased.length > 0) {
    warnings.push({
      code: 'COMPONENT_ALIAS',
      message: `Mapped aliases to component names from .github/ghx.json: ${aliased.join(', ')}.`,
    });
  }
  if (o.addScope && scope !== null) {
    if (value.components === undefined) {
      value.components = [scope];
    } else if (
      Array.isArray(value.components) &&
      !value.components.includes(scope) &&
      value.components.length < MAX_COMPONENTS
    ) {
      value.components = [scope, ...value.components];
      warnings.push({
        code: 'COMPONENT_FROM_SCOPE',
        message: `Added the title scope '${scope}' to components.`,
      });
    }
  }
  return warnings;
}

/** "required" with the field's shape and an example value. */
function requiredMessage(field: string): string {
  const shape = FIELD_SHAPES[field];
  const example = FIELD_EXAMPLES[field];
  return `missing required field '${field}'${shape ? `: ${shape}` : ''}${example !== undefined ? `; e.g. ${JSON.stringify(example)}` : ''}`;
}

const lastKey = (path: string): string =>
  path
    .replace(/\[\d+\]$/, '')
    .split(/[.[]/)
    .pop() ?? path;

/** zod's messages, rewritten where a gh-shaped input lands: missing fields and a string for a testing item. */
function improve(d: IssueDetail): IssueDetail {
  if (d.code === 'invalid_type' && d.received === 'undefined') {
    return { ...d, message: requiredMessage(lastKey(d.path)) };
  }
  if (d.code === 'invalid_type' && /^testing\[\d+\]$/.test(d.path)) {
    return {
      ...d,
      message: `expected a testing item object, got ${d.received ?? 'another type'}; e.g. ${JSON.stringify(TESTING_ITEM_EXAMPLE)}`,
    };
  }
  return d;
}

export interface Structured {
  /** The fields that parsed, for createRules. */
  parsed: PartialRulesInput & { draft?: boolean; adopt?: boolean };
  /** The original indexes of parsed.testing when only some items parsed. */
  testingAt?: number[];
  issues: IssueDetail[];
}

/**
 * Every field of `value` parsed on its own against `schema`; `required` fields that are absent are
 * issues. Testing items are parsed one by one, so a bad item does not hide the rules on the good ones.
 */
export function structureIssues(
  value: Record<string, unknown>,
  schema: z.ZodObject,
  required: readonly string[],
): Structured {
  const issues: IssueDetail[] = [];
  const parsed: Record<string, unknown> = {};
  let testingAt: number[] | undefined;
  const shape = schema.shape as Record<string, z.ZodType>;
  for (const [k, s] of Object.entries(shape)) {
    const v = value[k];
    if (v === undefined) {
      if (required.includes(k)) {
        issues.push({
          path: k,
          code: 'invalid_type',
          expected: 'nonoptional',
          received: 'undefined',
          message: requiredMessage(k),
        });
      }
      continue;
    }
    const one = z.object({ [k]: s });
    const r = one.safeParse({ [k]: v });
    if (r.success) {
      parsed[k] = (r.data as Record<string, unknown>)[k];
      continue;
    }
    issues.push(
      ...mapZodIssues(r.error, { schema: one, input: { [k]: v }, suggest: (w, c) => suggest(w, c) }).map(improve),
    );
    if (k === 'testing' && Array.isArray(v)) {
      const item = (shape.testing as z.ZodArray<z.ZodType<TestingItem>>).element;
      const good: TestingItem[] = [];
      testingAt = [];
      v.forEach((x, i) => {
        const p = item.safeParse(x);
        if (p.success) {
          good.push(p.data);
          testingAt?.push(i);
        }
      });
      if (good.length > 0) parsed.testing = good;
    }
  }
  return { parsed: parsed as Structured['parsed'], ...(testingAt !== undefined ? { testingAt } : {}), issues };
}
