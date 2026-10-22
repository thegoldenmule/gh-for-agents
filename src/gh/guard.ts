// Read-mode allowlist and the mutation classifier for gh argv (01 §4.3, 02 §10, 02 §15 ask 4).
// Deny is the default: anything not recognised as a read counts as mutating.
//
// The allowlist already includes 02 §10's passthrough reads, so passthrough needs no edit here.

const FIELD_FLAGS = new Set(['-f', '-F', '--field', '--raw-field', '--input']);

/** Flags of `gh api` that take a value (so the value is not mistaken for the endpoint). */
const API_VALUE_FLAGS = new Set([
  '-X',
  '--method',
  '-H',
  '--header',
  '-f',
  '-F',
  '--field',
  '--raw-field',
  '--input',
  '--hostname',
  '-q',
  '--jq',
  '-t',
  '--template',
  '--cache',
  '-p',
  '--preview',
]);

/** Boolean flags of `gh api`. Any flag in neither set makes the parse ambiguous, which is denied. */
const API_BOOL_FLAGS = new Set(['-i', '--include', '--paginate', '--slurp', '--silent', '--verbose']);

const READ_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  pr: ['view', 'list', 'checks', 'diff'],
  run: ['view', 'list', 'download'],
  issue: ['view', 'list'],
  search: ['issues', 'prs', 'code', 'repos', 'commits'],
  release: ['list', 'view'],
  repo: ['view'],
  workflow: ['list', 'view'],
  label: ['list'],
  auth: ['status'],
};

export interface ApiCallShape {
  endpoint: string | undefined;
  method: string;
  hasFields: boolean;
  fields: Record<string, string>;
  headers: string[];
  /** Every field as written, in order (keys may repeat). `typed` is -F/--field, which reads `@file` values. */
  fieldList: { key: string; value: string; typed: boolean }[];
  /** --input was given, in any form. */
  input: boolean;
  /** The argv did not parse cleanly (unknown flag, missing value, extra positional, `--`). Denied. */
  ambiguous: boolean;
}

/**
 * Parse the parts of `gh api …` argv the guard cares about, the way gh's flag parser (pflag) does:
 * `-X POST`, `-XPOST`, `-X=POST`, `--method POST`, `--method=POST`, and short clusters such as
 * `-iXPOST`. `args` excludes the leading 'gh'.
 */
export function apiShape(args: readonly string[]): ApiCallShape {
  let endpoint: string | undefined;
  let method: string | undefined;
  let hasFields = false;
  let input = false;
  let ambiguous = false;
  const fields: Record<string, string> = {};
  const fieldList: ApiCallShape['fieldList'] = [];
  const headers: string[] = [];
  const take = (flag: string, value: string | undefined): void => {
    if (value === undefined) {
      ambiguous = true;
      return;
    }
    if (flag === '-X' || flag === '--method') method = value.toUpperCase();
    if (flag === '-H' || flag === '--header') headers.push(value);
    if (flag === '--input') input = true;
    if (FIELD_FLAGS.has(flag)) {
      hasFields = true;
      if (flag === '--input') return;
      const k = value.indexOf('=');
      if (k <= 0) {
        ambiguous = true;
        return;
      }
      const key = value.slice(0, k);
      const v = value.slice(k + 1);
      fields[key] = v;
      fieldList.push({ key, value: v, typed: flag === '-F' || flag === '--field' });
    }
  };
  for (let i = 1; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--') {
      ambiguous = true; // ghx never emits it; refuse rather than reason about what follows.
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const flag = eq > 0 ? a.slice(0, eq) : a;
      if (API_VALUE_FLAGS.has(flag)) take(flag, eq > 0 ? a.slice(eq + 1) : args[++i]);
      else if (!API_BOOL_FLAGS.has(flag) || eq > 0) ambiguous = true;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      // A shorthand cluster: booleans, then at most one value flag that takes the rest (or the next arg).
      for (let j = 1; j < a.length; j++) {
        const flag = `-${a[j]}`;
        if (API_BOOL_FLAGS.has(flag)) continue;
        if (!API_VALUE_FLAGS.has(flag)) {
          ambiguous = true;
          break;
        }
        let rest = a.slice(j + 1);
        if (rest.startsWith('=')) rest = rest.slice(1);
        take(flag, rest !== '' ? rest : args[++i]);
        break;
      }
      continue;
    }
    if (endpoint === undefined) endpoint = a;
    else ambiguous = true;
  }
  if (endpoint === undefined) ambiguous = true;
  return {
    endpoint,
    method: method ?? (hasFields ? 'POST' : 'GET'),
    hasFields,
    fields,
    headers,
    fieldList,
    input,
    ambiguous,
  };
}

/** The document with comments and string literals blanked; undefined if a string is unterminated. */
function graphqlCode(doc: string): string | undefined {
  let out = '';
  let i = 0;
  while (i < doc.length) {
    const c = doc[i];
    if (c === '#') {
      while (i < doc.length && doc[i] !== '\n' && doc[i] !== '\r') i++;
      out += ' ';
    } else if (doc.startsWith('"""', i)) {
      i += 3;
      for (;;) {
        if (i >= doc.length) return undefined;
        if (doc.startsWith('\\"""', i)) i += 4;
        else if (doc.startsWith('"""', i)) break;
        else i++;
      }
      i += 3;
      out += ' ';
    } else if (c === '"') {
      i++;
      for (;;) {
        if (i >= doc.length || doc[i] === '\n' || doc[i] === '\r') return undefined;
        if (doc[i] === '\\') i += 2;
        else if (doc[i] === '"') break;
        else i++;
      }
      i++;
      out += ' ';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * True when any operation in the GraphQL document is a mutation or subscription (a multi-operation
 * document can select one through operationName). Strings and comments are ignored; a document that
 * cannot be tokenised counts as a mutation.
 */
export function isGraphqlMutation(query: string): boolean {
  const code = graphqlCode(query);
  if (code === undefined) return true;
  return /(^|[^_A-Za-z0-9$])(mutation|subscription)(?![_A-Za-z0-9])/.test(code);
}

export function isReadAllowed(args: readonly string[]): boolean {
  const [top, sub] = args;
  if (top === undefined) return false;
  if (args.length === 1 && (top === '--version' || top === 'version')) return true;
  // No blanket --help shortcut: `pr comment 1 --body --help` would post "--help". Help probes such as
  // doctor's `gh pr checks --help` pass through the subcommand allowlist below.
  if (top === 'api') {
    const shape = apiShape(args);
    if (shape.ambiguous) return false;
    if (shape.endpoint === 'graphql') {
      const queries = shape.fieldList.filter((f) => f.key === 'query' || f.key.startsWith('query['));
      const q = queries[0];
      return (
        (shape.method === 'POST' || shape.method === 'GET') &&
        !shape.input &&
        queries.length === 1 &&
        q !== undefined &&
        q.key === 'query' &&
        // -F reads `@file` values from disk, where the guard cannot see them.
        !shape.fieldList.some((f) => f.typed && f.value.startsWith('@')) &&
        !isGraphqlMutation(q.value)
      );
    }
    return shape.method === 'GET' && !shape.hasFields;
  }
  if (top === 'run' && sub === 'view' && (args.includes('--log') || args.includes('--log-failed'))) {
    // Reading logs is a read; the passthrough refuses it for policy reasons (G-LOGS), not here.
    return true;
  }
  const allowed = READ_SUBCOMMANDS[top];
  return allowed !== undefined && sub !== undefined && allowed.includes(sub);
}

/** The mutation classifier. Unknown commands count as mutating. */
export function isMutating(args: readonly string[]): boolean {
  return !isReadAllowed(args);
}
