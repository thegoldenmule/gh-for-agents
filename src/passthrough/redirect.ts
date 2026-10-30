// Answer, don't refuse: a gh-shaped read with a faithful ghx equivalent runs that equivalent, and the
// result carries a REDIRECTED warning naming the ghx command for next time (src/cli/unknown.ts). Pure:
// argv in, the command to run out. Reads only; a write (pr ready, pr edit) is never redirected, and
// anything without a faithful equivalent (no selector, a whole-run log, --watch, --web, a gh flag this
// table does not know) returns undefined, so it keeps policy.ts's refusal and its hint.
//
// decide() (policy.ts) is unchanged by this: the hook reads it for raw `gh` commands, where the answer
// is still a refusal naming the ghx command.

import type { GlobalOptions } from '../cli/args.ts';
import { tryParseTargetRef } from '../gh/refs.ts';
import { mapGhFields } from './gh-fields.ts';
import { ghCall } from './policy.ts';

/** What a gh-shaped read becomes. */
export interface ReadRedirect {
  /** The words the agent typed: 'pr view'. */
  from: string;
  /** The ghx command that answers it (['api'] for a raw job log). */
  command: string[];
  /** Its argv after the command words: positionals and its own flags. */
  args: string[];
  /** ghx output flags from the typed argv (--json became --fields), and -R as repo. */
  globals: Partial<GlobalOptions>;
  /** gh --json fields and the pr status paths they became. */
  mapped?: Record<string, string>;
  /** What was dropped or has no ghx field, one line each. */
  notes: string[];
}

interface Flags {
  values: Map<string, string>;
  bools: Set<string>;
  positionals: string[];
  /** A flag outside the table: no faithful redirect. */
  unknown: boolean;
}

/** Read gh flags against a fixed table (canonical names; short aliases map to them). */
function readFlags(
  args: readonly string[],
  valueFlags: Readonly<Record<string, string>>,
  boolFlags: Readonly<Record<string, string>>,
): Flags {
  const out: Flags = { values: new Map(), bools: new Set(), positionals: [], unknown: false };
  for (let i = 0; i < args.length; i++) {
    const t = args[i] as string;
    if (t === '--') {
      out.positionals.push(...args.slice(i + 1));
      break;
    }
    if (!t.startsWith('-') || t === '-') {
      out.positionals.push(t);
      continue;
    }
    const eq = t.indexOf('=');
    const name = eq === -1 ? t : t.slice(0, eq);
    const value = valueFlags[name];
    const bool = boolFlags[name];
    if (value !== undefined) {
      const v = eq === -1 ? args[++i] : t.slice(eq + 1);
      if (v === undefined) out.unknown = true;
      else out.values.set(value, v);
    } else if (bool !== undefined && eq === -1) {
      out.bools.add(bool);
    } else {
      out.unknown = true;
    }
  }
  return out;
}

const OUTPUT_VALUE_FLAGS = {
  '--json': '--json',
  '--jq': '--jq',
  '-q': '--jq',
  '--template': '--template',
  '-t': '--template',
};

/** A PR selector pr status takes: 12, #12, owner/repo#12 or a PR URL (not a branch name). */
function prSelector(s: string | undefined): string | undefined {
  return s !== undefined && tryParseTargetRef(s)?.kind === 'pr' ? s : undefined;
}

/** gh's --jq/--template have no ghx form: the output is the projected document instead. */
function droppedOutputFlags(f: Flags): string[] {
  return ['--jq', '--template']
    .filter((x) => f.values.has(x))
    .map((x) => `${x} is not applied: the output is ghx's JSON, kept to the fields --json named`);
}

/** gh pr view <pr> [--json f,…] [--jq …] → ghx pr status <pr> --fields <mapped>; --comments → pr feedback. */
function prView(from: string, args: readonly string[], g: Partial<GlobalOptions>): ReadRedirect | undefined {
  const f = readFlags(args, OUTPUT_VALUE_FLAGS, { '--comments': '--comments', '-c': '--comments' });
  const sel = prSelector(f.positionals[0]);
  if (f.unknown || sel === undefined || f.positionals.length > 1) return undefined;
  const { fields: _fields, ...rest } = g;
  if (f.bools.has('--comments')) {
    const notes = f.values.has('--json') ? ['--json is not applied: pr feedback returns every feedback item'] : [];
    return {
      from,
      command: ['pr', 'feedback'],
      args: [sel],
      globals: rest,
      notes: [...notes, ...droppedOutputFlags(f)],
    };
  }
  const { paths, mapped, unmapped } = mapGhFields(f.values.get('--json'), g.fields);
  // Every field asked for has no pr status home: nothing faithful to answer with.
  if (unmapped.length > 0 && paths.length === 0) return undefined;
  const notes = droppedOutputFlags(f);
  if (unmapped.length > 0) {
    notes.push(
      `${unmapped.join(', ')}: not in ghx pr status; ghx api repos/{owner}/{repo}/pulls/${prNumber(sel)} has them`,
    );
  }
  if (mapped.commits !== undefined) notes.push('commits is a count in ghx pr status (changes.commits), not a list');
  return {
    from,
    command: ['pr', 'status'],
    args: [sel],
    globals: { ...rest, ...(paths.length > 0 ? { fields: [paths.join(',')] } : {}) },
    ...(Object.keys(mapped).length > 0 ? { mapped } : {}),
    notes,
  };
}

function prNumber(sel: string): string {
  const t = tryParseTargetRef(sel);
  return t ? String(t.number) : '<n>';
}

/** gh pr checks <pr> (no --watch) → pr status <pr> --fields ref,head.sha,ci: the CI snapshot. */
function prChecks(from: string, args: readonly string[], g: Partial<GlobalOptions>): ReadRedirect | undefined {
  const f = readFlags(args, OUTPUT_VALUE_FLAGS, { '--required': '--required' });
  const sel = prSelector(f.positionals[0]);
  if (f.unknown || sel === undefined || f.positionals.length > 1) return undefined;
  const notes = droppedOutputFlags(f);
  if (f.values.has('--json')) notes.push('--json is not applied: ci holds every check, by state');
  if (f.bools.has('--required')) notes.push('--required is not applied: ci.failing[] and ci.pending[] carry required');
  const { fields, ...rest } = g;
  return {
    from,
    command: ['pr', 'status'],
    args: [sel],
    globals: { ...rest, fields: fields ?? ['ref,head.sha,ci'] },
    notes,
  };
}

/**
 * gh run view: --log-failed → ci why (run:<id>, or job:<id> with --job); --job <id> --log → that job's
 * raw log through ghx api (a file when large). A whole run's --log has no ghx form.
 */
function runView(from: string, args: readonly string[], g: Partial<GlobalOptions>): ReadRedirect | undefined {
  const f = readFlags(args, { '--job': '--job', '-j': '--job' }, { '--log': '--log', '--log-failed': '--log-failed' });
  if (f.unknown || f.positionals.length > 1) return undefined;
  const run = f.positionals[0];
  if (run !== undefined && !/^\d+$/.test(run)) return undefined;
  const job = f.values.get('--job');
  if (job !== undefined && !/^\d+$/.test(job)) return undefined;
  const { fields: _fields, ...rest } = g;
  if (f.bools.has('--log-failed')) {
    const target = job !== undefined ? `job:${job}` : run !== undefined ? `run:${run}` : undefined;
    if (target === undefined) return undefined;
    return { from, command: ['ci', 'why'], args: [target], globals: g, notes: [] };
  }
  if (f.bools.has('--log') && job !== undefined) {
    // {owner}/{repo} is filled from -R (globals.repo) or the cwd repo, as for any ghx api read.
    return {
      from,
      command: ['api'],
      args: [`repos/{owner}/{repo}/actions/jobs/${job}/logs`],
      globals: rest,
      notes: [`for the failing step, errors and tests instead of the raw log: ghx ci why job:${job}`],
    };
  }
  return undefined;
}

/** The read a gh-shaped argv stands for, or undefined to keep the refusal. */
export function readRedirect(tokens: readonly string[]): ReadRedirect | undefined {
  const call = ghCall(tokens);
  if (call === undefined) return undefined;
  const { top, sub, args } = call;
  const g: Partial<GlobalOptions> = { ...call.globals, ...(call.repo !== undefined ? { repo: call.repo } : {}) };
  const from = `${top} ${sub}`;
  switch (from) {
    case 'pr view':
    case 'pr show':
    case 'pr get':
    case 'pr info':
      return prView(from, args, g);
    case 'pr checks':
      return prChecks(from, args, g);
    case 'run view':
      return runView(from, args, g);
    // ghx commands agents guess: the args are the target command's own (flags and positionals).
    case 'pr threads':
    case 'pr review-comments':
    case 'pr comments':
    case 'pr reviews':
      return prSelector(args[0])
        ? { from, command: ['pr', 'feedback'], args: [...args], globals: g, notes: [] }
        : undefined;
    case 'ci failures':
    case 'ci failed':
    case 'ci errors':
    case 'ci log':
    case 'ci logs':
    case 'ci view':
      return args[0] !== undefined && !args[0].startsWith('-')
        ? { from, command: ['ci', 'why'], args: [...args], globals: g, notes: [] }
        : undefined;
    default:
      return undefined;
  }
}
