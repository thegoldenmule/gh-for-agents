// "Did you mean" (§9.9): Damerau-Levenshtein distance (optimal string alignment variant).

export function editDistance(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) =>
    Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  const at = (i: number, j: number): number => d[i]?.[j] ?? 0;
  for (let i = 1; i <= n; i++) {
    const row = d[i] as number[];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, at(i - 2, j - 2) + 1);
      row[j] = v;
    }
  }
  return at(n, m);
}

export interface SuggestOptions {
  /** Maximum suggestions returned (default 3). */
  max?: number;
  /** Maximum distance accepted; default scales with the word length (1 for ≤4 chars, else ⌈len/3⌉). */
  maxDistance?: number;
}

/** Closest candidates to `word`, best first. Case-insensitive; exact matches are excluded. */
export function suggest(word: string, candidates: readonly string[], o: SuggestOptions = {}): string[] {
  const w = word.toLowerCase();
  const limit = o.maxDistance ?? (w.length <= 4 ? 1 : Math.ceil(w.length / 3));
  const scored: { c: string; d: number }[] = [];
  for (const c of new Set(candidates)) {
    const lc = c.toLowerCase();
    if (lc === w) continue;
    let dist = editDistance(w, lc);
    // A prefix of a longer candidate is a strong hint ("stat" → "status").
    if (lc.startsWith(w) && w.length >= 3) dist = Math.min(dist, 1);
    if (dist <= limit) scored.push({ c, d: dist });
  }
  scored.sort((x, y) => x.d - y.d || x.c.localeCompare(y.c));
  return scored.slice(0, o.max ?? 3).map((s) => s.c);
}

/** A gh flag carried over to the ghx command that replaced it: the ghx form, or why there is none. */
export interface GhFlagAlias {
  /** The ghx flag(s) to use instead, as typed; absent when ghx has no equivalent. */
  use?: string;
  /** What the agent should know: a policy that may refuse it, or what to do instead. */
  note?: string;
}

/** Policy is not known while parsing argv (no repo or config yet), so the note names the rule. */
const methodNote = (m: string): string =>
  m === 'merge'
    ? 'omit it to use merge.method from .github/ghx.json'
    : `it is refused as METHOD_NOT_ALLOWED unless merge.allowedMethods in .github/ghx.json lists ${m}`;

const NO_LABELS: GhFlagAlias = {
  note: 'ghx sets no labels, reviewers, assignees, milestones or projects; leave it out',
};
const NO_FILL: GhFlagAlias = {
  note: 'ghx does not fill from commits: write title and description in the --input JSON',
};
const NO_WEB: GhFlagAlias = { note: 'ghx never opens a browser' };

/** gh's pr create/edit flags that set things ghx does not manage. */
const PR_UNMANAGED: Readonly<Record<string, GhFlagAlias>> = {
  '--label': NO_LABELS,
  '-l': NO_LABELS,
  '--reviewer': NO_LABELS,
  '-r': NO_LABELS,
  '--assignee': NO_LABELS,
  '-a': NO_LABELS,
  '--milestone': NO_LABELS,
  '-m': NO_LABELS,
  '--project': NO_LABELS,
  '-p': NO_LABELS,
  '--web': NO_WEB,
  '-w': NO_WEB,
};

/**
 * gh flags agents type on the ghx command that replaced the gh one, by ghx command name, as gh spells
 * them. USAGE_UNKNOWN_FLAG names the ghx form instead of an empty did-you-mean (src/cli/args.ts).
 * Flags that are fields of the JSON input are GH_FIELD_FLAGS, not here.
 */
export const GH_FLAG_ALIASES: Readonly<Record<string, Readonly<Record<string, GhFlagAlias>>>> = {
  'pr merge': {
    '--merge': { use: '--method merge', note: methodNote('merge') },
    '-m': { use: '--method merge', note: methodNote('merge') },
    '--squash': { use: '--method squash', note: methodNote('squash') },
    '-s': { use: '--method squash', note: methodNote('squash') },
    '--rebase': { use: '--method rebase', note: methodNote('rebase') },
    '-r': { use: '--method rebase', note: methodNote('rebase') },
    '--match-head-commit': { use: '--expect-head <sha>' },
    '-d': { use: '--delete-branch' },
    '--auto': {
      note: 'ghx has no auto-merge: run ghx ci wait <pr> --until mergeable in the background, then ghx pr merge <pr>',
    },
    '--admin': {
      note: 'ghx never bypasses branch protection; a ghx policy blocker the user accepted takes --override CODE --reason "…"',
    },
  },
  'pr create': {
    ...PR_UNMANAGED,
    '--fill': NO_FILL,
    '-f': NO_FILL,
    '--fill-first': NO_FILL,
    '--fill-verbose': NO_FILL,
  },
  'pr edit': {
    ...PR_UNMANAGED,
    '--add-label': NO_LABELS,
    '--remove-label': NO_LABELS,
    '--add-reviewer': NO_LABELS,
    '--remove-reviewer': NO_LABELS,
    '--add-assignee': NO_LABELS,
    '--remove-assignee': NO_LABELS,
    '--add-project': NO_LABELS,
    '--remove-project': NO_LABELS,
  },
};

/** The ghx form of a gh flag on `command` ('pr merge'), when the table knows it. */
export function ghFlagAlias(command: string | undefined, flag: string): GhFlagAlias | undefined {
  const table = command === undefined ? undefined : GH_FLAG_ALIASES[command];
  return table !== undefined && Object.hasOwn(table, flag) ? table[flag] : undefined;
}

/** A gh flag that is a field of the ghx command's JSON input: the field, and the value a valueless flag means. */
export interface GhFieldFlag {
  field: string;
  /** The field's value for a gh flag that takes none (--draft is draft: true). */
  value?: unknown;
  /** gh's flag names a file; its text is the field. */
  file?: boolean;
}

const BODY = (field: string): Readonly<Record<string, GhFieldFlag>> => ({
  '--body': { field },
  '-b': { field },
  '--body-file': { field, file: true },
  '-F': { field, file: true },
});

const TITLE: Readonly<Record<string, GhFieldFlag>> = { '--title': { field: 'title' }, '-t': { field: 'title' } };
const BASE: Readonly<Record<string, GhFieldFlag>> = { '--base': { field: 'base' }, '-B': { field: 'base' } };

/**
 * gh flags whose ghx home is a JSON input field under another name (or a short name), by ghx command.
 * A flag spelled like the field itself (--head for `head`) needs no entry: args.ts derives it from the
 * command's JSON-only fields, so the hint stays right if a field later becomes a flag.
 */
export const GH_FIELD_FLAGS: Readonly<Record<string, Readonly<Record<string, GhFieldFlag>>>> = {
  'pr create': {
    ...TITLE,
    ...BODY('description'),
    ...BASE,
    '-H': { field: 'head' },
    '--draft': { field: 'draft', value: true },
    '-d': { field: 'draft', value: true },
  },
  'pr edit': { ...TITLE, ...BODY('description'), ...BASE },
  'pr comment': BODY('body'),
  'pr review': {
    ...BODY('summary'),
    '--approve': { field: 'verdict', value: 'approve' },
    '-a': { field: 'verdict', value: 'approve' },
    '--request-changes': { field: 'verdict', value: 'request-changes' },
    '-r': { field: 'verdict', value: 'request-changes' },
    '--comment': { field: 'verdict', value: 'comment' },
    '-c': { field: 'verdict', value: 'comment' },
  },
};

/** The JSON input field a gh flag on `command` stands for, when the table knows it. */
export function ghFieldFlag(command: string | undefined, flag: string): GhFieldFlag | undefined {
  const table = command === undefined ? undefined : GH_FIELD_FLAGS[command];
  return table !== undefined && Object.hasOwn(table, flag) ? table[flag] : undefined;
}
