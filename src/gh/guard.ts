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
}

/** Parse the parts of `gh api …` argv the guard cares about. `args` excludes the leading 'gh'. */
export function apiShape(args: readonly string[]): ApiCallShape {
  let endpoint: string | undefined;
  let method: string | undefined;
  let hasFields = false;
  const fields: Record<string, string> = {};
  const headers: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i] ?? '';
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    if (API_VALUE_FLAGS.has(flag)) {
      const value = inline ?? args[++i] ?? '';
      if (flag === '-X' || flag === '--method') method = value.toUpperCase();
      if (flag === '-H' || flag === '--header') headers.push(value);
      if (FIELD_FLAGS.has(flag)) {
        hasFields = true;
        const k = value.indexOf('=');
        if (k > 0) fields[value.slice(0, k)] = value.slice(k + 1);
      }
      continue;
    }
    if (!a.startsWith('-') && endpoint === undefined) endpoint = a;
  }
  return { endpoint, method: method ?? (hasFields ? 'POST' : 'GET'), hasFields, fields, headers };
}

/** True for a GraphQL document whose (first) operation is a mutation. */
export function isGraphqlMutation(query: string): boolean {
  const stripped = query.replace(/#[^\n]*/g, '').trimStart();
  return /^mutation\b/.test(stripped) || /^subscription\b/.test(stripped);
}

export function isReadAllowed(args: readonly string[]): boolean {
  const [top, sub] = args;
  if (top === undefined) return false;
  if (args.length === 1 && (top === '--version' || top === 'version')) return true;
  // Help output for feature probes (`gh pr checks --help`) never mutates.
  if (args.includes('--help') || args.includes('-h')) return true;
  if (top === 'api') {
    const shape = apiShape(args);
    if (shape.endpoint === 'graphql') {
      const q = shape.fields.query ?? '';
      return (shape.method === 'POST' || shape.method === 'GET') && !isGraphqlMutation(q) && !args.includes('--input');
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
