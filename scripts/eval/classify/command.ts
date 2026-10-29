// Classify a Bash or Monitor command: which GitHub CLI it runs (gh, ghx, both, neither), the subcommand,
// and the glue around it (pipes, jq, sleep, loops, --watch, redirect targets, --input/--body-file files).
// Shell scanning is src/hook/shell.ts's, so the eval, the hook and the acceptance scorer agree on what a
// gh call is; this file only reads its invocations.
import { type Invocation, isGh, isGhx, scanShell } from '../../../src/hook/shell.ts';

export type Cli = 'gh' | 'ghx';
export type CommandCli = Cli | 'mixed' | 'other';

export interface CliInvocation {
  cli: Cli;
  /** Words after the gh/ghx word: ['pr', 'status', '12', '--brief']. */
  args: string[];
  /** Non-flag words, skipping the values of known value flags. */
  positional: string[];
  /** 'pr status', 'ci wait', 'api', 'api graphql', 'run view'; '' for a bare `ghx --help`. */
  subcommand: string;
  /** Wrappers scanShell stripped in front of it (timeout, watch, env, xargs, …). */
  wrappers: string[];
}

export interface Glue {
  /** A `|` outside quotes. */
  pipe: boolean;
  /** `--jq`/`-q` on a gh or ghx call, or a `jq` command. */
  jq: boolean;
  sleep: boolean;
  /** while/until or a `watch` wrapper. */
  loop: boolean;
  /** `--watch`, `gh run watch`, or a `watch` wrapper around a gh/ghx call. */
  watch: boolean;
  timeout: boolean;
  perlAlarm: boolean;
  /** Files written by `>`, `>>`, `&>` or `tee` (basenames), not /dev/null or fd duplications. */
  redirects: string[];
  /** Files passed as `--input`, `--body-file`, or `-F` on gh pr/issue create|edit|comment (basenames). */
  inputFiles: string[];
}

export interface CommandClass {
  cli: CommandCli;
  invocations: CliInvocation[];
  /** `<cli> <subcommand>` of the first gh/ghx invocation, or null. */
  subcommand: string | null;
  glue: Glue;
}

/** gh/ghx flags that take a value, so the value isn't read as a positional (from the prototype). */
export const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-R',
  '--repo',
  '--hostname',
  '--json',
  '-q',
  '--jq',
  '-t',
  '--template',
  '--job',
  '-w',
  '--workflow',
  '-b',
  '--branch',
  '-L',
  '--limit',
  '-X',
  '--method',
  '-f',
  '-F',
  '--interval',
  '-i',
  '-s',
  '--state',
  '--search',
  '--head',
  '--base',
  '--author',
  '--title',
  '--body',
  '--body-file',
  '--input',
  '--fields',
  '--until',
  '--timeout',
  '-H',
  '--header',
]);

export function positional(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const w = args[i] as string;
    if (VALUE_FLAGS.has(w)) {
      i++;
      continue;
    }
    if (w.startsWith('-')) continue;
    out.push(w);
  }
  return out;
}

/** The value of the first of `names` in args (`--flag value` or `--flag=value`), or ''. */
export function flagValue(args: readonly string[], ...names: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const w = args[i] as string;
    for (const name of names) {
      if (w === name && i + 1 < args.length) return args[i + 1] as string;
      if (w.startsWith(`${name}=`)) return w.slice(name.length + 1);
    }
  }
  return '';
}

const base = (w: string): string => w.slice(w.lastIndexOf('/') + 1);
const GHX_PACKAGE = /^(?:@thegoldenmule\/)?ghx(?:@[^\s]*)?$/;
const GHX_SCRIPT = /(?:^|\/)bin\/ghx(?:\.js)?$/;

/**
 * The ghx argv inside an invocation, or undefined: `ghx …`, a path ending /ghx, `npx [-y] ghx …`,
 * `pnpm [exec|dlx] ghx …`, `node …/bin/ghx.js …` and a direct `…/bin/ghx.js …` (dogfood-dev sessions).
 */
export function ghxArgs(inv: Invocation): string[] | undefined {
  const a = inv.argv;
  if (isGhx(inv)) return a.slice(1);
  const head = base(a[0] ?? '');
  if (GHX_SCRIPT.test(a[0] ?? '')) return a.slice(1);
  if (head === 'npx') {
    let i = 1;
    while (i < a.length && (a[i] as string).startsWith('-')) i++;
    return GHX_PACKAGE.test(a[i] ?? '') ? a.slice(i + 1) : undefined;
  }
  if (head === 'pnpm') {
    let i = 1;
    if (a[i] === 'exec' || a[i] === 'dlx') i++;
    return GHX_PACKAGE.test(a[i] ?? '') ? a.slice(i + 1) : undefined;
  }
  if (head === 'node' && GHX_SCRIPT.test(a[1] ?? '')) return a.slice(2);
  return undefined;
}

/** `gh …` argv after the gh word, or undefined. */
export function ghArgs(inv: Invocation): string[] | undefined {
  return isGh(inv) ? inv.argv.slice(1) : undefined;
}

function subcommandOf(pos: readonly string[]): string {
  const [a0, a1] = pos;
  if (a0 === undefined) return '';
  if (a0 === 'api') return a1 === 'graphql' ? 'api graphql' : 'api';
  return a1 === undefined ? a0 : `${a0} ${a1}`;
}

/** Blank quoted spans (keeping length) so a regex over the command sees only shell syntax. */
function blankQuotes(s: string): string {
  return s.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (m) => ' '.repeat(m.length));
}

// scanShell rescans `watch '…'` scripts without the wrapper, so look for the word itself.
const WATCH_WRAPPER = /(?:^|[\s;&|(])watch\s/;
const REDIRECT = /(?:^|[^<>&0-9])(?:\d*>>?|&>>?)\s*([^\s;|&()<>]+)/g;
const BODY_FILE_SUBCOMMANDS = new Set([
  'pr create',
  'pr edit',
  'pr comment',
  'issue create',
  'issue edit',
  'issue comment',
]);

function redirectTargets(command: string, all: readonly Invocation[]): string[] {
  const out: string[] = [];
  for (const m of blankQuotes(command).matchAll(REDIRECT)) {
    const t = m[1] as string;
    if (t === '/dev/null' || t.startsWith('&') || /^\d+$/.test(t)) continue;
    out.push(base(t));
  }
  for (const inv of all) {
    if (base(inv.argv[0] ?? '') !== 'tee') continue;
    for (const w of inv.argv.slice(1)) if (!w.startsWith('-') && w !== '/dev/null') out.push(base(w));
  }
  return [...new Set(out)];
}

function inputFilesOf(invs: readonly CliInvocation[]): string[] {
  const out: string[] = [];
  for (const inv of invs) {
    const flags = ['--input', '--body-file'];
    if (BODY_FILE_SUBCOMMANDS.has(inv.subcommand)) flags.push('-F');
    for (let i = 0; i < inv.args.length; i++) {
      const w = inv.args[i] as string;
      for (const f of flags) {
        const v = w === f ? inv.args[i + 1] : w.startsWith(`${f}=`) ? w.slice(f.length + 1) : undefined;
        if (v !== undefined && v !== '-' && v !== '') out.push(base(v));
      }
    }
  }
  return [...new Set(out)];
}

/** Classify one Bash or Monitor command string. */
export function classifyCommand(command: string): CommandClass {
  const scan = scanShell(command);
  const invocations: CliInvocation[] = [];
  for (const inv of scan.invocations) {
    const ghx = ghxArgs(inv);
    const gh = ghx === undefined ? ghArgs(inv) : undefined;
    const args = ghx ?? gh;
    if (args === undefined) continue;
    const pos = positional(args);
    invocations.push({
      cli: ghx !== undefined ? 'ghx' : 'gh',
      args,
      positional: pos,
      subcommand: subcommandOf(pos),
      wrappers: inv.wrappers,
    });
  }
  const clis = new Set(invocations.map((i) => i.cli));
  const cli: CommandCli = clis.size === 0 ? 'other' : clis.size === 2 ? 'mixed' : (invocations[0] as CliInvocation).cli;
  const first = invocations[0];
  const jqFlag = invocations.some((i) => i.args.some((a) => a === '--jq' || a === '-q' || a.startsWith('--jq=')));
  return {
    cli,
    invocations,
    subcommand: first ? `${first.cli} ${first.subcommand}`.trimEnd() : null,
    glue: {
      pipe: scan.pipe,
      jq: jqFlag || scan.invocations.some((i) => base(i.argv[0] ?? '') === 'jq'),
      sleep: scan.sleep,
      loop: scan.loop,
      watch:
        invocations.some(
          (i) => i.args.includes('--watch') || i.subcommand === 'run watch' || i.wrappers.includes('watch'),
        ) ||
        (invocations.length > 0 && WATCH_WRAPPER.test(blankQuotes(command))),
      timeout: scan.timeout,
      perlAlarm: scan.perlAlarm,
      redirects: redirectTargets(command, scan.invocations),
      inputFiles: inputFilesOf(invocations),
    },
  };
}
