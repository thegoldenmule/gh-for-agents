// GraphQL via `gh api graphql --include` (01 §4.3, 03 §3.4). stdout is parsed BEFORE the exit code
// is trusted: a 200 with partial errors exits 1 but still carries `data`.
import { GhxError } from '../core/errors.ts';
import { isGraphqlMutation } from './guard.ts';
import { DEFAULT_HOST, type RepoRef } from './types.ts';

export interface GraphqlError {
  type?: string;
  message: string;
  path?: (string | number)[];
}

export interface GraphqlPayload {
  data?: unknown;
  errors?: GraphqlError[];
}

export type GraphqlVars = Record<
  string,
  string | number | boolean | null | undefined | unknown[] | Record<string, unknown>
>;

/**
 * argv for a GraphQL call. Reads send the query and scalar variables as fields (so the read guard can
 * see the operation); mutations, or any call with non-scalar variables, send a JSON body on stdin.
 */
export function buildGraphqlArgs(
  query: string,
  vars: GraphqlVars,
  o: { repo?: RepoRef | undefined } = {},
): { args: string[]; stdin?: string; mutation: boolean } {
  const mutation = isGraphqlMutation(query);
  const args = ['api', 'graphql', '--include'];
  if (o.repo && o.repo.host !== DEFAULT_HOST) args.push('--hostname', o.repo.host);
  const scalarOnly = Object.values(vars).every((v) => v === null || v === undefined || typeof v !== 'object');
  if (mutation || !scalarOnly) {
    if (!mutation) throw new GhxError('INTERNAL', 'read GraphQL queries take scalar variables only.');
    args.push('--input', '-');
    const variables = Object.fromEntries(Object.entries(vars).filter(([, v]) => v !== undefined));
    return { args, stdin: JSON.stringify({ query, variables }), mutation };
  }
  args.push('-f', `query=${query}`);
  for (const [k, v] of Object.entries(vars).sort(([a], [b]) => a.localeCompare(b))) {
    if (v === undefined || v === null) continue;
    args.push(typeof v === 'string' ? '-f' : '-F', `${k}=${String(v)}`);
  }
  return { args, mutation };
}

export function parseGraphqlBody(body: string): GraphqlPayload | undefined {
  const start = body.indexOf('{');
  if (start === -1) return undefined;
  try {
    return JSON.parse(body.slice(start)) as GraphqlPayload;
  } catch {
    return undefined;
  }
}
