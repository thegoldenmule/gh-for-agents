// createRules (02 §2.1): every content rule for a structured PR, reported together.
//
// Pure, with no network. The rules that need GitHub data (changed files, the base's parent PR, whether
// refs exist) are createNetworkRules, which takes that data injected. `pr edit` (02 §3) merges the block
// with its patch and runs both on the merged object.
//
// Issues use core's IssueDetail shape, so `VALIDATION` details look the same as zod's (src/cli/args.ts).
import type { GhxConfig } from '../../config/schema.ts';
import { GhxError, type IssueDetail } from '../../core/errors.ts';
import { suggest } from '../../core/suggest.ts';
import { riskRank } from '../../schemas/pr.ts';
import { matchesGlob } from '../../util/glob.ts';
import { MAX_COMPONENTS, type PrCreateInput } from './schema.ts';

export const TITLE_MAX_CODE_POINTS = 72;
export const DESCRIPTION_MAX_LINES = 3;

/** The config sections the rules read. A full GhxConfig satisfies it. */
export type CreateRulesConfig = Pick<GhxConfig, 'components' | 'title' | 'render' | 'create'>;

export interface CreateRuleContext {
  config: CreateRulesConfig;
  /**
   * The repo's default branch. Only refs.stacked_on_default_base needs it; that rule is skipped while it is
   * unknown (02 §2.6 learns it from the preflight query, after the offline validation step).
   */
  defaultBranch?: string | undefined;
}

/** The fields createRules reads: a create input, or an edit's merged block plus base and head. */
export type CreateRulesInput = Omit<PrCreateInput, 'draft'> & { draft?: boolean | undefined };

export interface Warning {
  code: string;
  message: string;
}

const issue = (path: string, code: string, message: string): IssueDetail => ({ path, code, message });

// ── title ────────────────────────────────────────────────────────────────
// 02 §2.1's format is `^(types)(\(([a-z0-9][a-z0-9-]*)\))?(!)?: \S.*$`. The title is parsed loosely first,
// so that a defect gets its own code (multi_scope, whitespace) instead of a generic title.format.
const TITLE_LOOSE = /^([^\s():!]+)(?:\(([^()]*)\))?(!)?: (\S.*)$/;
const SCOPE = /^[a-z0-9][a-z0-9-]*$/;

function titleRules(input: CreateRulesInput, ctx: CreateRuleContext): IssueDetail[] {
  const out: IssueDetail[] = [];
  const { title } = input;
  const { types, scopeRequired } = ctx.config.title;
  const norm = title.trim().replace(/\s+/g, ' ');
  const m = TITLE_LOOSE.exec(norm);
  const formatIssue = (why: string) =>
    issue('title', 'title.format', `${why}; expected 'type(scope): summary' with type one of ${types.join(', ')}`);

  if (!m) {
    out.push(formatIssue(`'${norm}' is not a conventional-commit title`));
  } else {
    const [, type = '', scope] = m;
    let formatOk = true;
    if (!types.includes(type)) {
      formatOk = false;
      out.push(formatIssue(`type '${type}' is not allowed`));
    } else if (scope?.includes(',')) {
      formatOk = false;
      const parts = scope.split(',').map((s) => s.trim());
      if (parts.every((p) => SCOPE.test(p))) {
        out.push(
          issue(
            'title',
            'title.multi_scope',
            `scope '${scope}' names several components; use one scope and list the rest in components`,
          ),
        );
      } else out.push(formatIssue(`scope '${scope}' is not a lowercase token`));
    } else if (scope !== undefined && !SCOPE.test(scope)) {
      formatOk = false;
      out.push(formatIssue(scope === '' ? 'empty scope ()' : `scope '${scope}' is not a lowercase token`));
    }

    if (formatOk) {
      if (scope === undefined) {
        if (scopeRequired) {
          out.push(issue('title', 'title.scope_missing', 'this repo requires a scope: type(component): summary'));
        }
      } else if (!Object.hasOwn(ctx.config.components, scope)) {
        const known = Object.keys(ctx.config.components);
        const d = issue(
          'title',
          'title.scope_not_component',
          `scope '${scope}' is not a component in .github/ghx.json (${known.join(', ')})`,
        );
        const s = suggest(scope, known)[0];
        if (s !== undefined) d.suggestion = s;
        out.push(d);
      } else if (!input.components.includes(scope)) {
        out.push(issue('title', 'title.scope_not_declared', `scope '${scope}' must also be listed in components`));
      }
      if (type === 'revert' && input.refs?.reverts === undefined) {
        out.push(
          issue('title', 'title.revert_needs_ref', "a revert title needs refs.reverts (the PR it reverts, '#N')"),
        );
      }
    }
  }

  const codePoints = [...title].length;
  if (codePoints > TITLE_MAX_CODE_POINTS) {
    out.push(
      issue(
        'title',
        'title.too_long',
        `${codePoints} code points; at most ${TITLE_MAX_CODE_POINTS}. Shorten the summary`,
      ),
    );
  }
  if (/\s\(#\d+\)$/.test(norm)) {
    out.push(issue('title', 'title.pr_suffix', "remove the ' (#N)' suffix; GitHub adds the PR number on merge"));
  }
  if (title !== norm) {
    out.push(issue('title', 'title.whitespace', 'remove leading, trailing or repeated whitespace'));
  }
  if (norm.endsWith('.')) {
    out.push(issue('title', 'title.trailing_period', 'remove the trailing period'));
  }
  return out;
}

// ── description ──────────────────────────────────────────────────────────
// Markdown block structure the user has corrected agents away from (02 §2.1; 03 §1 row 12: a heading is
// `#` followed by whitespace, so "#3184 merged first" is prose). Checked per line, after leading spaces.
const STRUCTURE: readonly { name: string; re: RegExp }[] = [
  { name: 'a heading', re: /^#{1,6}(?:\s|$)/ },
  { name: 'a heading underline', re: /^(?:=+|-{2,})\s*$/ },
  { name: 'a list marker', re: /^(?:[-*+]|\d+[.)])(?:\s|$)/ },
  { name: 'a blockquote', re: /^>/ },
  { name: 'a table', re: /^\|/ },
  { name: 'a table', re: /^:?-+:?\s*\|/ },
  { name: 'a code fence', re: /^(?:`{3,}|~{3,})/ },
  { name: 'a <details> block', re: /<details\b/i },
  { name: 'an HTML comment', re: /<!--/ },
];

const FOOTER_MARKERS: readonly string[] = ['🤖 Generated with', 'Generated with [Claude Code]'];
/** A hidden ghx block marker. Prose that merely mentions `ghx:` is fine. */
const GHX_MARKER = /<!--\s*ghx:/;

function descriptionRules(input: CreateRulesInput, ctx: CreateRuleContext): IssueDetail[] {
  const out: IssueDetail[] = [];
  const d = input.description;
  const lines = d.split(/\r\n|\r|\n/);
  if (lines.length > DESCRIPTION_MAX_LINES) {
    out.push(
      issue(
        'description',
        'description.lines',
        `${lines.length} lines; at most ${DESCRIPTION_MAX_LINES} (2–3 plain sentences, no sections)`,
      ),
    );
  } else if (lines.some((l) => l.trim() === '')) {
    out.push(
      issue(
        'description',
        'description.lines',
        d.trim() === '' ? 'the description is empty' : 'remove blank lines (and any leading or trailing newline)',
      ),
    );
  }

  const max = ctx.config.render.descriptionMaxChars;
  if (d.length > max) {
    out.push(
      issue('description', 'description.too_long', `${d.length} chars; at most ${max}. Keep it to 2–3 sentences`),
    );
  }

  lines.forEach((line, i) => {
    const t = line.trimStart();
    const hit = STRUCTURE.find((s) => s.re.test(t));
    if (hit) {
      out.push(
        issue(
          'description',
          'description.markdown_structure',
          `line ${i + 1} has ${hit.name}; write plain sentences (ghx renders the trailer and test summary)`,
        ),
      );
    }
  });

  const footer = ctx.config.render.footer?.trim();
  const markers = footer ? [footer, ...FOOTER_MARKERS] : FOOTER_MARKERS;
  const marker = markers.find((f) => d.includes(f)) ?? GHX_MARKER.exec(d)?.[0];
  if (marker !== undefined) {
    out.push(
      issue('description', 'description.footer', `remove '${marker}'; ghx adds the footer and the metadata block`),
    );
  }
  return out;
}

// ── testing ──────────────────────────────────────────────────────────────
/**
 * Top-level directories whose paths belong to one machine: homes, temp dirs, mounts and CI workspaces.
 * Other absolutes are left alone: `/usr/bin/env` is the same everywhere, and `-t /parse/` is a pattern.
 */
const MACHINE_DIRS: ReadonlySet<string> = new Set([
  'Users',
  'home',
  'root',
  'tmp',
  'private',
  'var',
  'Volumes',
  'mnt',
  'media',
  'opt',
  'srv',
  'workspace',
  'workspaces',
  'runner',
  '__w',
]);

/** Paths in a command that only exist on the author's machine: home, temp, drive-letter and machine absolutes. */
export function machinePaths(command: string): string[] {
  const out: string[] = [];
  for (const tok of command.split(/[\s='"(),]+/)) {
    if (tok === '' || tok === '/') continue;
    const home = tok.startsWith('~') || /^\$\{?HOME\b/.test(tok);
    const windows = /^[A-Za-z]:[\\/]/.test(tok) || tok.startsWith('\\\\');
    const absolute = tok.startsWith('/') && MACHINE_DIRS.has(tok.slice(1).split('/')[0] ?? '');
    if (home || windows || absolute) out.push(tok);
  }
  return out;
}

/**
 * Shell operators outside quotes that make a command compound (02 §2.1, §6): `|`, `||`, `;`, `&`, `&&`,
 * `>`, `<`, backticks and `$(`. Single quotes are literal; inside double quotes, backticks and `$(` still
 * substitute. A backslash escapes the next character.
 */
export function compoundOperators(command: string): string[] {
  return scanShell(command).operators;
}

/**
 * The quote still open at the end of the command, or null. An unbalanced quote hides every operator after
 * it from compoundOperators (`--grep don't | tail`), so createRules flags it as testing.compound_command.
 */
export function unclosedQuote(command: string): "'" | '"' | null {
  return scanShell(command).openQuote;
}

function scanShell(command: string): { operators: string[]; openQuote: "'" | '"' | null } {
  const found = new Set<string>();
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '`') found.add('`');
    else if (c === '$' && next === '(') found.add('$(');
    else if (quote === '"') {
      if (c === '"') quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === '|' || c === '&') {
      found.add(next === c ? c + c : c);
      if (next === c) i++;
    } else if (c === ';' || c === '>' || c === '<') found.add(c);
  }
  return { operators: [...found], openQuote: quote };
}

function testingRules(input: CreateRulesInput, ctx: CreateRuleContext): IssueDetail[] {
  const out: IssueDetail[] = [];
  if (ctx.config.create.requirePassingTest && !input.testing.some((t) => t.result === 'pass')) {
    out.push(
      issue(
        'testing',
        'testing.min_pass',
        "at least one testing item must have result 'pass' (create.requirePassingTest)",
      ),
    );
  }
  input.testing.forEach((t, i) => {
    const at = `testing[${i}]`;
    if (t.kind === 'manual') {
      if (t.steps === undefined || t.steps.length === 0) {
        out.push(issue(`${at}.steps`, 'testing.steps_required', 'a manual test needs 1–5 steps a reader can follow'));
      }
    } else if (t.command === undefined) {
      out.push(
        issue(`${at}.command`, 'testing.command_required', `a ${t.kind} test needs the command that runs it, from cwd`),
      );
    }
    if (t.command !== undefined) {
      const paths = machinePaths(t.command);
      if (paths.length > 0) {
        out.push(
          issue(
            `${at}.command`,
            'testing.not_rerunnable',
            `${paths.map((p) => `'${p}'`).join(', ')} only exists on this machine; use a repo-relative path and cwd`,
          ),
        );
      }
      const open = unclosedQuote(t.command);
      if (open !== null) {
        out.push(
          issue(
            `${at}.command`,
            'testing.compound_command',
            `unbalanced quote (${open}): everything after it is hidden from the operator check; quote or escape it (\\${open})`,
          ),
        );
      }
      const ops = compoundOperators(t.command);
      if (open === null && ops.length > 0) {
        out.push(
          issue(
            `${at}.command`,
            'testing.compound_command',
            `unquoted ${ops.map((o) => `'${o}'`).join(', ')}; record the plain command (no pipes, chains or redirects) and put the directory in cwd`,
          ),
        );
      }
    }
    if (t.result !== 'pass' && t.notes === undefined) {
      out.push(issue(`${at}.notes`, 'testing.notes_required', `result '${t.result}' needs notes saying why`));
    }
  });
  return out;
}

// ── risk, revert, components, base, refs ─────────────────────────────────
/** The highest minRisk rank among `names` (-1 when none sets one) and the components that set it. */
function riskFloor(
  names: readonly string[],
  components: CreateRulesConfig['components'],
): { floor: number; setters: string[] } {
  let floor = -1;
  const setters: string[] = [];
  for (const name of names) {
    const minRisk = components[name]?.minRisk;
    if (minRisk === undefined) continue;
    const r = riskRank(minRisk);
    if (r > floor) {
      floor = r;
      setters.length = 0;
    }
    if (r === floor) setters.push(`${name} (${minRisk})`);
  }
  return { floor, setters };
}

function riskRules(input: CreateRulesInput, ctx: CreateRuleContext): IssueDetail[] {
  const out: IssueDetail[] = [];
  if ((input.risk === 'medium' || input.risk === 'high') && input.riskNote === undefined) {
    out.push(
      issue('riskNote', 'risk.note_required', `risk '${input.risk}' needs riskNote: what could break, for whom`),
    );
  }
  const { floor, setters } = riskFloor(input.components, ctx.config.components);
  if (floor > riskRank(input.risk)) {
    out.push(
      issue(
        'risk',
        'risk.below_component_floor',
        `risk '${input.risk}' is below the floor set by ${setters.join(', ')} in .github/ghx.json`,
      ),
    );
  }
  return out;
}

function revertRules(input: CreateRulesInput): IssueDetail[] {
  const out: IssueDetail[] = [];
  const p = input.revertPolicy;
  if ((p === 'revert-with-followup' || p === 'forward-fix-only') && input.revertNote === undefined) {
    out.push(
      issue(
        'revertNote',
        'revert.note_required',
        p === 'forward-fix-only'
          ? 'forward-fix-only needs revertNote: why not revert'
          : `${p} needs revertNote: the extra step`,
      ),
    );
  }
  if (p === 'coordinated' && (input.revertWith === undefined || input.revertWith.length === 0)) {
    out.push(
      issue('revertWith', 'revert.with_required', "coordinated needs revertWith: the PRs to revert together ('#N')"),
    );
  }
  return out;
}

function componentRules(input: CreateRulesInput, ctx: CreateRuleContext): IssueDetail[] {
  const out: IssueDetail[] = [];
  const known = Object.keys(ctx.config.components);
  const seen = new Set<string>();
  input.components.forEach((name, i) => {
    const at = `components[${i}]`;
    if (seen.has(name)) out.push(issue(at, 'components.duplicate', `'${name}' is listed twice`));
    seen.add(name);
    if (!Object.hasOwn(ctx.config.components, name)) {
      // What z.enum(config components) would report (02 §1.5); checked here because spec.input has no config.
      const d: IssueDetail = {
        ...issue(at, 'invalid_value', `unknown component '${name}'; .github/ghx.json declares ${known.join(', ')}`),
        received: name,
      };
      const s = suggest(name, known)[0];
      if (s !== undefined) d.suggestion = s;
      out.push(d);
    }
  });
  return out;
}

function branchRules(input: CreateRulesInput, ctx: CreateRuleContext): IssueDetail[] {
  const out: IssueDetail[] = [];
  if (input.base === input.head) {
    out.push(issue('base', 'base.equals_head', `base and head are both '${input.base}'`));
  }
  if (input.refs?.stackedOn !== undefined && ctx.defaultBranch !== undefined && input.base === ctx.defaultBranch) {
    out.push(
      issue(
        'refs.stackedOn',
        'refs.stacked_on_default_base',
        `a PR based on the default branch '${ctx.defaultBranch}' is not stacked; drop stackedOn or set base to the parent's head`,
      ),
    );
  }
  return out;
}

/** Every offline rule of 02 §2.1, in table order. An empty array means valid. */
export function createRules(input: CreateRulesInput, ctx: CreateRuleContext): IssueDetail[] {
  return [
    ...titleRules(input, ctx),
    ...descriptionRules(input, ctx),
    ...testingRules(input, ctx),
    ...riskRules(input, ctx),
    ...revertRules(input),
    ...componentRules(input, ctx),
    ...branchRules(input, ctx),
  ];
}

// ── network rules (02 §2.1 "Network checks"), with the data injected ─────
export interface CreateNetworkData {
  /** `owner/repo` the PR is opened in, to compare `#N` with `owner/repo#N`. */
  repo: string;
  /** Paths changed between base and head; null when unknown (over 300 files and no local checkout). */
  changedFiles: readonly string[] | null;
  /** The open PR whose head is `input.base` (`#N` or `owner/repo#N`); null when there is none. */
  baseParent: string | null;
  /** Refs, as written in the input (collectRefs), that don't exist. */
  missingRefs: Iterable<string>;
}

export interface NetworkRulesResult {
  issues: IssueDetail[];
  warnings: Warning[];
  /** Touched components past a full `components` list, in config order (06); the block's `alsoTouched`. */
  alsoTouched: string[];
}

/** Every PR or issue ref in the input with its issue path, for the existence lookup. */
export function collectRefs(input: Pick<CreateRulesInput, 'refs' | 'revertWith'>): { path: string; ref: string }[] {
  const out: { path: string; ref: string }[] = [];
  const r = input.refs;
  const one = (key: 'stackedOn' | 'splitFrom' | 'reverts') => {
    const v = r?.[key];
    if (v !== undefined) out.push({ path: `refs.${key}`, ref: v });
  };
  const many = (path: string, list: readonly string[] | undefined) => {
    list?.forEach((ref, i) => {
      out.push({ path: `${path}[${i}]`, ref });
    });
  };
  one('stackedOn');
  many('refs.closes', r?.closes);
  many('refs.related', r?.related);
  one('splitFrom');
  many('refs.supersedes', r?.supersedes);
  one('reverts');
  many('revertWith', input.revertWith);
  return out;
}

/** `#N` or `owner/repo#N` as `owner/repo#N`, lowercased (GitHub names are case-insensitive). */
export function canonicalRef(ref: string, repo: string): string {
  return (ref.startsWith('#') ? `${repo}${ref}` : ref).toLowerCase();
}

/** The components whose config globs match at least one of `files`. Components without `paths` never match. */
export function touchedComponents(
  files: readonly string[],
  components: CreateRulesConfig['components'],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [name, c] of Object.entries(components)) {
    const globs = c.paths;
    if (globs === undefined) continue;
    const hits = files.filter((f) => globs.some((g) => matchesGlob(f, g)));
    if (hits.length > 0) out.set(name, hits);
  }
  return out;
}

/** risk.below_component_floor for the components only ghx recorded: they are not in input.components. */
export function alsoTouchedFloor(
  input: CreateRulesInput,
  config: Pick<CreateRulesConfig, 'components'>,
  names: readonly string[],
): IssueDetail[] {
  const { floor, setters } = riskFloor(names, config.components);
  if (floor <= riskRank(input.risk)) return [];
  return [
    issue(
      'risk',
      'risk.below_component_floor',
      `risk '${input.risk}' is below the floor set by ${setters.join(', ')}, which the PR also touches, in .github/ghx.json`,
    ),
  ];
}

/** The first three names, then a count: bounded however many there are. */
const firstThree = (names: readonly string[]): string =>
  names.slice(0, 3).join(', ') + (names.length > 3 ? `, +${names.length - 3} more` : '');

/**
 * components.undeclared_touched, risk.below_component_floor for alsoTouched, refs.stack_mismatch,
 * refs.not_found; warnings COMPONENTS_UNUSED / _UNCHECKED / _ALSO_TOUCHED.
 */
export function createNetworkRules(
  input: CreateRulesInput,
  config: Pick<CreateRulesConfig, 'components'>,
  data: CreateNetworkData,
): NetworkRulesResult {
  const issues: IssueDetail[] = [];
  const warnings: Warning[] = [];
  let alsoTouched: string[] = [];

  if (data.changedFiles === null) {
    warnings.push({
      code: 'COMPONENTS_UNCHECKED',
      message:
        'Over 300 changed files and no local checkout of the head, so components were not checked against paths.',
    });
  } else {
    const touched = touchedComponents(data.changedFiles, config.components);
    const undeclared = [...touched.keys()].filter((n) => !input.components.includes(n));
    // 06: a diff that touches more components than the list holds fills the list; ghx records the rest.
    const wide = touched.size > MAX_COMPONENTS;
    if (undeclared.length > 0 && wide && input.components.length >= MAX_COMPONENTS) {
      alsoTouched = undeclared;
      warnings.push({
        code: 'COMPONENTS_ALSO_TOUCHED',
        message: `The PR also touches ${undeclared.length} component${undeclared.length === 1 ? '' : 's'} beyond the ${input.components.length} declared; recorded as alsoTouched: ${firstThree(undeclared)}.`,
      });
      issues.push(...alsoTouchedFloor(input, config, undeclared));
    } else if (undeclared.length > 0 && wide) {
      issues.push(
        issue(
          'components',
          'components.undeclared_touched',
          `the PR touches ${touched.size} components, more than components can list (${MAX_COMPONENTS}); declare the ${MAX_COMPONENTS} primary ones and ghx records the rest as alsoTouched (undeclared: ${firstThree(undeclared)})`,
        ),
      );
    } else {
      for (const name of undeclared) {
        const files = touched.get(name) ?? [];
        issues.push(
          issue(
            'components',
            'components.undeclared_touched',
            `the PR changes ${name} (${firstThree(files)}); add '${name}' to components`,
          ),
        );
      }
    }
    const unused = input.components.filter((n) => config.components[n]?.paths !== undefined && !touched.has(n));
    if (unused.length > 0) {
      warnings.push({
        code: 'COMPONENTS_UNUSED',
        message: `No changed path belongs to ${unused.join(', ')}; drop ${unused.length === 1 ? 'it' : 'them'} from components if unrelated.`,
      });
    }
  }

  const stackedOn = input.refs?.stackedOn;
  if (stackedOn !== undefined) {
    if (data.baseParent === null) {
      issues.push(
        issue(
          'refs.stackedOn',
          'refs.stack_mismatch',
          `stackedOn is ${stackedOn}, but no open PR has head '${input.base}'`,
        ),
      );
    } else if (canonicalRef(stackedOn, data.repo) !== canonicalRef(data.baseParent, data.repo)) {
      issues.push(
        issue(
          'refs.stackedOn',
          'refs.stack_mismatch',
          `stackedOn is ${stackedOn}, but the open PR with head '${input.base}' is ${data.baseParent}`,
        ),
      );
    }
  }

  const missing = new Set(data.missingRefs);
  for (const { path, ref } of collectRefs(input)) {
    if (missing.has(ref)) issues.push(issue(path, 'refs.not_found', `${ref} does not exist`));
  }
  return { issues, warnings, alsoTouched };
}

/** The `VALIDATION` error for a non-empty issue list, shaped like validateInput's (src/cli/args.ts). */
export function validationError(issues: readonly IssueDetail[]): GhxError {
  const first = issues.find((i) => i.suggestion !== undefined) ?? issues[0];
  const hint = first
    ? `${first.path || 'input'}: ${first.message}${first.suggestion ? ` (did you mean '${first.suggestion}'?)` : ''}`
    : undefined;
  return new GhxError('VALIDATION', `${issues.length} input issue${issues.length === 1 ? '' : 's'}.`, {
    hint,
    details: { issues: [...issues] },
  });
}

/** Throws `VALIDATION` with every issue when there are any. */
export function assertNoIssues(issues: readonly IssueDetail[]): void {
  if (issues.length > 0) throw validationError(issues);
}
