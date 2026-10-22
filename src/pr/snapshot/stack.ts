// Stack info (02 §4.1 `Stack`, §4.3 step 5; 03 M6.3, R09) and GraphQL Q2.
// - `parent` is the same-repo PR whose head is this base (non-default bases only; an open one wins).
// - `declaredParent` is the block's `refs.stackedOn`; GitHub auto-retargets [G-RETARGET], so they can differ.
// - `children` are open PRs based on this head branch (none for a fork head).
// - A manual base change with the same from/to within AUTO_DEDUPE_MS of an automatic one is that change.
// Q2 also aliases each pr-merged / release-includes ref. Literals are inlined because read GraphQL takes
// scalar variables only; PrRef bounds owner/name to [\w.-].
import { z } from 'zod';
import type { NetworkCondition } from '../../feedback/fold.ts';
import type { Gh } from '../../gh/index.ts';
import { formatPrRef } from '../../gh/refs.ts';
import { type RepoRef, repoSlug } from '../../gh/types.ts';
import { Iso, PrRef } from '../../schemas/common.ts';
import type { TimelineNode } from './query.ts';

const StackPr = z.object({ ref: PrRef, state: z.string(), draft: z.boolean(), headRef: z.string() });
export const BaseChange = z.object({ from: z.string(), to: z.string(), at: Iso, automatic: z.boolean() });
export const Stack = z.object({
  parent: StackPr.nullable(),
  declaredParent: PrRef.nullable(),
  children: z.array(StackPr),
  baseChanges: z.array(BaseChange),
});
export type Stack = z.infer<typeof Stack>;
export type BaseChange = z.infer<typeof BaseChange>;

export const AUTO_DEDUPE_MS = 60_000;

/** baseChanges from the Q1 timeline, oldest first. */
export function baseChangesOf(timeline: readonly TimelineNode[]): BaseChange[] {
  const auto: BaseChange[] = [];
  const manual: BaseChange[] = [];
  for (const n of timeline) {
    if (n.__typename === 'AutomaticBaseChangeSucceededEvent' && 'oldBase' in n) {
      auto.push({ from: n.oldBase as string, to: n.newBase as string, at: n.createdAt as string, automatic: true });
    } else if (n.__typename === 'BaseRefChangedEvent' && 'previousRefName' in n) {
      manual.push({
        from: n.previousRefName as string,
        to: n.currentRefName as string,
        at: n.createdAt as string,
        automatic: false,
      });
    }
  }
  const sameChange = (m: BaseChange) =>
    auto.some(
      (a) => a.from === m.from && a.to === m.to && Math.abs(Date.parse(a.at) - Date.parse(m.at)) <= AUTO_DEDUPE_MS,
    );
  return [...auto, ...manual.filter((m) => !sameChange(m))].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** `#N` → this repo; `owner/repo#N` as given. */
export function parsePrRef(ref: string, repo: RepoRef): { repo: RepoRef; number: number } | null {
  const m = /^(?:([\w.-]+)\/([\w.-]+))?#([1-9]\d*)$/.exec(ref);
  if (!m) return null;
  const target = m[1] && m[2] ? { host: repo.host, owner: m[1], name: m[2] } : repo;
  return { repo: target, number: Number(m[3]) };
}

/** owner/repo#N for any PrRef; null if it doesn't parse. */
export function normalisePrRef(ref: string, repo: RepoRef): string | null {
  const p = parsePrRef(ref, repo);
  return p ? formatPrRef(p.repo, p.number) : null;
}

// ── Q2 ────────────────────────────────────────────────────────────────────
const LIST_FIELDS = 'number state isDraft headRefName baseRefName headRepository{nameWithOwner}';
const REF_FIELDS = 'number state mergedAt mergeCommit{oid}';

export interface Q2Plan {
  query: string;
  /** Alias → owner/repo#N, for the precondition refs. */
  aliases: Map<string, string>;
}

export function q2Query(o: {
  repo: RepoRef;
  wantParent: boolean;
  wantChildren: boolean;
  conditionRefs: readonly string[];
}): Q2Plan {
  const aliases = new Map<string, string>();
  const sameRepo: string[] = [];
  const otherRepo: string[] = [];
  for (const ref of o.conditionRefs) {
    const p = parsePrRef(ref, o.repo);
    if (!p) continue;
    const full = formatPrRef(p.repo, p.number);
    if ([...aliases.values()].includes(full)) continue;
    const alias = `ref${aliases.size}`;
    aliases.set(alias, full);
    if (repoSlug(p.repo).toLowerCase() === repoSlug(o.repo).toLowerCase()) {
      sameRepo.push(`${alias}:pullRequest(number:${p.number}){${REF_FIELDS}}`);
    } else {
      otherRepo.push(
        `${alias}:repository(owner:${JSON.stringify(p.repo.owner)},name:${JSON.stringify(p.repo.name)})` +
          `{pullRequest(number:${p.number}){${REF_FIELDS}}}`,
      );
    }
  }
  const parts = [
    ...(o.wantParent
      ? [
          `parents:pullRequests(headRefName:$base,first:10,orderBy:{field:CREATED_AT,direction:DESC}){nodes{${LIST_FIELDS}}}`,
        ]
      : []),
    ...(o.wantChildren
      ? [
          `children:pullRequests(baseRefName:$head,first:50,states:[OPEN],orderBy:{field:CREATED_AT,direction:ASC}){nodes{${LIST_FIELDS}}}`,
        ]
      : []),
    ...sameRepo,
  ];
  const query =
    'query($owner:String!,$name:String!,$base:String!,$head:String!){' +
    `repository(owner:$owner,name:$name){__typename ${parts.join(' ')}}${otherRepo.length ? ` ${otherRepo.join(' ')}` : ''}}`;
  return { query, aliases };
}

const ListPr = z.object({
  number: z.number().int(),
  state: z.string(),
  isDraft: z.boolean(),
  headRefName: z.string(),
  baseRefName: z.string(),
  headRepository: z.object({ nameWithOwner: z.string() }).nullable(),
});
export const RefPr = z.object({
  number: z.number().int(),
  state: z.string(),
  mergedAt: z.string().nullable(),
  mergeCommit: z.object({ oid: z.string() }).nullable(),
});
export type RefPr = z.infer<typeof RefPr>;

const ListConn = z.object({ nodes: z.array(ListPr.nullable()) }).optional();

export interface Q2Result {
  parent: Stack['parent'];
  children: Stack['children'];
  /** owner/repo#N → the ref's PR (null: not found or not readable). */
  refs: Map<string, RefPr | null>;
  queries: number;
}

export interface FetchQ2Options {
  gh: Gh;
  repo: RepoRef;
  baseRef: string;
  headRef: string;
  defaultBranch: string;
  crossRepository: boolean;
  conditions: readonly NetworkCondition[];
}

export async function fetchQ2(o: FetchQ2Options): Promise<Q2Result> {
  const wantParent = o.baseRef !== o.defaultBranch;
  const wantChildren = !o.crossRepository;
  const plan = q2Query({ repo: o.repo, wantParent, wantChildren, conditionRefs: o.conditions.map((c) => c.ref) });
  const refs = new Map<string, RefPr | null>([...plan.aliases.values()].map((r) => [r, null]));
  if (!wantParent && !wantChildren && plan.aliases.size === 0) return { parent: null, children: [], refs, queries: 0 };

  // Partial: a precondition ref that doesn't exist is a NOT_FOUND error on its alias, not a failed read.
  const { data } = await o.gh.graphqlPartial(
    plan.query,
    { owner: o.repo.owner, name: o.repo.name, base: o.baseRef, head: o.headRef },
    z.record(z.string(), z.unknown().nullable()),
    { repo: o.repo },
  );
  const repository = z
    .looseObject({ parents: ListConn, children: ListConn })
    .nullable()
    .parse(data.repository ?? null);
  const slug = repoSlug(o.repo).toLowerCase();
  const sameRepoHead = (p: z.infer<typeof ListPr>) => p.headRepository?.nameWithOwner.toLowerCase() === slug;
  const toStack = (p: z.infer<typeof ListPr>) => ({
    ref: formatPrRef(o.repo, p.number),
    state: p.state,
    draft: p.isDraft,
    headRef: p.headRefName,
  });

  const parents = (repository?.parents?.nodes ?? []).filter(
    (p): p is z.infer<typeof ListPr> => p !== null && sameRepoHead(p),
  );
  const parentPr = parents.find((p) => p.state === 'OPEN') ?? parents[0] ?? null;
  const children = (repository?.children?.nodes ?? [])
    .filter((p): p is z.infer<typeof ListPr> => p !== null && p.baseRefName === o.headRef)
    .map(toStack);

  for (const [alias, full] of plan.aliases) {
    const holder = (repository as Record<string, unknown> | null)?.[alias] ?? data[alias];
    const raw =
      holder && typeof holder === 'object' && 'pullRequest' in holder
        ? (holder as { pullRequest: unknown }).pullRequest
        : holder;
    const parsed = RefPr.safeParse(raw);
    refs.set(full, parsed.success ? parsed.data : null);
  }
  return { parent: parentPr ? toStack(parentPr) : null, children, refs, queries: 1 };
}

export function buildStack(o: {
  q2: Pick<Q2Result, 'parent' | 'children'>;
  stackedOn: string | undefined;
  repo: RepoRef;
  timeline: readonly TimelineNode[];
}): Stack {
  return {
    parent: o.q2.parent,
    declaredParent: o.stackedOn ? normalisePrRef(o.stackedOn, o.repo) : null,
    children: o.q2.children,
    baseChanges: baseChangesOf(o.timeline),
  };
}
