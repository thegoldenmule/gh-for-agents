// `pr create` planning (02 §2.6 steps 2–6): offline validation, the network checks, the stack and
// draft rules (02 §2.4), and rendering. Nothing here mutates; submit.ts does the POST.
import type { GhxConfig } from '../../config/schema.ts';
import type { Context, Warning } from '../../core/command.ts';
import { GhxError, type IssueDetail, mapZodIssues } from '../../core/errors.ts';
import { suggest } from '../../core/suggest.ts';
import type { ResolvedRepo } from '../../gh/repo.ts';
import { repoSlug, sameRepo } from '../../gh/types.ts';
import { newId } from '../../meta/ids.ts';
import { renderPrBody, toPrBlock } from '../../render/pr-body.ts';
import type { PrCreateOutput, PrCreatePreview } from './output.ts';
import { changedFiles, type Preflight, PUSH_PERMISSIONS, runPreflight } from './preflight.ts';
import { collectRefs, createNetworkRules, createRules } from './rules.ts';
import { PrCreateInput } from './schema.ts';
import { prRef, type Submitted } from './submit.ts';

/** Structure (zod) then every createRules issue, without the network. `input` is null when zod failed. */
export function offlineIssues(raw: unknown, config: GhxConfig): { input: PrCreateInput | null; issues: IssueDetail[] } {
  const r = PrCreateInput.safeParse(raw);
  if (!r.success) {
    return {
      input: null,
      issues: mapZodIssues(r.error, { schema: PrCreateInput, input: raw, suggest: (w, c) => suggest(w, c) }),
    };
  }
  return { input: r.data, issues: createRules(r.data, { config }) };
}

export interface PlanEnv {
  ctx: Context;
  repo: ResolvedRepo;
  config: GhxConfig;
  /** --batch: head branch → input index, for items stacked on another item of the same batch. */
  batchHeads?: ReadonlyMap<string, number>;
}

export interface CreatePlan {
  /** The input with refs.stackedOn filled from the stack when it was absent. */
  input: PrCreateInput;
  preflight: Preflight;
  draft: boolean;
  draftDerived: boolean;
  /** --batch: the input index of the batch item this one is stacked on (its PR does not exist yet). */
  stackedOnItem: number | null;
  blockId: string;
  /** Touched components past the full `components` list (06), for the block. */
  alsoTouched: string[];
  warnings: Warning[];
  /** Network VALIDATION issues; the caller throws them (single) or collects them across items (batch). */
  issues: IssueDetail[];
}

/** True when the cwd checkout is the target repo, so local git may be consulted (02 §1.2 rule 4). */
export function isLocalTarget(repo: ResolvedRepo): boolean {
  return repo.cwdRepo !== undefined && sameRepo(repo.cwdRepo, repo.repo);
}

const short = (sha: string): string => sha.slice(0, 7);

/** The reads and checks for one input. State failures throw; VALIDATION issues are returned. */
export async function planCreate(input: PrCreateInput, env: PlanEnv): Promise<CreatePlan> {
  const { ctx, config } = env;
  const repo = env.repo.repo;
  const slug = repoSlug(repo);
  const warnings: Warning[] = [];
  const pf = await runPreflight(ctx.gh, repo, {
    base: input.base,
    head: input.head,
    refs: collectRefs(input).map((r) => r.ref),
  });

  if (pf.permission === null || !PUSH_PERMISSIONS.has(pf.permission)) {
    throw new GhxError(
      'GH_FORBIDDEN',
      `You lack push permission on ${slug} (viewerPermission ${pf.permission ?? 'NONE'}).`,
      { hint: 'Use a fork head (owner:branch) or ask for access.', details: { permission: pf.permission } },
    );
  }
  if (pf.baseOid === null) {
    throw new GhxError('BRANCH_MISSING', `Base branch '${input.base}' does not exist on ${slug}.`, {
      hint: 'Check the name, or create and push the base first.',
      details: { branch: input.base },
    });
  }
  if (pf.headOid === null) {
    throw new GhxError('HEAD_NOT_PUSHED', `Branch '${input.head}' is not on the remote.`, {
      hint: `git push -u origin ${input.head}`,
      details: { branch: input.head },
    });
  }
  if (pf.openOnHead !== null) {
    const ref = prRef(repo, pf.openOnHead.number);
    throw new GhxError('DUPLICATE_PR', `${input.head} already has open PR ${ref}.`, {
      hint: `Update it instead: ghx pr edit ${ref} --input patch.json`,
      details: { existing: ref },
    });
  }
  for (const c of pf.closedOnHead) {
    warnings.push({
      code: 'CLOSED_PR_ON_HEAD',
      message: `${input.head} already had ${prRef(repo, c.number)} (${c.state.toLowerCase()}); a new PR is opened.`,
    });
  }

  const local = isLocalTarget(env.repo);
  const files = await changedFiles(ctx.gh, local ? ctx.git : null, repo, pf.baseOid, pf.headOid);
  if (files.aheadBy === 0) {
    throw new GhxError('NO_COMMITS', `${input.head} has no commits ahead of ${input.base}.`, {
      hint: 'Commit and push your change first.',
      details: { aheadBy: 0 },
    });
  }
  if (local) {
    const localOid = await ctx.git.revParse(`refs/heads/${input.head}`);
    if (localOid !== undefined && localOid !== pf.headOid) {
      warnings.push({
        code: 'HEAD_DIFFERS_FROM_LOCAL',
        message: `Local ${input.head} is at ${short(localOid)} but the remote is at ${short(pf.headOid)}; the PR uses the remote. Push first if that is stale.`,
      });
    }
  }

  // The stack (02 §2.4): a base other than the default branch is stacked; its parent is the open PR
  // whose head is the base, or a batch item not created yet.
  const stacked = input.base !== pf.defaultBranch;
  const stackedOnItem = env.batchHeads?.get(input.base) ?? null;
  const issues: IssueDetail[] = createRules(input, { config, defaultBranch: pf.defaultBranch }).filter(
    (i) => i.code === 'refs.stacked_on_default_base',
  );
  let checked = input;
  if (stackedOnItem !== null && input.refs?.stackedOn !== undefined) {
    issues.push({
      path: 'refs.stackedOn',
      code: 'refs.stack_mismatch',
      message: `the base '${input.base}' is the head of items[${stackedOnItem}]; drop stackedOn, ghx fills it in once that PR exists`,
    });
    const { stackedOn: _drop, ...rest } = input.refs;
    checked = { ...input, refs: rest };
  }
  const baseParent = pf.baseParent ? `#${pf.baseParent.number}` : null;
  const net = createNetworkRules(checked, config, {
    repo: slug,
    changedFiles: files.files,
    baseParent,
    missingRefs: pf.missingRefs,
  });
  issues.push(...net.issues);
  warnings.push(...net.warnings);

  let filled = checked;
  if (stacked && checked.refs?.stackedOn === undefined) {
    if (baseParent !== null) filled = { ...checked, refs: { ...(checked.refs ?? {}), stackedOn: baseParent } };
    else if (stackedOnItem === null) {
      warnings.push({
        code: 'BASE_NOT_A_PR',
        message: `The base '${input.base}' is not the default branch '${pf.defaultBranch}' and no open PR has it as head; stackedOn is left empty.`,
      });
    }
  }
  const draftDerived = input.draft === undefined;
  const draft = input.draft ?? stacked;
  if (input.draft === false && stacked) {
    warnings.push({
      code: 'STACKED_NOT_DRAFT',
      message: `The PR is stacked on '${input.base}' but draft is false; it may be merged before its parent.`,
    });
  }
  return {
    input: filled,
    preflight: pf,
    draft,
    draftDerived,
    stackedOnItem,
    blockId: newId('pr', ctx.random),
    alsoTouched: net.alsoTouched,
    warnings,
    issues,
  };
}

/** The block and body, with `stackedOn` (a batch parent created since planning) filled in when given. */
export function renderPlan(
  plan: CreatePlan,
  config: GhxConfig,
  stackedOn?: string,
): { input: PrCreateInput; body: string } {
  const input =
    stackedOn === undefined ? plan.input : { ...plan.input, refs: { ...(plan.input.refs ?? {}), stackedOn } };
  const body = renderPrBody(toPrBlock(input, { id: plan.blockId, alsoTouched: plan.alsoTouched }), config.render);
  return { input, body };
}

/** `owner/repo#N` for a `#N` ref in `slug`; other refs unchanged. */
export function fullRef(ref: string, slug: string): string {
  return ref.startsWith('#') ? `${slug}${ref}` : ref;
}

export function nextSteps(ref: string): string[] {
  return [`ghx ci wait ${ref}`, `ghx pr status ${ref}`];
}

export function previewOf(plan: CreatePlan, input: PrCreateInput, body: string, slug: string): PrCreatePreview {
  const stackedOn = input.refs?.stackedOn;
  return {
    title: input.title,
    base: input.base,
    head: { ref: input.head, sha: plan.preflight.headOid ?? '' },
    draft: plan.draft,
    draftDerived: plan.draftDerived,
    stackedOn: stackedOn === undefined ? null : fullRef(stackedOn, slug),
    ...(plan.stackedOnItem !== null && stackedOn === undefined ? { stackedOnItem: plan.stackedOnItem } : {}),
    blockId: plan.blockId,
    body,
    next: [],
  };
}

export function outputOf(plan: CreatePlan, input: PrCreateInput, s: Submitted, slug: string): PrCreateOutput {
  const ref = `${slug}#${s.pull.number}`;
  const stackedOn = input.refs?.stackedOn;
  return {
    ref,
    number: s.pull.number,
    url: s.pull.html_url,
    title: s.pull.title,
    base: s.pull.base.ref,
    head: { ref: s.pull.head.ref, sha: s.pull.head.sha },
    draft: s.pull.draft ?? plan.draft,
    draftDerived: plan.draftDerived,
    stackedOn: stackedOn === undefined ? null : fullRef(stackedOn, slug),
    blockId: plan.blockId,
    body: s.pull.body ?? '',
    ...(s.recoveredFromTransient ? { recoveredFromTransient: true } : {}),
    next: nextSteps(ref),
  };
}
