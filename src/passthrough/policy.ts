// Passthrough policy (02 §10, 03 M7.1): allowlisted gh reads run in a bounded JSON envelope, wrapped
// commands are refused with the replacement argv, other writes are refused, the rest is unknown.
// Pure: decide() looks at argv only. The read guard (src/gh/guard.ts) stays the backstop: 'run' is
// returned only when isReadAllowed() accepts the exact argv that will execute. The guard is wider on
// purpose (pr view, pr checks, run view --log, auth status, graphql queries are reads ghx makes).
//
// The wrapped table is static, not derived from the specs' `replaces`: `ci wait` lists `gh run list`,
// which 02 §10 allowlists, and several wrapped targets land in parallel waves.

import type { GlobalOptions } from '../cli/args.ts';
import { GhxError } from '../core/errors.ts';
import { apiShape, isReadAllowed } from '../gh/guard.ts';
import { mapGhFields } from './gh-fields.ts';

/** 02 §10's allowlisted reads (besides `api`, which is checked by shape). */
export const ALLOWED_READS: Readonly<Record<string, readonly string[]>> = {
  pr: ['diff', 'list'],
  issue: ['view', 'list'],
  search: ['issues', 'prs', 'code', 'repos', 'commits'],
  release: ['list', 'view'],
  repo: ['view'],
  workflow: ['list', 'view'],
  run: ['list', 'view', 'download'],
  label: ['list'],
};

/** Every allowlisted read as "group verb", plus "api", for suggestions and docs. */
export const ALLOWED_NAMES: readonly string[] = [
  ...Object.entries(ALLOWED_READS).flatMap(([g, subs]) => subs.map((s) => `${g} ${s}`)),
  'api',
];

/** gh's built-in verb aliases (gh 2.86 `ALIASES` sections), canonicalised before any decision. */
const VERB_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  pr: { ls: 'list', new: 'create', co: 'checkout' },
  issue: { ls: 'list', new: 'create' },
  run: { ls: 'list' },
  workflow: { ls: 'list' },
  release: { ls: 'list', new: 'create' },
  repo: { ls: 'list', new: 'create' },
  label: { ls: 'list' },
  gist: { ls: 'list', new: 'create' },
  cache: { ls: 'list' },
  secret: { ls: 'list' },
  variable: { ls: 'list' },
  codespace: { ls: 'list' },
};

/** Top-level aliases: `gh co` is `gh pr checkout`, `gh cs` is `gh codespace`. */
const TOP_ALIASES: Readonly<Record<string, readonly string[]>> = { co: ['pr', 'checkout'], cs: ['codespace'] };

/**
 * gh subcommands that change GitHub, local git or gh's own state (gh 2.86 command tree). Wrapped
 * commands are matched first, so `pr create` etc. never reach this table. A verb that is neither
 * allowlisted nor listed here (gist list, auth token, org list, …) is an unknown command.
 */
const WRITES: Readonly<Record<string, readonly string[]>> = {
  pr: ['checkout', 'lock', 'unlock', 'revert', 'update-branch'],
  issue: [
    'create',
    'close',
    'comment',
    'delete',
    'develop',
    'edit',
    'lock',
    'pin',
    'reopen',
    'transfer',
    'unlock',
    'unpin',
  ],
  run: ['cancel', 'delete'],
  workflow: ['disable', 'enable', 'run'],
  release: ['create', 'delete', 'delete-asset', 'edit', 'upload'],
  repo: [
    'create',
    'archive',
    'clone',
    'delete',
    'edit',
    'fork',
    'rename',
    'set-default',
    'sync',
    'unarchive',
    'autolink create',
    'autolink delete',
    'deploy-key add',
    'deploy-key delete',
  ],
  label: ['clone', 'create', 'delete', 'edit'],
  gist: ['clone', 'create', 'delete', 'edit', 'rename'],
  secret: ['delete', 'set'],
  variable: ['delete', 'set'],
  cache: ['delete'],
  auth: ['login', 'logout', 'refresh', 'setup-git', 'switch'],
  config: ['clear-cache', 'set'],
  extension: ['create', 'exec', 'install', 'remove', 'upgrade'],
  alias: ['delete', 'import', 'set'],
  codespace: ['code', 'cp', 'create', 'delete', 'edit', 'jupyter', 'ports', 'rebuild', 'ssh', 'stop'],
  project: [
    'close',
    'copy',
    'create',
    'delete',
    'edit',
    'field-create',
    'field-delete',
    'item-add',
    'item-archive',
    'item-create',
    'item-delete',
    'item-edit',
    'link',
    'mark-template',
    'unlink',
  ],
  'ssh-key': ['add', 'delete'],
  'gpg-key': ['add', 'delete'],
  'agent-task': ['create'],
};

/** gh's read verbs that are not allowlisted (gh 2.86), so "not allowlisted" differs from "no such command". */
const OTHER_READS: Readonly<Record<string, readonly string[]>> = {
  pr: ['status'],
  issue: ['status'],
  release: ['download', 'verify', 'verify-asset'],
  repo: ['list', 'gitignore', 'license', 'autolink', 'deploy-key'],
  gist: ['list', 'view'],
  secret: ['list'],
  variable: ['get', 'list'],
  cache: ['list'],
  auth: ['status', 'token'],
  config: ['get', 'list'],
  extension: ['browse', 'list', 'search'],
  alias: ['list'],
  codespace: ['list', 'logs', 'view'],
  project: ['field-list', 'item-list', 'list', 'view'],
  org: ['list'],
  ruleset: ['check', 'list', 'view'],
  'ssh-key': ['list'],
  'gpg-key': ['list'],
  attestation: ['download', 'trusted-root', 'verify'],
  'agent-task': ['list', 'view'],
};

/** gh top-level commands without verbs. */
const GH_LEAVES = new Set(['browse', 'completion', 'copilot', 'preview', 'status']);

/**
 * Flags across gh's commands that take a value, so their value is not mistaken for the selector when
 * a refusal builds the replacement argv. A miss only makes the suggested selector wrong, never runs gh.
 */
const VALUE_FLAGS = new Set([
  '--json',
  '-q',
  '--jq',
  '-t',
  '--template',
  '--title',
  '-b',
  '--body',
  '-F',
  '--body-file',
  '-B',
  '--base',
  '-H',
  '--head',
  '-l',
  '--label',
  '--assignee',
  '--milestone',
  '--reviewer',
  '-p',
  '--project',
  '--subject',
  '--match-head-commit',
  '--author-email',
  '-j',
  '--job',
  '--attempt',
  '-i',
  '--interval',
  '--color',
  '-L',
  '--limit',
  '-S',
  '--search',
  '--state',
  '-A',
  '--author',
  '-n',
  '--name',
  '-D',
  '--dir',
  '--workflow',
  '-u',
  '--user',
  '--commit',
  '--event',
  '--branch',
  '--add-label',
  '--remove-label',
  '--add-reviewer',
  '--remove-reviewer',
  '--add-assignee',
  '--remove-assignee',
]);

/** What the passthrough handler runs (validated again as the synthetic spec's input). */
export interface PassthroughPlan {
  /** The synthetic command name: ['pr', 'diff'], ['api']. */
  name: string[];
  /** gh argv without the leading 'gh' and without any -R (injected by the handler). */
  args: string[];
  /** How the resolved repo is passed: -R flag, positional (repo view), endpoint placeholders (api), or not at all (search). */
  inject: 'flag' | 'positional' | 'placeholders' | 'none';
  /** --max-bytes, so the inline cap fits the caller's bound. */
  maxBytes?: number;
  /** --fields was given: parsed JSON stays inline at any size, since the projection runs before the bound. */
  projected?: boolean;
}

export type Decision =
  | { kind: 'run'; plan: PassthroughPlan; globals: Partial<GlobalOptions> }
  /** `wrapped` names the wrapped gh command ('pr merge') when the refusal is one; the hook reads it. */
  | { kind: 'refuse'; error: GhxError; wrapped?: string }
  /** Not a gh command passthrough knows; `ghKnown` is true for a real gh command that is not allowlisted. */
  | { kind: 'unknown'; words: string[]; ghKnown: boolean };

interface Globals {
  rest: string[];
  globals: Partial<GlobalOptions>;
  maxBytes?: number;
}

/**
 * Take ghx's own output flags (--pretty, --max-bytes N, --timeout D, --fields P, --brief) out of the gh
 * argv, up to a bare `--` (after it every token is gh's). gh has no --fields or --brief flag (2.x), so
 * neither is ever forwarded: the runner projects the envelope (--fields passthrough.json[].headSha) or
 * refuses --brief, before gh runs.
 */
function takeGhxGlobals(tokens: readonly string[]): Globals {
  const rest: string[] = [];
  const globals: Partial<GlobalOptions> = {};
  let maxBytes: number | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    if (t === '--') {
      rest.push(...tokens.slice(i));
      break;
    }
    if (t === '--pretty') {
      globals.pretty = true;
      continue;
    }
    if (t === '--brief') {
      globals.brief = true;
      continue;
    }
    const f = /^--fields(?:=(.*))?$/.exec(t);
    if (f) {
      // A missing value is an empty path list: parseFields makes it VALIDATION.
      const value = f[1] ?? tokens[++i] ?? '';
      globals.fields = [...(globals.fields ?? []), value];
      continue;
    }
    const m = /^--(max-bytes|timeout)(?:=(.*))?$/.exec(t);
    if (m) {
      const value = m[2] ?? tokens[i + 1];
      const ok = m[1] === 'max-bytes' ? /^\d+$/.test(value ?? '') : /^\d+(ms|s|m|h)?$/.test(value ?? '');
      if (ok && value !== undefined) {
        if (m[2] === undefined) i++;
        if (m[1] === 'max-bytes') {
          globals.maxBytes = value;
          maxBytes = Number(value);
        } else {
          globals.timeout = value;
        }
        continue;
      }
    }
    rest.push(t);
  }
  return { rest, globals, ...(maxBytes !== undefined ? { maxBytes } : {}) };
}

/** Take -R/--repo (every pflag spelling) out of a non-api argv; the last one wins, like pflag. */
export function takeRepoFlag(args: readonly string[]): { rest: string[]; repo?: string } {
  const rest: string[] = [];
  let repo: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const t = args[i] as string;
    if (t === '--') {
      rest.push(...args.slice(i));
      break;
    }
    if (t === '-R' || t === '--repo') {
      const v = args[i + 1];
      if (v !== undefined) {
        repo = v;
        i++;
        continue;
      }
    } else if (t.startsWith('--repo=')) {
      repo = t.slice('--repo='.length);
      continue;
    } else if (t.startsWith('-R') && t.length > 2) {
      repo = t.slice(t[2] === '=' ? 3 : 2);
      continue;
    }
    rest.push(t);
  }
  return repo !== undefined ? { rest, repo } : { rest };
}

/**
 * gh takes -R/--repo anywhere, including before the command words (`gh -R o/r pr merge 1`). Move every
 * spelling of it behind the command words (before any --), so classifying never sees a leading flag. api
 * and search keep it where gh reads it: api refuses -R, and search's -R is a filter.
 */
export function normalizeGhArgv(args: readonly string[]): string[] {
  const lead: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const t = args[i] as string;
    if ((t === '-R' || t === '--repo') && args[i + 1] !== undefined) {
      lead.push(t, args[i + 1] as string);
      i++;
    } else if (t.startsWith('--repo=') || (t.startsWith('-R') && t.length > 2)) {
      lead.push(t);
    } else {
      break;
    }
  }
  const top = args[i];
  if (top === undefined) return [...args];
  const rest = args.slice(i + 1);
  if (top === 'api') return [top, ...lead, ...rest];
  if (top === 'search') return rest.length > 0 ? [top, rest[0] as string, ...lead, ...rest.slice(1)] : [...args];
  const taken = takeRepoFlag([...lead, ...rest]);
  if (taken.repo === undefined) return [top, ...taken.rest];
  const dd = taken.rest.indexOf('--');
  const words = dd === -1 ? taken.rest : taken.rest.slice(0, dd);
  const tail = dd === -1 ? [] : taken.rest.slice(dd);
  return [top, ...words, '-R', taken.repo, ...tail];
}

/** gh writes ghx wraps with a validated command: the hook denies them in every mode (hooks.md). */
export const WRAPPED_WRITES: ReadonlySet<string> = new Set([
  'pr create',
  'pr edit',
  'pr ready',
  'pr merge',
  'pr comment',
  'pr review',
  'pr close',
  'run rerun',
]);

/** The first positional of a verb's argv (after the verb), skipping flag values. */
export function firstPositional(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const t = args[i] as string;
    if (t === '--') return args[i + 1];
    if (t.startsWith('-')) {
      if (!t.includes('=') && VALUE_FLAGS.has(t)) i++;
      continue;
    }
    return t;
  }
  return undefined;
}

const has = (args: readonly string[], ...flags: string[]): boolean =>
  args.some((a) => flags.some((f) => a === f || a.startsWith(`${f}=`)));

/** The replacement argv for a wrapped command, plus a one-line hint, or undefined if not wrapped. */
interface Wrapped {
  suggestion: string[];
  hint: string;
  alternatives?: string[][];
  /** The refusal's message, when "'ghx <top> <sub>' is not a ghx command." is untrue (run view is passed through without --log). */
  message?: string;
}

/** A value flag's value (`--json a,b` or `--json=a,b`), before any `--`. */
function flagArg(args: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const t = args[i] as string;
    if (t === '--') return undefined;
    if (t.startsWith(`${flag}=`)) return t.slice(flag.length + 1);
    if (t === flag) return args[i + 1];
  }
  return undefined;
}

function wrapped(top: string, sub: string, args: readonly string[], repo: string | undefined): Wrapped | undefined {
  const sel = firstPositional(args);
  const pr = sel ?? '<pr>';
  const R = repo !== undefined ? ['-R', repo] : [];
  const prCmd = (...rest: string[]): string[] => ['ghx', ...rest.slice(0, 2), pr, ...rest.slice(2), ...R];
  // gh run <verb> <run-id>: ghx's run:<id> target, with the id the agent already has.
  const runTarget = sel !== undefined && /^\d+$/.test(sel) ? `run:${sel}` : undefined;
  const key = `${top} ${sub}`;
  switch (key) {
    case 'pr view': {
      if (has(args, '--comments', '-c')) {
        return {
          suggestion: prCmd('pr', 'feedback'),
          hint: 'reviews, inline and issue comments merged, with bots separated and ids to reply to',
        };
      }
      // gh's --json names become pr status --fields paths (body is description.text).
      const json = flagArg(args, '--json');
      const m = json !== undefined ? mapGhFields(json, undefined) : undefined;
      const fields = m !== undefined && m.paths.length > 0 ? ['--fields', `'${m.paths.join(',')}'`] : [];
      const missing =
        m !== undefined && m.unmapped.length > 0
          ? `; ${m.unmapped.join(', ')} ${m.unmapped.length === 1 ? 'is' : 'are'} not in pr status: ghx api repos/{owner}/{repo}/pulls/${sel ?? '<n>'} has ${m.unmapped.length === 1 ? 'it' : 'them'}`
          : '';
      return {
        suggestion: [...prCmd('pr', 'status'), ...fields],
        hint: `state, title, description.text (the body), mergeable, CI for the head SHA and feedback in one object${missing}`,
      };
    }
    case 'pr checks':
      return {
        suggestion: prCmd('ci', 'wait'),
        hint: 'run it with run_in_background: true; it returns once CI settles or first fails, with a diagnosis. For a one-off snapshot use ghx pr status',
        alternatives: [prCmd('pr', 'status')],
      };
    case 'run view': {
      if (!has(args, '--log', '--log-failed')) return undefined;
      const job = flagArg(args, '--job') ?? flagArg(args, '-j');
      const raw = `ghx api repos/{owner}/{repo}/actions/jobs/${job ?? '<job-id>'}/logs`;
      if (job !== undefined) {
        return {
          message: `'ghx run view --log' is not passed through.`,
          suggestion: ['ghx', 'ci', 'why', `job:${job}`, ...R],
          hint: `the job's failing step, error lines and failed tests; its raw log is ${raw}`,
          alternatives: [raw.split(' ')],
        };
      }
      return {
        message: `'ghx run view --log' is not passed through.`,
        suggestion: ['ghx', 'ci', 'why', runTarget ?? '<pr|run:<run-id>>', ...R],
        hint: `the failing step, error lines and failed tests, read from the jobs-logs API (works while the run is in progress); one job's raw log is ${raw} (job ids: ghx run view ${sel ?? '<run-id>'} --json jobs)`,
      };
    }
    case 'run watch':
      return {
        suggestion: ['ghx', 'ci', 'wait', runTarget ?? '<pr|run:<run-id>>', ...R],
        hint: 'run it with run_in_background: true; it returns at the first failure with a diagnosis, or add --until settled to wait for the whole run',
      };
    case 'run rerun': {
      // gh's --job takes a job id; ghx's takes a job name (glob), so the name is the agent's to fill in.
      const job = has(args, '--job', '-j') ? ['--job', "'<job name>'"] : [];
      return {
        suggestion: ['ghx', 'ci', 'rerun', runTarget ?? '<pr|run:<run-id>>', ...job, ...R],
        hint:
          'reruns the failed jobs of completed runs (with or without --failed); --flaky limits it to likely flakes. ' +
          `If a job of the run is still going, first run ghx ci wait ${runTarget ?? 'run:<run-id>'} --until settled in the background`,
      };
    }
    case 'pr create':
      return {
        suggestion: ['ghx', 'pr', 'create', '--input', 'pr.json', ...R],
        hint: 'write the structured PR JSON with your file tool first; ghx schema pr create lists the fields',
      };
    case 'pr edit':
      return {
        suggestion: prCmd('pr', 'edit', '--input', 'patch.json'),
        hint: 'patch.json holds only the fields to change',
      };
    case 'pr ready':
      return {
        suggestion: prCmd('pr', 'edit', '--input', 'ready.json'),
        hint: `ready.json is {"draft": ${has(args, '--undo') ? 'true' : 'false'}}; a PR without a ghx block also needs "adopt": true and the full object`,
      };
    case 'pr merge':
      return { suggestion: prCmd('pr', 'merge'), hint: 'policy-checked, pinned to the head SHA' };
    case 'pr comment':
      return {
        suggestion: prCmd('pr', 'comment', '--input', 'comment.json'),
        hint: 'a typed coordination comment; ghx schema pr comment lists the kinds',
      };
    case 'pr review':
      return {
        suggestion: prCmd('pr', 'review', '--input', 'review.json'),
        hint: 'structured findings; ghx schema pr review lists the fields',
      };
    case 'pr close':
      return {
        suggestion: prCmd('pr', 'comment', '--close', '--input', 'comment.json'),
        hint: 'records why in a typed comment, then closes',
      };
    case 'pr reopen':
      return {
        suggestion: prCmd('ci', 'retrigger'),
        hint: 'if retriggering CI is the intent (it closes and reopens safely); otherwise reopen it in the GitHub UI',
      };
    default:
      return undefined;
  }
}

/**
 * ghx commands agents guess that do not exist (`ci logs`), with the command that does the job: a fixed
 * table, checked before any edit-distance suggestion (which reads `pr update` as `pr create`). None is a
 * gh command, so the refusal carries no `wrapped` name and the hook never denies one.
 */
function guessed(top: string, sub: string, args: readonly string[], repo: string | undefined): Wrapped | undefined {
  const sel = firstPositional(args);
  const R = repo !== undefined ? ['-R', repo] : [];
  const pr = sel ?? '<pr>';
  switch (`${top} ${sub}`) {
    case 'pr show':
    case 'pr get':
    case 'pr info':
      return {
        suggestion: ['ghx', 'pr', 'status', pr, ...R],
        hint: 'state, title, description.text (the body), mergeable, CI for the head SHA and feedback in one object',
      };
    case 'pr update':
      return {
        suggestion: ['ghx', 'pr', 'edit', pr, '--input', 'patch.json', ...R],
        hint: 'patch.json holds only the fields to change; ghx schema pr edit lists them',
      };
    case 'pr threads':
    case 'pr review-comments':
    case 'pr comments':
    case 'pr reviews':
      return {
        suggestion: ['ghx', 'pr', 'feedback', pr, ...R],
        hint: 'reviews, inline and issue comments merged, with bots separated and ids to reply to; --open keeps the unresolved ones',
      };
    case 'pr resolve-thread':
      return {
        suggestion: ['ghx', 'pr', 'resolve', pr, '<finding-id>', ...R],
        hint: 'finding ids (f_…) come from ghx pr feedback; --status addressed --commit <sha>, or wontfix --note "…"; it resolves the review thread',
      };
    case 'ci rerun-failed':
      return {
        suggestion: ['ghx', 'ci', 'rerun', sel ?? '<pr|run:<id>>', ...R],
        hint: 'reruns the failed jobs of completed runs; --flaky limits it to likely flakes',
      };
    case 'ci failures':
    case 'ci failed':
    case 'ci errors':
    case 'ci log':
    case 'ci logs':
    case 'ci view':
      return {
        suggestion: ['ghx', 'ci', 'why', sel ?? '<pr|run:<id>>', ...R],
        hint: 'the failing step, error lines and failed tests of the head SHA, read from the jobs-logs API; run:<id> reads one workflow run',
        ...(sel !== undefined && /^\d+$/.test(sel) ? { alternatives: [['ghx', 'ci', 'why', `run:${sel}`, ...R]] } : {}),
      };
    case 'ci watch':
    case 'ci checks':
    case 'ci status':
      return {
        suggestion: ['ghx', 'ci', 'wait', sel ?? '<pr>', ...R],
        hint: 'run it with run_in_background: true; it returns once CI settles or first fails, with a diagnosis. For a one-off snapshot use ghx pr status',
        alternatives: [['ghx', 'pr', 'status', sel ?? '<pr>', ...R]],
      };
    default:
      return undefined;
  }
}

function wrappedError(top: string, sub: string, w: Wrapped): GhxError {
  return new GhxError('USAGE_UNKNOWN_COMMAND', w.message ?? `'ghx ${top} ${sub}' is not a ghx command.`, {
    hint: `Use: ${w.suggestion.join(' ')} (${w.hint}).`,
    details: {
      suggestion: w.suggestion,
      // The command name, like every other USAGE_UNKNOWN_COMMAND's did-you-mean list.
      suggestions: [w.suggestion.slice(1, 3).join(' ')],
      ...(w.alternatives ? { alternatives: w.alternatives } : {}),
    },
  });
}

function writeRefused(what: string, reason: string, hint: string): GhxError {
  return new GhxError('PASSTHROUGH_WRITE_REFUSED', `'gh ${what}' is refused: ${reason}.`, {
    hint,
    details: { command: `gh ${what}` },
  });
}

const WRITE_HINT =
  'ghx passes through reads only; writes go through validated ghx commands (ghx --help). Ask the user to run it if it is needed.';

/** The `ghx api` form passthrough accepts: the refusal hint and `ghx api --help` (src/cli/run.ts). */
export const API_USAGE = 'ghx api <endpoint> with only -H, -q/--jq, --paginate, --slurp, -i, --hostname or --cache';

/** `gh api`: GET only, no fields, no graphql, nothing ghx cannot parse. */
function decideApi(args: string[], g: Globals): Decision {
  if (args.some((a) => a === '-R' || a.startsWith('--repo') || /^-R./.test(a))) {
    return {
      kind: 'refuse',
      error: new GhxError('USAGE_UNKNOWN_FLAG', "'gh api' has no flag '-R'.", {
        hint: 'Put owner/repo in the endpoint (repos/owner/repo/…), or use {owner}/{repo}, which ghx fills from the resolved repo.',
        details: { flag: '-R', suggestions: [] },
      }),
    };
  }
  const shape = apiShape(args);
  const what = `api ${shape.endpoint ?? ''}`.trim();
  if (shape.ambiguous) {
    return {
      kind: 'refuse',
      error: writeRefused(
        what,
        'ghx cannot verify it is a GET (an unrecognised flag, a missing value or endpoint, an extra argument, or --)',
        `Use: ${API_USAGE}.`,
      ),
    };
  }
  if (shape.endpoint === 'graphql') {
    return {
      kind: 'refuse',
      error: writeRefused(
        what,
        'gh api graphql is always a POST',
        'Use ghx pr status / ghx pr feedback, or a REST GET such as ghx api repos/{owner}/{repo}/pulls/123.',
      ),
    };
  }
  if (shape.hasFields) {
    return {
      kind: 'refuse',
      error: writeRefused(
        what,
        'gh switches -f/-F/--field/--raw-field/--input to POST',
        'Put query parameters in the endpoint instead: ghx api "repos/{owner}/{repo}/pulls?state=open&per_page=50".',
      ),
    };
  }
  if (shape.method !== 'GET') {
    return { kind: 'refuse', error: writeRefused(what, `method ${shape.method} is not GET`, WRITE_HINT) };
  }
  return guarded({ name: ['api'], args, inject: 'placeholders' }, g);
}

/** The final gate: the read guard must accept exactly what will run. */
function guarded(plan: PassthroughPlan, g: Globals): Decision {
  if (!isReadAllowed(plan.args)) {
    return {
      kind: 'refuse',
      error: writeRefused(plan.args.slice(0, 2).join(' '), 'the read guard does not classify it as a read', WRITE_HINT),
    };
  }
  return {
    kind: 'run',
    plan: {
      ...plan,
      ...(g.maxBytes !== undefined ? { maxBytes: g.maxBytes } : {}),
      ...(g.globals.fields !== undefined ? { projected: true } : {}),
    },
    globals: g.globals,
  };
}

/** A gh-shaped argv split as decide() reads it: ghx output flags, the command words, -R, and the rest. */
export interface GhCall {
  top: string;
  sub: string;
  /** After the verb, without -R. */
  args: string[];
  repo?: string;
  globals: Partial<GlobalOptions>;
}

/** Split a `<group> <verb> …` argv (gh and ghx aliases expanded); undefined for api, search or no verb. */
export function ghCall(tokens: readonly string[]): GhCall | undefined {
  const g = takeGhxGlobals(tokens);
  let argv = normalizeGhArgv(g.rest);
  const first = argv[0];
  if (first === undefined || first.startsWith('-')) return undefined;
  const expanded = TOP_ALIASES[first];
  if (expanded) argv = [...expanded, ...argv.slice(1)];
  const top = argv[0] as string;
  if (top === 'api' || top === 'search') return undefined;
  const taken = takeRepoFlag(argv.slice(1));
  const [rawSub, ...args] = taken.rest;
  if (rawSub === undefined || rawSub.startsWith('-')) return undefined;
  const sub = VERB_ALIASES[top]?.[rawSub] ?? rawSub;
  return { top, sub, args, ...(taken.repo !== undefined ? { repo: taken.repo } : {}), globals: g.globals };
}

/** Decide what to do with an argv that names no ghx command. */
export function decide(tokens: readonly string[]): Decision {
  const g = takeGhxGlobals(tokens);
  let argv = normalizeGhArgv(g.rest);
  const first = argv[0];
  if (first === undefined || first.startsWith('-')) return { kind: 'unknown', words: [], ghKnown: false };
  const expanded = TOP_ALIASES[first];
  if (expanded) argv = [...expanded, ...argv.slice(1)];
  const top = argv[0] as string;
  if (top === 'api') return decideApi(argv, g);

  // search's -R is a filter, passed through as typed; everyone else's is ghx's repo.
  const repoTaken = top === 'search' ? { rest: argv.slice(1) } : takeRepoFlag(argv.slice(1));
  const [rawSub, ...args] = repoTaken.rest;
  const repo = 'repo' in repoTaken ? repoTaken.repo : undefined;
  if (rawSub === undefined || rawSub.startsWith('-'))
    return { kind: 'unknown', words: [top], ghKnown: GH_LEAVES.has(top) };
  const sub = VERB_ALIASES[top]?.[rawSub] ?? rawSub;

  const w = wrapped(top, sub, args, repo);
  if (w) return { kind: 'refuse', error: wrappedError(top, sub, w), wrapped: `${top} ${sub}` };
  const guess = guessed(top, sub, args, repo);
  if (guess) return { kind: 'refuse', error: wrappedError(top, sub, guess) };

  if (ALLOWED_READS[top]?.includes(sub)) {
    const globals: Partial<GlobalOptions> = { ...g.globals, ...(repo !== undefined ? { repo } : {}) };
    const gg: Globals = { ...g, globals };
    if (wantsWeb(args, `${top} ${sub}` === 'run list')) {
      return {
        kind: 'refuse',
        error: new GhxError('USAGE_UNKNOWN_FLAG', `'ghx ${top} ${sub}' has no flag '--web'.`, {
          hint: 'ghx never opens a browser; drop --web to get the output as JSON.',
          details: { flag: '--web', suggestions: [] },
        }),
      };
    }
    if (top === 'run' && sub === 'download' && !hasDir(args)) {
      return {
        kind: 'refuse',
        error: new GhxError('VALIDATION', "'ghx run download' needs -D <dir>.", {
          hint: 'Name the directory the artifacts go into: ghx run download <run-id> -D <dir>.',
          details: { issues: [{ path: '-D', code: 'required', message: 'run download writes files; pass -D <dir>' }] },
        }),
      };
    }
    const inject =
      top === 'search'
        ? 'none'
        : top === 'repo'
          ? firstPositional(args) === undefined
            ? 'positional'
            : 'none'
          : 'flag';
    return guarded({ name: [top, sub], args: [top, sub, ...args], inject }, gg);
  }

  const third = args[0];
  const writes = WRITES[top] ?? [];
  if (writes.includes(sub) || (third !== undefined && writes.includes(`${sub} ${third}`))) {
    return { kind: 'refuse', error: writeRefused(`${top} ${sub}`, 'it is a write ghx does not validate', WRITE_HINT) };
  }
  if (GH_LEAVES.has(top)) return { kind: 'unknown', words: [top], ghKnown: true };
  return { kind: 'unknown', words: [top, sub], ghKnown: OTHER_READS[top]?.includes(sub) === true };
}

/**
 * The flag tokens of a verb's argv, as pflag reads them: a value flag's value is skipped, and a short
 * cluster (-cw) is split until a value flag takes the rest of it (-Dout). `wFlagTakesValue` for run list,
 * whose -w is --workflow.
 */
function flagNames(args: readonly string[], wFlagTakesValue = false): string[] {
  const out: string[] = [];
  const takesValue = (f: string) => VALUE_FLAGS.has(f) || (wFlagTakesValue && f === '-w');
  for (let i = 0; i < args.length; i++) {
    const t = args[i] as string;
    if (t === '--') break;
    if (t.startsWith('--')) {
      const name = t.split('=')[0] as string;
      out.push(name);
      if (!t.includes('=') && takesValue(name)) i++;
    } else if (/^-[A-Za-z]/.test(t)) {
      for (let j = 1; j < t.length; j++) {
        const f = `-${t[j]}`;
        out.push(f);
        if (takesValue(f)) {
          if (j === t.length - 1) i++;
          break;
        }
      }
    }
  }
  return out;
}

function wantsWeb(args: readonly string[], wFlagTakesValue: boolean): boolean {
  return flagNames(args, wFlagTakesValue).some((f) => f === '--web' || (f === '-w' && !wFlagTakesValue));
}

/** -D/--dir with a value, where -D is a flag and not the value of another one (--name -D). */
function hasDir(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const t = args[i] as string;
    if (t === '--') return false;
    if (t === '-D' || t === '--dir') {
      const v = args[i + 1];
      if (v !== undefined && v !== '' && !v.startsWith('-')) return true;
      i++;
    } else if (/^--dir=./.test(t) || /^-D.+/.test(t)) {
      return true;
    } else if (t.startsWith('-') && !t.includes('=') && VALUE_FLAGS.has(t)) {
      i++;
    }
  }
  return false;
}
