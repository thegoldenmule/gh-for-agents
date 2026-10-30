// Intent of a GitHub command (findings §3): the highest-priority match among its gh and ghx invocations.
// A status read inside a sleep loop, a background Bash call or a Monitor counts as wait. Ported from
// docs/research/ghx-impact/episodes/episodes.py (gh_intent, ghx_intent, classify_call).
import { type CliInvocation, type CommandClass, flagValue } from './command.ts';

export const INTENT_PRIORITY = [
  'merge',
  'create',
  'edit',
  'reply',
  'other_write',
  'diagnose',
  'rerun',
  'wait',
  'feedback',
  'status',
  'other_read',
  'meta',
] as const;
export type Intent = (typeof INTENT_PRIORITY)[number];

const RANK: Record<Intent, number> = Object.fromEntries(INTENT_PRIORITY.map((k, i) => [k, i])) as Record<
  Intent,
  number
>;

const STATUS_FIELDS = new Set([
  'state',
  'mergeable',
  'mergestatestatus',
  'statuscheckrollup',
  'headrefoid',
  'mergedat',
  'mergecommit',
  'reviewdecision',
  'isdraft',
  'closed',
  'merged',
]);
const FEEDBACK_FIELDS = new Set(['comments', 'reviews', 'reviewthreads', 'latestreviews', 'reviewrequests']);

const GHX_NATIVE: Readonly<Record<string, Intent>> = {
  'pr create': 'create',
  'pr edit': 'edit',
  'pr merge': 'merge',
  // Waits until the PR can merge, then merges: a merge.
  'pr land': 'merge',
  'pr ready': 'edit',
  'pr comment': 'reply',
  'pr review': 'reply',
  'pr resolve': 'reply',
  'pr feedback': 'feedback',
  'pr status': 'status',
  'ci wait': 'wait',
  'ci why': 'diagnose',
  'ci rerun': 'rerun',
  'ci retrigger': 'rerun',
};
const GHX_META = new Set([
  '--help',
  '-h',
  'help',
  'schema',
  'doctor',
  'version',
  '--version',
  'init',
  'install',
  'uninstall',
  'hook',
]);

/** Intent of one raw gh invocation (also ghx passthrough). `raw` is the whole command, for graphql bodies. */
export function ghIntent(args: readonly string[], pos: readonly string[], raw = ''): Intent {
  const [a0 = '', a1 = ''] = pos;
  const flags = new Set(args.filter((w) => w.startsWith('-')).map((w) => w.split('=')[0] as string));
  const joined = `${args.join(' ')} ${raw}`;
  const fields = new Set(
    flagValue(args, '--json')
      .split(',')
      .map((f) => f.trim().toLowerCase())
      .filter((f) => f !== ''),
  );
  const any = (s: ReadonlySet<string>): boolean => [...fields].some((f) => s.has(f));
  if (a0 === 'pr') {
    if (a1 === 'create') return 'create';
    if (a1 === 'merge') return 'merge';
    if (['edit', 'ready', 'close', 'reopen'].includes(a1)) return 'edit';
    if (a1 === 'comment' || a1 === 'review') return 'reply';
    if (a1 === 'checks') return flags.has('--watch') ? 'wait' : 'status';
    if (a1 === 'view') {
      if (flags.has('--comments') || any(FEEDBACK_FIELDS)) return 'feedback';
      if (any(STATUS_FIELDS)) return 'status';
      return 'other_read';
    }
    return 'other_read';
  }
  if (a0 === 'run') {
    if (a1 === 'rerun' || a1 === 'cancel') return 'rerun';
    if (a1 === 'watch') return 'wait';
    if (a1 === 'download') return 'diagnose';
    if (a1 === 'view') return flags.has('--log') || flags.has('--log-failed') ? 'diagnose' : 'status';
    if (a1 === 'list') return 'status';
    return 'other_read';
  }
  if (a0 === 'workflow') return a1 === 'run' || a1 === 'enable' ? 'rerun' : 'other_read';
  if (a0 === 'api') {
    const method = flagValue(args, '-X', '--method').toUpperCase();
    const path = a1;
    const write =
      ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) ||
      (['-f', '-F', '--field', '--raw-field', '--input'].some((f) => flags.has(f)) && path !== 'graphql');
    if (path === 'graphql') {
      if (joined.includes('mutation')) return /Review|Comment|resolve/.test(joined) ? 'reply' : 'other_write';
      if (/reviewThreads|comments|reviews/.test(joined)) return 'feedback';
      return 'other_read';
    }
    if (path.includes('/logs')) return 'diagnose';
    if (path.includes('/rerun')) return 'rerun';
    if (write) return /\/(comments|replies|reviews)/.test(path) ? 'reply' : 'other_write';
    if (/\/pulls\/\d+\/(comments|reviews)|\/issues\/\d+\/comments/.test(path)) return 'feedback';
    if (/check-runs|check-suites|actions\/(runs|jobs)|\/status\b|\/statuses/.test(path)) return 'status';
    if (/\/pulls\/\d+$/.test(path)) return 'status';
    return 'other_read';
  }
  if (a0 === 'issue')
    return ['create', 'comment', 'edit', 'close', 'reopen'].includes(a1) ? 'other_write' : 'other_read';
  if (a0 === 'release') return ['create', 'edit', 'delete', 'upload'].includes(a1) ? 'other_write' : 'other_read';
  if (a0 === 'repo') return ['create', 'edit', 'delete', 'fork'].includes(a1) ? 'other_write' : 'other_read';
  return 'other_read';
}

/** Intent of one ghx invocation; `passthrough` when ghx forwarded to gh, `meta` for help/schema/doctor. */
export function ghxIntent(
  args: readonly string[],
  pos: readonly string[],
  raw = '',
): { intent: Intent; passthrough: boolean; meta: boolean } {
  const a0 = pos[0] ?? args[0] ?? '';
  const a1 = pos[1] ?? '';
  const first = args[0];
  if (
    first === undefined ||
    GHX_META.has(first) ||
    GHX_META.has(a0) ||
    args.includes('--help') ||
    args.includes('--schema') ||
    args.includes('--example')
  ) {
    return { intent: 'meta', passthrough: false, meta: true };
  }
  const native = GHX_NATIVE[`${a0} ${a1}`];
  if (native) return { intent: native, passthrough: false, meta: false };
  return { intent: ghIntent(args, pos, raw), passthrough: true, meta: false };
}

export interface IntentContext {
  /** The command ran in the background (run_in_background, or a background placeholder result). */
  background?: boolean;
  /** The command ran under the Monitor tool. */
  monitor?: boolean;
}

export interface CommandIntent {
  /** Highest priority across invocations, after the wait modifier. */
  intent: Intent;
  /** One per invocation, in order, after the wait modifier (a wait may be appended). */
  intents: Intent[];
  passthrough: boolean;
  /** Every invocation is ghx meta (help, schema, doctor). */
  metaOnly: boolean;
}

export function invocationIntent(
  inv: CliInvocation,
  raw = '',
): { intent: Intent; passthrough: boolean; meta: boolean } {
  if (inv.cli === 'ghx') return ghxIntent(inv.args, inv.positional, raw);
  return { intent: ghIntent(inv.args, inv.positional, raw), passthrough: false, meta: false };
}

/**
 * Intent of a classified command, or null when it runs no gh or ghx. A loop or sleep, a background call
 * or a Monitor turns status reads into wait (unless something above diagnose is also there).
 */
export function commandIntent(cls: CommandClass, raw: string, ctx: IntentContext = {}): CommandIntent | null {
  if (cls.invocations.length === 0) return null;
  let intents: Intent[] = [];
  let passthrough = false;
  let meta = true;
  for (const inv of cls.invocations) {
    const r = invocationIntent(inv, raw);
    intents.push(r.intent);
    passthrough ||= r.passthrough;
    meta &&= r.intent === 'meta';
  }
  const polling = cls.glue.loop || cls.glue.sleep || ctx.background === true || ctx.monitor === true;
  if (polling && intents.some((i) => i === 'status' || i === 'wait' || i === 'diagnose')) {
    if (!intents.some((i) => RANK[i] < RANK.diagnose)) {
      intents = intents.map((i) => (i === 'status' ? 'wait' : i));
      if (!intents.includes('wait')) intents.push('wait');
    }
  }
  const intent = intents.reduce((a, b) => (RANK[b] < RANK[a] ? b : a));
  return { intent, intents, passthrough, metaOnly: meta };
}

export function intentRank(i: Intent): number {
  return RANK[i];
}
