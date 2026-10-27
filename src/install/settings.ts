// The Claude Code settings.json edits `ghx install` and `ghx uninstall` make (docs/agents/hooks.md):
// the permissions.deny rules for wrapped gh writes, one ghx-owned PreToolUse entry, and optionally
// env.GHX_HOOK_MODE. Pure functions over the parsed object; every other key is left as it was.
import { GhxError } from '../core/errors.ts';
import { WRAPPED_WRITES } from '../passthrough/policy.ts';
import { parseJsonWithPosition } from '../util/json.ts';
import { styleOf, toPlain, withStyle } from './text.ts';

type Json = Record<string, unknown>;

/** A PreToolUse hook whose command contains this is ghx's, whatever path runs it. */
export const HOOK_MARK = 'hook claude-pretooluse';
export const HOOK_MATCHER = 'Bash|Monitor';
export const HOOK_TIMEOUT = 5;

/**
 * The deny rules: one prefix rule per gh write ghx wraps. WRAPPED_WRITES is the single source; the
 * hook denies the same set, and test/docs.test.ts holds hooks.md's manual block to this list.
 */
export const GHX_DENY_RULES: readonly string[] = [...WRAPPED_WRITES].map((w) => `Bash(gh ${w}:*)`);

/** GHX_HOOK_MODE values the hook recognises (src/hook/rules.ts); uninstall removes only these. */
export const HOOK_MODE_VALUES: ReadonlySet<string> = new Set(['ask', 'deny', 'off']);

export interface SettingsEdit {
  deny: boolean;
  /** The hook command to register, or null to leave hooks alone. */
  hookCommand: string | null;
  /** 'ask' sets env.GHX_HOOK_MODE; 'deny' (the hook's default) removes it; undefined leaves env alone. */
  hookMode?: 'ask' | 'deny' | undefined;
}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function invalid(path: string, message: string, details: Json = {}): GhxError {
  return new GhxError('INSTALL_SETTINGS_INVALID', `${path}: ${message}`, {
    hint: 'Fix the file by hand (ghx changes nothing until it parses), then run the command again.',
    details: { path, ...details },
  });
}

/** Parse a settings file. Missing or whitespace-only is `{}`; anything ghx can't merge into safely throws. */
export function parseSettings(text: string | null, path: string): Json {
  if (text === null || toPlain(text).trim() === '') return {};
  const r = parseJsonWithPosition(toPlain(text));
  if (!r.ok) throw invalid(path, `not valid JSON: ${r.message}`, { line: r.line, column: r.column });
  const v = r.value;
  if (!isObj(v)) throw invalid(path, 'the top level is not a JSON object.');
  const shape = (key: string, val: unknown, want: 'object' | 'array') => {
    if (val === undefined) return;
    if (want === 'object' ? !isObj(val) : !Array.isArray(val)) throw invalid(path, `${key} is not an ${want}.`);
  };
  shape('permissions', v.permissions, 'object');
  if (isObj(v.permissions)) shape('permissions.deny', v.permissions.deny, 'array');
  shape('hooks', v.hooks, 'object');
  if (isObj(v.hooks)) shape('hooks.PreToolUse', v.hooks.PreToolUse, 'array');
  shape('env', v.env, 'object');
  return v;
}

/** Indentation of the original file (first indented line), else two spaces. */
function indentOf(text: string | null): string {
  const m = text ? /\n([ \t]+)\S/.exec(text) : null;
  return m?.[1] ?? '  ';
}

/** Serialise like the original: its indentation, BOM and line endings, and a trailing newline unless it had none. */
export function serializeSettings(value: Json, original: string | null): string {
  const plain = original === null ? null : toPlain(original);
  const body = JSON.stringify(value, null, indentOf(plain));
  const newline = plain === null || plain === '' || plain.endsWith('\n');
  return withStyle(newline ? `${body}\n` : body, styleOf(original));
}

/** Whether ghx can rewrite this file without changing more than its own edits (no hand formatting). */
export function keepsFormatting(original: string, parsed: Json): boolean {
  return serializeSettings(parsed, original) === original;
}

export function isGhxHook(h: unknown): boolean {
  return isObj(h) && typeof h.command === 'string' && h.command.includes(HOOK_MARK);
}

export function ghxHookEntry(command: string): Json {
  return { matcher: HOOK_MATCHER, hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT }] };
}

/**
 * Strip every ghx hook from a PreToolUse list. Groups left with no hooks are dropped. Returns the new
 * list and the index (in it) where the first ghx hook was, so a re-install replaces it in place.
 */
function stripGhxHooks(groups: readonly unknown[]): { groups: unknown[]; at: number | null } {
  const out: unknown[] = [];
  let at: number | null = null;
  for (const g of groups) {
    const hooks = isObj(g) && Array.isArray(g.hooks) ? g.hooks : null;
    if (!hooks?.some(isGhxHook)) {
      out.push(g);
      continue;
    }
    at ??= out.length;
    const rest = hooks.filter((h) => !isGhxHook(h));
    if (rest.length > 0) out.push({ ...(g as Json), hooks: rest });
  }
  return { groups: out, at };
}

const clone = (v: Json): Json => structuredClone(v);

/** parent[key], created (appended last, so existing key order holds) when absent. */
function child(parent: Json, key: string, make: () => unknown): unknown {
  if (parent[key] === undefined) parent[key] = make();
  return parent[key];
}

/** The settings with ghx's rules, hook and mode merged in. Re-running it on its own output changes nothing. */
export function installSettings(input: Json, edit: SettingsEdit): Json {
  const s = clone(input);
  if (edit.deny) {
    const perms = child(s, 'permissions', () => ({})) as Json;
    const deny = child(perms, 'deny', () => []) as unknown[];
    for (const rule of GHX_DENY_RULES) if (!deny.includes(rule)) deny.push(rule);
  }
  if (edit.hookCommand !== null) {
    const hooks = child(s, 'hooks', () => ({})) as Json;
    const { groups, at } = stripGhxHooks((hooks.PreToolUse as unknown[] | undefined) ?? []);
    groups.splice(at ?? groups.length, 0, ghxHookEntry(edit.hookCommand));
    hooks.PreToolUse = groups;
  }
  if (edit.hookMode === 'ask') {
    const env = child(s, 'env', () => ({})) as Json;
    env.GHX_HOOK_MODE = 'ask';
  } else if (edit.hookMode === 'deny' && isObj(s.env) && HOOK_MODE_VALUES.has(String(s.env.GHX_HOOK_MODE))) {
    delete s.env.GHX_HOOK_MODE;
    if (Object.keys(s.env).length === 0) delete s.env;
  }
  return s;
}

/** The containers ghx creates when absent, innermost after outermost. */
export const CONTAINERS = ['permissions', 'permissions.deny', 'hooks', 'hooks.PreToolUse', 'env'] as const;

/** The value at a CONTAINERS path, or undefined. */
export function containerOf(s: Json, path: string): unknown {
  let v: unknown = s;
  for (const k of path.split('.')) v = isObj(v) ? v[k] : undefined;
  return v;
}

/** Delete each listed container that is now empty, innermost first. */
export function pruneContainers(s: Json, containers: readonly string[]): void {
  for (const path of [...CONTAINERS].reverse()) {
    if (!containers.includes(path)) continue;
    const keys = path.split('.');
    const last = keys.pop() as string;
    const parent = keys.length === 0 ? s : containerOf(s, keys.join('.'));
    if (!isObj(parent)) continue;
    const v = parent[last];
    if (Array.isArray(v) ? v.length === 0 : isObj(v) && Object.keys(v).length === 0) delete parent[last];
  }
}

/** The settings without these exact deny rules; listed containers this leaves empty are dropped. */
export function removeDenyRules(input: Json, rules: readonly string[], containers: readonly string[]): Json {
  const s = clone(input);
  if (rules.length === 0 || !isObj(s.permissions) || !Array.isArray(s.permissions.deny)) return s;
  s.permissions.deny = s.permissions.deny.filter((r) => !(typeof r === 'string' && rules.includes(r)));
  pruneContainers(s, containers);
  return s;
}

/** What ghx added to one settings file, as `ghx uninstall` needs it (src/install/owned.ts records it). */
export interface Added {
  /** Deny rules ghx added: exact strings that were not there before. */
  deny: string[];
  /** CONTAINERS ghx created, which uninstall drops once they are empty again. */
  containers: string[];
  /** env.GHX_HOOK_MODE as ghx set it, and the value it replaced (null: absent). */
  hookMode: { set: string; prev: string | null } | null;
}

const modeOf = (s: Json): string | null =>
  isObj(s.env) && typeof s.env.GHX_HOOK_MODE === 'string' ? s.env.GHX_HOOK_MODE : null;

/**
 * What going from `before` to `after` added, folded into what ghx had added already (`prior`). Entries
 * no longer present drop out, so the record only ever names things that are there and ghx's.
 */
export function recordAdded(prior: Added, before: Json, after: Json): Added {
  const had = inspectSettings(before).denyPresent;
  const now = inspectSettings(after).denyPresent;
  const deny = GHX_DENY_RULES.filter((r) => now.includes(r) && (prior.deny.includes(r) || !had.includes(r)));
  const containers = CONTAINERS.filter(
    (c) =>
      containerOf(after, c) !== undefined && (prior.containers.includes(c) || containerOf(before, c) === undefined),
  );
  const [was, is] = [modeOf(before), modeOf(after)];
  let hookMode: Added['hookMode'] = prior.hookMode?.set === was ? prior.hookMode : null;
  if (is !== was) hookMode = is === null ? null : { set: is, prev: hookMode ? hookMode.prev : was };
  return { deny, containers, hookMode };
}

/**
 * The settings with what ghx added taken out again: its recorded deny rules, every ghx hook (they carry
 * HOOK_MARK, so they are never the user's), GHX_HOOK_MODE back to its previous value if ghx's value is
 * still there, and the containers ghx created once that leaves them empty. Everything else stays.
 */
export function uninstallSettings(input: Json, added: Added): Json {
  const s = clone(input);
  if (isObj(s.permissions) && Array.isArray(s.permissions.deny)) {
    s.permissions.deny = s.permissions.deny.filter((r) => !(typeof r === 'string' && added.deny.includes(r)));
  }
  if (isObj(s.hooks) && Array.isArray(s.hooks.PreToolUse))
    s.hooks.PreToolUse = stripGhxHooks(s.hooks.PreToolUse).groups;
  const m = added.hookMode;
  if (m && isObj(s.env) && s.env.GHX_HOOK_MODE === m.set) {
    if (m.prev === null) delete s.env.GHX_HOOK_MODE;
    else s.env.GHX_HOOK_MODE = m.prev;
  }
  pruneContainers(s, added.containers);
  return s;
}

export interface SettingsInspection {
  /** Commands of every ghx PreToolUse hook. */
  hookCommands: string[];
  denyPresent: string[];
  denyMissing: string[];
  hookMode: string | null;
}

export function inspectSettings(s: Json): SettingsInspection {
  const groups = isObj(s.hooks) && Array.isArray(s.hooks.PreToolUse) ? s.hooks.PreToolUse : [];
  const hookCommands = groups
    .flatMap((g) => (isObj(g) && Array.isArray(g.hooks) ? g.hooks : []))
    .filter(isGhxHook)
    .map((h) => (h as { command: string }).command);
  const deny = isObj(s.permissions) && Array.isArray(s.permissions.deny) ? s.permissions.deny : [];
  const mode = isObj(s.env) ? s.env.GHX_HOOK_MODE : undefined;
  return {
    hookCommands,
    denyPresent: GHX_DENY_RULES.filter((r) => deny.includes(r)),
    denyMissing: GHX_DENY_RULES.filter((r) => !deny.includes(r)),
    hookMode: typeof mode === 'string' ? mode : null,
  };
}
