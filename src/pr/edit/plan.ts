// `pr edit` planning (02 §3 gh calls 1–2): the snapshot, the block, drift, the merge of block and patch
// (arrays replace), the full createRules plus the network checks on the merged object, the stack, and the
// re-render with rev+1. Nothing here mutates; submit.ts re-reads, PATCHes, flips draft and reads back.
import type { GhxConfig } from '../../config/schema.ts';
import type { Context, Warning } from '../../core/command.ts';
import { GhxError, type IssueDetail, mapZodIssues } from '../../core/errors.ts';
import { suggest } from '../../core/suggest.ts';
import { formatPrRef } from '../../gh/refs.ts';
import type { ResolvedRepo } from '../../gh/repo.ts';
import { repoSlug } from '../../gh/types.ts';
import { newId } from '../../meta/ids.ts';
import { type PrBlockRead, readPrBlock } from '../../meta/schemas.ts';
import { parsePrBody, prBodyDrift, renderPrBody, toPrBlock } from '../../render/pr-body.ts';
import { isLocalTarget } from '../create/plan.ts';
import { changedFiles, PUSH_PERMISSIONS, runPreflight } from '../create/preflight.ts';
import {
  alsoTouchedFloor,
  canonicalRef,
  collectRefs,
  createNetworkRules,
  createRules,
  stripFooter,
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
  patch: PrEditInput;
  discardUiEdits: boolean;
}

export interface EditPlan {
  ref: string;
  snapshot: PrSnapshot;
  /** The merged, validated object (refs.stackedOn re-derived when the patch left refs alone). */
  input: PrCreateInput;
  blockId: string;
  rev: number;
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

/** The reads, the merge and every check. State failures and VALIDATION throw. */
export async function planEdit(env: EditEnv): Promise<EditPlan> {
  const { ctx, config, number, discardUiEdits } = env;
  const repo = env.repo.repo;
  const slug = repoSlug(repo);
  const ref = formatPrRef(repo, number);
  const warnings: Warning[] = [];
  const { adopt, draft: draftPatch, ...patch } = env.patch;
  // A harness footer at the end of the patched description is ghx's to render (stripFooter).
  if (patch.description !== undefined) {
    const stripped = stripFooter(patch.description, config);
    patch.description = stripped.description;
    if (stripped.warning !== null) warnings.push(stripped.warning);
  }

  const pr = await fetchPrSnapshot(ctx.gh, repo, number);
  if (pr.state !== 'OPEN') {
    throw new GhxError('PR_NOT_OPEN', `${ref} is ${pr.state}.`, {
      hint: 'Reopen it in the UI or create a new PR.',
      details: { state: pr.state },
    });
  }

  // The block (02 §9.2): the first valid one. Without one, only an adoption with the full object proceeds.
  const read = readPrBlock(pr.body);
  warnings.push(...read.warnings);
  let block: PrBlockRead | null = null;
  if (read.status === 'ok') block = read.block;
  else if (read.status === 'invalid' && read.code === 'SCHEMA_NEWER') {
    throw noBlock(ref, `has a ghx block from a newer schema (${read.error})`, { blockError: read.error }, false);
  } else if (adopt !== true) {
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

  // Merge, then structure (zod) and every offline rule, before the network.
  const merged = mergeEdit(block === null ? {} : blockContent(block), pr, patch);
  const parsed = PrCreateInput.safeParse(merged);
  if (!parsed.success) {
    throw validationError(
      mapZodIssues(parsed.error, { schema: PrCreateInput, input: merged, suggest: (w, c) => suggest(w, c) }),
    );
  }
  const offline = createRules(parsed.data, { config });
  if (offline.length > 0) throw validationError(offline);
  let input = parsed.data;

  // The network checks of 02 §2.1 on the merged object, through the create preflight and compare. The
  // head is the PR's own: its open PR is this one, so the duplicate check does not apply.
  const pf = await runPreflight(ctx.gh, repo, {
    base: input.base,
    head: input.head,
    refs: collectRefs(input).map((r) => r.ref),
  });
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
    throw new GhxError('BRANCH_MISSING', `Base branch '${input.base}' does not exist on ${slug}.`, {
      hint: 'Check the name, or create and push the base first.',
      details: { branch: input.base },
    });
  }
  const headOid = pf.headOid ?? pr.headRefOid;

  // The stack (02 §2.4) follows the actual base unless the patch sets refs itself: after a retarget
  // (by the patch, or GitHub's own when the parent merged [G-RETARGET]) the old stackedOn is stale.
  const stacked = input.base !== pf.defaultBranch;
  const baseParent = pf.baseParent ? `#${pf.baseParent.number}` : null;
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
            ? `stackedOn ${have} was dropped: the base '${input.base}' is ${stacked ? 'not the head of an open PR' : 'the default branch'}.`
            : `stackedOn is now ${want} (was ${have ?? 'empty'}): the open PR whose head is the base '${input.base}'.`,
      });
    }
    // Only when the base moves: a PR that already sits on such a base was warned when it got there.
    if (stacked && baseParent === null && input.base !== pr.baseRefName) {
      warnings.push({
        code: 'BASE_NOT_A_PR',
        message: `The base '${input.base}' is not the default branch '${pf.defaultBranch}' and no open PR has it as head; stackedOn is left empty.`,
      });
    }
  }

  const issues: IssueDetail[] = createRules(input, { config, defaultBranch: pf.defaultBranch }).filter(
    (i) => i.code === 'refs.stacked_on_default_base',
  );
  const files = await changedFiles(ctx.gh, isLocalTarget(env.repo) ? ctx.git : null, repo, pf.baseOid, headOid);
  const net = createNetworkRules(input, config, {
    repo: slug,
    changedFiles: files.files,
    baseParent,
    missingRefs: pf.missingRefs,
  });
  issues.push(...net.issues);
  warnings.push(...net.warnings);
  input = { ...input, components: net.components };
  // 06: derived again from the diff; when the diff is unknown, the block's record stands.
  let alsoTouched = net.alsoTouched;
  if (files.files === null) {
    alsoTouched = (block?.alsoTouched ?? []).filter(
      (n) => Object.hasOwn(config.components, n) && !input.components.includes(n),
    );
    issues.push(...alsoTouchedFloor(input, config, alsoTouched));
  }
  if (issues.length > 0) throw validationError(issues);

  const baseChanged = input.base !== pr.baseRefName;
  if (baseChanged) {
    const children = await openChildren(ctx.gh, repo, pr.headRefName);
    if (children.length > 0) {
      warnings.push({
        code: 'HAS_CHILDREN',
        message: `${children.map((n) => `#${n}`).join(', ')} ${children.length === 1 ? 'is' : 'are'} stacked on ${ref} (base '${pr.headRefName}'); check ${children.length === 1 ? 'it' : 'them'} after the retarget.`,
      });
    }
  }
  const draft = draftPatch !== undefined && draftPatch !== pr.isDraft ? draftPatch : null;
  if (stacked && !(draftPatch ?? pr.isDraft) && (draftPatch === false || baseChanged)) {
    warnings.push({
      code: 'STACKED_NOT_DRAFT',
      message: `The PR is stacked on '${input.base}' but is not a draft; it may be merged before its parent.`,
    });
  }

  // Render. rev+1 only when the block or body changes, so re-running the same edit is a no-op.
  const blockId = block?.id ?? newId('pr', ctx.random);
  let rev = block === null ? 1 : block.rev + 1;
  let body = renderPrBody(toPrBlock(input, { id: blockId, rev, alsoTouched }), config.render);
  if (block !== null && sameAsBefore(input, alsoTouched, block, config, pr.body)) {
    rev = block.rev;
    body = pr.body;
  }

  const rest: EditPlan['rest'] = {};
  if (input.title !== pr.title) rest.title = input.title;
  if (body !== pr.body) rest.body = body;
  if (baseChanged) rest.base = input.base;
  const changed: EditField[] = [];
  if (rest.title !== undefined) changed.push('title');
  if (rest.body !== undefined) changed.push('body');
  if (rest.base !== undefined) changed.push('base');
  if (draft !== null) changed.push('draft');

  return { ref, snapshot: pr, input, blockId, rev, adopted: block === null, body, rest, draft, changed, warnings };
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
