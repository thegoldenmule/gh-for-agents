// `pr edit` planning (02 §3 gh calls 1–2): the snapshot, the block, drift, the merge of block and patch
// (arrays replace), the full createRules plus the network checks on the merged object, the stack, and the
// re-render with rev+1. Nothing here mutates; submit.ts re-reads, PATCHes, flips draft and reads back.
import type { GhxConfig } from '../../config/schema.ts';
import type { Context, Warning } from '../../core/command.ts';
import { GhxError, type IssueDetail } from '../../core/errors.ts';
import { formatPrRef } from '../../gh/refs.ts';
import type { ResolvedRepo } from '../../gh/repo.ts';
import { repoSlug } from '../../gh/types.ts';
import { newId } from '../../meta/ids.ts';
import { type PrBlockRead, readPrBlock } from '../../meta/schemas.ts';
import { parsePrBody, prBodyDrift, renderPrBody, toPrBlock } from '../../render/pr-body.ts';
import { normalizeComponents, structureIssues } from '../create/check.ts';
import { resolveComponent } from '../create/components.ts';
import { EDIT_EXAMPLE_HINT } from '../create/example.ts';
import { isLocalTarget } from '../create/plan.ts';
import { changedFiles, type Preflight, PUSH_PERMISSIONS, runPreflight } from '../create/preflight.ts';
import {
  alsoTouchedFloor,
  canonicalRef,
  collectRefs,
  createNetworkRules,
  type PartialRulesInput,
  partialRules,
  validationError,
} from '../create/rules.ts';
import { PrCreateInput, type PrEditInput } from '../create/schema.ts';
import { fetchPrSnapshot, openChildren, type PrSnapshot } from './snapshot.ts';

export type EditField = 'title' | 'body' | 'base' | 'draft';

/** The block fields a patch may replace (02 §9.2): everything but t, id, gen and rev. */
const CONTENT_KEYS = [
  'title',
  'description',
  'testing',
  'risk',
  'riskNote',
  'components',
  'revertPolicy',
  'revertNote',
  'revertWith',
  'refs',
] as const;

/** The content fields of a (lenient) block, without unknown extras. */
export function blockContent(block: PrBlockRead): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of CONTENT_KEYS) if (block[k] !== undefined) out[k] = block[k];
  return out;
}

/**
 * The visible text a UI edit can change that the re-render would overwrite: the title, the description,
 * and text appended after the trailer (`appended`; a patch cannot carry it, only --discard-ui-edits drops it).
 */
export type DriftField = 'title' | 'description' | 'appended';

/** `{...block, ...patch}` with base and head from the PR (02 §3); arrays and refs replace whole. */
export function mergeEdit(
  block: Record<string, unknown>,
  pr: Pick<PrSnapshot, 'baseRefName' | 'headRefName'>,
  patch: Omit<PrEditInput, 'adopt' | 'draft'>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...block, base: pr.baseRefName, head: pr.headRefName };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) merged[k] = v;
  return merged;
}

export interface EditEnv {
  ctx: Context;
  repo: ResolvedRepo;
  config: GhxConfig;
  number: number;
  /** The patch fields that parsed (check.ts); the ones that did not are in `issues`. */
  patch: PrEditInput;
  /** The patch's own VALIDATION issues (unknown keys, structure), reported with the merged ones. */
  issues?: readonly IssueDetail[];
  discardUiEdits: boolean;
}

export interface EditPlan {
  ref: string;
  snapshot: PrSnapshot;
  /**
   * The merged, validated object (refs.stackedOn re-derived when the patch left refs alone); null for a
   * draft or base change alone, which leaves the body as it is.
   */
  input: PrCreateInput | null;
  /** The title and base after the edit. */
  title: string;
  base: string;
  /** null when the PR has no ghx block (a draft or base change alone). */
  blockId: string | null;
  rev: number | null;
  adopted: boolean;
  /** The body after the edit (the current one when nothing in it changes). */
  body: string;
  /** The REST PATCH fields that differ from the PR. */
  rest: { title?: string; body?: string; base?: string };
  /** The draft state to set, or null when it does not change. */
  draft: boolean | null;
  changed: EditField[];
  warnings: Warning[];
}

function noBlock(ref: string, why: string, details: Record<string, unknown> | null, adoptable = true): GhxError {
  return new GhxError('NO_BLOCK', `${ref} ${why}.`, {
    hint: adoptable
      ? 'Adopt it: pass the full object (title, description, testing, risk, components, revertPolicy) with "adopt": true. components takes up to 5; past that, the 5 primary ones (ghx records the rest).'
      : 'Upgrade ghx; this version cannot rewrite a newer block.',
    ...(details === null ? {} : { details }),
  });
}

/** The reads, the merge and every check. State failures throw; every VALIDATION issue throws at once. */
export async function planEdit(env: EditEnv): Promise<EditPlan> {
  const { ctx, config, number, discardUiEdits } = env;
  const repo = env.repo.repo;
  const slug = repoSlug(repo);
  const ref = formatPrRef(repo, number);
  const warnings: Warning[] = [];
  const issues: IssueDetail[] = [...(env.issues ?? [])];
  const { adopt, draft: draftPatch, ...patch } = env.patch;
  const contentKeys = Object.keys(patch).filter((k) => patch[k as keyof typeof patch] !== undefined);

  const pr = await fetchPrSnapshot(ctx.gh, repo, number);
  if (pr.state !== 'OPEN') {
    throw new GhxError('PR_NOT_OPEN', `${ref} is ${pr.state}.`, {
      hint: 'Reopen it in the UI or create a new PR.',
      details: { state: pr.state },
    });
  }
  const draft = draftPatch !== undefined && draftPatch !== pr.isDraft ? draftPatch : null;

  // A draft toggle alone writes nothing in the body: no block, adoption or content check is needed.
  if (contentKeys.length === 0 && adopt !== true) {
    if (issues.length > 0) throw validationError(issues, null, EDIT_EXAMPLE_HINT);
    return lightPlan(pr, ref, { base: pr.baseRefName, draft, warnings });
  }

  // The block (02 §9.2): the first valid one. Without one, only a base change or an adoption proceeds.
  const read = readPrBlock(pr.body);
  warnings.push(...read.warnings);
  let block: PrBlockRead | null = null;
  if (read.status === 'ok') block = read.block;
  else if (read.status === 'invalid' && read.code === 'SCHEMA_NEWER') {
    throw noBlock(ref, `has a ghx block from a newer schema (${read.error})`, { blockError: read.error }, false);
  } else if (adopt !== true) {
    if (contentKeys.length === 1 && patch.base !== undefined) {
      return baseOnlyPlan(env, pr, ref, { base: patch.base, draft, draftPatch, warnings, issues });
    }
    throw read.status === 'invalid'
      ? noBlock(ref, `has an invalid ghx metadata block (${read.error})`, { blockError: read.error })
      : noBlock(ref, 'has no ghx metadata block', null);
  }

  // UI edits (02 §3 DESCRIPTION_DRIFT): visible prose or title edited outside ghx that the patch would
  // silently overwrite with the block's copy. The trailer is derived, so it is simply re-rendered.
  if (block !== null) {
    const parsedBody = parsePrBody(pr.body, { footer: config.render.footer });
    const bodyDrift = prBodyDrift(pr.body, block, config.render, pr.title);
    const drift: DriftField[] = bodyDrift.filter(
      (f): f is 'title' | 'description' => f === 'title' || f === 'description',
    );
    if (bodyDrift.includes('trailer')) {
      warnings.push({
        code: 'TRAILER_UI_EDIT_DISCARDED',
        message: `The trailer line of ${ref} was edited outside ghx; it is derived from the block, so the edit re-renders it. Put lasting changes in the patch (risk, components, testing, revertPolicy).`,
      });
    }
    const footer = config.render.footer?.replace(/\r\n?/g, '\n').trim() || null;
    // The tail after the trailer is the footer the PR was rendered with. The block does not record it, so
    // a render.footer change since then (or a PR rendered with none) must not read as a UI edit: a single
    // footer-shaped line is taken as the old footer and replaced, with a warning so that a one-line UI
    // addition there is not lost silently. Anything longer is still `appended`.
    const tail = parsedBody.trailer === null ? null : parsedBody.footer;
    if (tail !== null && tail !== footer) {
      if (footerShaped(tail)) {
        warnings.push({
          code: 'FOOTER_REPLACED',
          message: `The line after the trailer ('${tail}') is not the current render.footer; it is taken as an earlier footer and ${footer === null ? 'dropped (render.footer is null)' : 'replaced by the current one'}.`,
        });
      } else {
        drift.push('appended');
      }
    }
    const unresolved = drift.filter((f) => f === 'appended' || patch[f] === undefined);
    if (unresolved.length > 0) {
      const visible = parsedBody.description;
      if (!discardUiEdits) {
        throw new GhxError(
          'DESCRIPTION_DRIFT',
          `The visible ${unresolved.join(' and ')} of ${ref} ${unresolved.length === 1 ? 'was' : 'were'} edited outside ghx.`,
          {
            hint: unresolved.includes('appended')
              ? 'Text was added after the trailer; move what matters into "description" in the patch, then pass --discard-ui-edits.'
              : `Include ${unresolved.map((f) => `"${f}"`).join(' and ')} in the patch (the current visible text is in details), or pass --discard-ui-edits.`,
            details: {
              drift: unresolved,
              visible,
              title: pr.title,
              ...(unresolved.includes('appended') ? { appended: parsedBody.footer } : {}),
            },
          },
        );
      }
      warnings.push({
        code: 'UI_EDITS_DISCARDED',
        message: `--discard-ui-edits: the ${unresolved.join(' and ')} edited outside ghx ${unresolved.length === 1 ? 'is' : 'are'} replaced by the block's.`,
      });
    }
  }

  // Merge; aliases (an old component name in the block included) map to component names. Then each field's
  // structure, so the rules run on whatever parsed.
  const merged = mergeEdit(block === null ? {} : blockContent(block), pr, patch);
  warnings.push(...normalizeComponents(merged, config, { addScope: false }));
  const s = structureIssues(merged, PrCreateInput, [
    'title',
    'description',
    'testing',
    'risk',
    'components',
    'revertPolicy',
    'base',
    'head',
  ]);
  issues.push(...s.issues);
  let input: PartialRulesInput = s.parsed;

  // The network checks of 02 §2.1 on the merged object, through the create preflight and compare. The
  // head is the PR's own: its open PR is this one, so the duplicate check does not apply. A state failure
  // here rides beside the VALIDATION issues, as in pr create.
  const base = input.base ?? pr.baseRefName;
  let pf: Preflight | null = null;
  let blocked: GhxError | null = null;
  try {
    pf = await runPreflight(ctx.gh, repo, { base, head: pr.headRefName, refs: collectRefs(input).map((r) => r.ref) });
    assertMayEdit(pr, pf, ref, slug, base);
  } catch (e) {
    if (!(e instanceof GhxError)) throw e;
    blocked = e;
  }

  let alsoTouched: string[] = [];
  let stacked = false;
  let baseParent: string | null = null;
  if (pf !== null && blocked === null) {
    const headOid = pf.headOid ?? pr.headRefOid;
    // The stack (02 §2.4) follows the actual base unless the patch sets refs itself: after a retarget
    // (by the patch, or GitHub's own when the parent merged [G-RETARGET]) the old stackedOn is stale.
    stacked = base !== pf.defaultBranch;
    baseParent = pf.baseParent ? `#${pf.baseParent.number}` : null;
    if (patch.refs === undefined) {
      const want = stacked ? baseParent : null;
      const have = input.refs?.stackedOn ?? null;
      const same = want !== null && have !== null && canonicalRef(want, slug) === canonicalRef(have, slug);
      if (!same && want !== have) {
        const { stackedOn: _old, ...rest } = input.refs ?? {};
        const refs = want === null ? rest : { ...rest, stackedOn: want };
        const { refs: _drop, ...noRefs } = input;
        input = Object.keys(refs).length > 0 ? { ...noRefs, refs } : noRefs;
        warnings.push({
          code: 'STACKED_ON_UPDATED',
          message:
            want === null
              ? `stackedOn ${have} was dropped: the base '${base}' is ${stacked ? 'not the head of an open PR' : 'the default branch'}.`
              : `stackedOn is now ${want} (was ${have ?? 'empty'}): the open PR whose head is the base '${base}'.`,
        });
      }
      // Only when the base moves: a PR that already sits on such a base was warned when it got there.
      if (stacked && baseParent === null && base !== pr.baseRefName) {
        warnings.push({
          code: 'BASE_NOT_A_PR',
          message: `The base '${base}' is not the default branch '${pf.defaultBranch}' and no open PR has it as head; stackedOn is left empty.`,
        });
      }
    }
    if (input.refs?.stackedOn !== undefined && base === pf.defaultBranch) {
      issues.push({
        path: 'refs.stackedOn',
        code: 'refs.stacked_on_default_base',
        message: `a PR based on the default branch '${pf.defaultBranch}' is not stacked; drop stackedOn or set base to the parent's head`,
      });
    }
    const files = await changedFiles(ctx.gh, isLocalTarget(env.repo) ? ctx.git : null, repo, pf.baseOid ?? '', headOid);
    const net = createNetworkRules({ ...input, base, components: input.components ?? [] }, config, {
      repo: slug,
      changedFiles: files.files,
      baseParent,
      missingRefs: pf.missingRefs,
    });
    issues.push(...net.issues);
    warnings.push(...net.warnings);
    if (input.components !== undefined || net.components.length > 0) input = { ...input, components: net.components };
    // 06: derived again from the diff; when the diff is unknown, the block's record stands (old names mapped).
    alsoTouched = net.alsoTouched;
    if (files.files === null) {
      alsoTouched = (block?.alsoTouched ?? [])
        .map((n) => resolveComponent(n, config.components))
        .filter((n): n is string => n !== null && !(input.components ?? []).includes(n));
      issues.push(...alsoTouchedFloor(input, config, alsoTouched));
    }
  }
  issues.push(...partialRules(input, { config }, s.testingAt));
  // Sent now, so they survive a VALIDATION failure; the plan carries only the ones added after this.
  for (const w of warnings.splice(0)) ctx.warn(w);
  if (issues.length > 0) throw validationError(issues, blocked, EDIT_EXAMPLE_HINT);
  if (blocked !== null) throw blocked;
  const full = PrCreateInput.parse(input);

  const baseChanged = full.base !== pr.baseRefName;
  if (baseChanged) warnings.push(...(await childrenWarning(ctx, repo, pr, ref)));
  if (stacked && !(draftPatch ?? pr.isDraft) && (draftPatch === false || baseChanged)) {
    warnings.push({
      code: 'STACKED_NOT_DRAFT',
      message: `The PR is stacked on '${full.base}' but is not a draft; it may be merged before its parent.`,
    });
  }

  // Render. rev+1 only when the block or body changes, so re-running the same edit is a no-op.
  const blockId = block?.id ?? newId('pr', ctx.random);
  let rev = block === null ? 1 : block.rev + 1;
  let body = renderPrBody(toPrBlock(full, { id: blockId, rev, alsoTouched }), config.render);
  if (block !== null && sameAsBefore(full, alsoTouched, block, config, pr.body)) {
    rev = block.rev;
    body = pr.body;
  }

  const rest: EditPlan['rest'] = {};
  if (full.title !== pr.title) rest.title = full.title;
  if (body !== pr.body) rest.body = body;
  if (baseChanged) rest.base = full.base;
  return {
    ref,
    snapshot: pr,
    input: full,
    title: full.title,
    base: full.base,
    blockId,
    rev,
    adopted: block === null,
    body,
    rest,
    draft,
    changed: changedOf(rest, draft),
    warnings,
  };
}

function changedOf(rest: EditPlan['rest'], draft: boolean | null): EditField[] {
  const changed: EditField[] = [];
  if (rest.title !== undefined) changed.push('title');
  if (rest.body !== undefined) changed.push('body');
  if (rest.base !== undefined) changed.push('base');
  if (draft !== null) changed.push('draft');
  return changed;
}

/** GitHub lets anyone with push access, or the PR's author, edit a PR (02 §6.2); and the base must exist. */
function assertMayEdit(pr: PrSnapshot, pf: Preflight, ref: string, slug: string, base: string): void {
  // Who may edit (02 §6.2, mirroring pr create): GitHub lets anyone with push access edit a PR, and lets a
  // PR's author edit their own PR's title, body, base and draft state whatever their repository role (the
  // REST update rule is write access to the head branch, which the author of a same-repo PR pushed). So
  // READ/TRIAGE is GH_FORBIDDEN unless the viewer opened this PR; checked before anything is rendered,
  // so a dry run fails the same way.
  const isAuthor = pr.author != null && pr.author.login.toLowerCase() === pf.viewer.toLowerCase();
  if (!isAuthor && (pf.permission === null || !PUSH_PERMISSIONS.has(pf.permission))) {
    throw new GhxError(
      'GH_FORBIDDEN',
      `You cannot edit ${ref}: viewerPermission ${pf.permission ?? 'NONE'} on ${slug}, and the PR was opened by ${pr.author?.login ?? 'a deleted account'}, not ${pf.viewer}.`,
      {
        hint: 'Ask for write access, or ask the PR author to make the edit.',
        details: { permission: pf.permission, author: pr.author?.login ?? null, viewer: pf.viewer },
      },
    );
  }
  if (pf.baseOid === null) {
    throw new GhxError('BRANCH_MISSING', `Base branch '${base}' does not exist on ${slug}.`, {
      hint: 'Check the name, or create and push the base first.',
      details: { branch: base },
    });
  }
}

async function childrenWarning(
  ctx: Context,
  repo: ResolvedRepo['repo'],
  pr: PrSnapshot,
  ref: string,
): Promise<Warning[]> {
  const children = await openChildren(ctx.gh, repo, pr.headRefName);
  if (children.length === 0) return [];
  return [
    {
      code: 'HAS_CHILDREN',
      message: `${children.map((n) => `#${n}`).join(', ')} ${children.length === 1 ? 'is' : 'are'} stacked on ${ref} (base '${pr.headRefName}'); check ${children.length === 1 ? 'it' : 'them'} after the retarget.`,
    },
  ];
}

/** A plan that leaves the title and body alone: a draft toggle, or a retarget of a PR without a block. */
function lightPlan(
  pr: PrSnapshot,
  ref: string,
  o: { base: string; draft: boolean | null; warnings: Warning[] },
): EditPlan {
  const rest: EditPlan['rest'] = o.base !== pr.baseRefName ? { base: o.base } : {};
  const read = readPrBlock(pr.body);
  return {
    ref,
    snapshot: pr,
    input: null,
    title: pr.title,
    base: o.base,
    blockId: read.status === 'ok' ? read.block.id : null,
    rev: read.status === 'ok' ? read.block.rev : null,
    adopted: false,
    body: pr.body,
    rest,
    draft: o.draft,
    changed: changedOf(rest, o.draft),
    warnings: o.warnings,
  };
}

/**
 * `{"base": …}` (with or without draft) on a PR that has no ghx block: a retarget, which writes no body, so
 * nothing needs adopting. The base must exist and the viewer may edit; the stack warnings still apply.
 */
async function baseOnlyPlan(
  env: EditEnv,
  pr: PrSnapshot,
  ref: string,
  o: {
    base: string;
    draft: boolean | null;
    draftPatch: boolean | undefined;
    warnings: Warning[];
    issues: IssueDetail[];
  },
): Promise<EditPlan> {
  if (o.issues.length > 0) throw validationError(o.issues, null, EDIT_EXAMPLE_HINT);
  const { ctx } = env;
  const repo = env.repo.repo;
  const pf = await runPreflight(ctx.gh, repo, { base: o.base, head: pr.headRefName, refs: [] });
  assertMayEdit(pr, pf, ref, repoSlug(repo), o.base);
  const warnings = [...o.warnings];
  const baseChanged = o.base !== pr.baseRefName;
  if (baseChanged) warnings.push(...(await childrenWarning(ctx, repo, pr, ref)));
  if (o.base !== pf.defaultBranch && !(o.draftPatch ?? pr.isDraft)) {
    warnings.push({
      code: 'STACKED_NOT_DRAFT',
      message: `The PR is stacked on '${o.base}' but is not a draft; it may be merged before its parent.`,
    });
  }
  return lightPlan(pr, ref, { base: o.base, draft: o.draft, warnings });
}

/** True when re-rendering the merged object with the block's own rev and gen gives the current body. */
function sameAsBefore(
  input: PrCreateInput,
  alsoTouched: readonly string[],
  block: PrBlockRead,
  config: GhxConfig,
  body: string,
): boolean {
  try {
    const meta = { id: block.id, rev: block.rev, gen: block.gen, alsoTouched };
    return renderPrBody(toPrBlock(input, meta), config.render) === body;
  } catch (e) {
    // An old gen the strict encoder rejects (INTERNAL) means the block is rewritten anyway.
    if (e instanceof GhxError) return false;
    throw e;
  }
}

/** One line that render.footer could have produced (02 §15: at most 500 chars, no HTML comment). */
function footerShaped(text: string): boolean {
  return text !== '' && !text.includes('\n') && [...text].length <= 500 && !text.includes('<!--');
}
