// PR refs named by a write (02 §7.1: "refs must exist"): one read GraphQL query with a literal-aliased
// field per distinct ref. A ref that doesn't resolve is a NOT_FOUND error on its own alias, so the query
// is read partially; any alias without a pull request counts as missing. PrRef bounds owner and name to
// [\w.-], so the JSON-quoted literals cannot break out of the query.
import { z } from 'zod';
import type { Gh } from '../../gh/index.ts';
import { formatPrRef } from '../../gh/refs.ts';
import type { RepoRef } from '../../gh/types.ts';
import { parsePrRef } from '../snapshot/stack.ts';

export const RefState = z.object({ number: z.number().int(), state: z.string(), mergedAt: z.string().nullable() });
export type RefState = z.infer<typeof RefState>;

/** owner/repo#N for a PrRef relative to `repo`; null when it doesn't parse. */
export function fullRef(ref: string, repo: RepoRef): string | null {
  const p = parsePrRef(ref, repo);
  return p ? formatPrRef(p.repo, p.number) : null;
}

export function refsQuery(refs: readonly string[], repo: RepoRef): { query: string; aliases: Map<string, string> } {
  const aliases = new Map<string, string>();
  const fields: string[] = [];
  for (const ref of refs) {
    const p = parsePrRef(ref, repo);
    if (!p) continue;
    const full = formatPrRef(p.repo, p.number);
    if ([...aliases.values()].includes(full)) continue;
    const alias = `r${aliases.size}`;
    aliases.set(alias, full);
    fields.push(
      `${alias}:repository(owner:${JSON.stringify(p.repo.owner)},name:${JSON.stringify(p.repo.name)})` +
        `{pullRequest(number:${p.number}){number state mergedAt}}`,
    );
  }
  return { query: `query{${fields.join(' ')}}`, aliases };
}

/** owner/repo#N → the PR's state, or null when it doesn't exist (or can't be read). */
export async function lookupRefs(
  gh: Gh,
  repo: RepoRef,
  refs: readonly string[],
): Promise<Map<string, RefState | null>> {
  const { query, aliases } = refsQuery(refs, repo);
  const out = new Map<string, RefState | null>();
  if (aliases.size === 0) return out;
  const { data } = await gh.graphqlPartial(query, {}, z.record(z.string(), z.unknown().nullable()), {
    repo,
    notFound: 'REF_NOT_FOUND',
  });
  for (const [alias, full] of aliases) {
    const holder = data[alias];
    const pr = holder && typeof holder === 'object' ? (holder as { pullRequest?: unknown }).pullRequest : null;
    const parsed = RefState.safeParse(pr);
    out.set(full, parsed.success ? parsed.data : null);
  }
  return out;
}
