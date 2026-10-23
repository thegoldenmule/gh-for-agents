// ghx pr comment <pr> --input c.json [--close] (02 §7.1, 03 M11.1): a typed coordination comment (note,
// precondition, status, supersede) with its `comment` block. Flow: strict input → Q1 (state, ids) → ref
// lookup → render → POST issues/N/comments (--dry-run halts here) → optional PATCH state=closed.
import { z } from 'zod';
import { parseCommandOverrides } from '../../ci/rerun/overrides.ts';
import { isViewer } from '../../ci/rerun/retrigger.ts';
import { defineCommand } from '../../core/command.ts';
import { rethrowControlFlow } from '../../core/control-flow.ts';
import { GhxError, type IssueDetail, mapZodIssues } from '../../core/errors.ts';
import type { CommentBlock } from '../../meta/schemas.ts';
import { validationError } from '../../pr/create/rules.ts';
import { commentRefs, PrCommentInput } from '../../pr/feedback-writes/comment-schema.ts';
import { assertBodySize } from '../../pr/feedback-writes/post.ts';
import { assertOpen, idAllocator, readPrForWrite, resolveTarget } from '../../pr/feedback-writes/read.ts';
import { fullRef, lookupRefs, type RefState } from '../../pr/feedback-writes/refs.ts';
import { renderCommentBody } from '../../render/comment.ts';
import { CommentId, PrRef } from '../../schemas/common.ts';
import { CommentKind, PreconditionStatus } from '../../schemas/pr.ts';
import { VERSION } from '../../version.ts';

const json = <T extends z.ZodType>(s: T) => s.meta({ jsonOnly: true });

const Input = z
  .strictObject({
    pr: z.string().min(1).describe('PR: 3198, #3198, owner/repo#3198 or a PR URL'),
    close: z.boolean().default(false).describe('Close the PR after commenting (not with a precondition)'),
    override: z.array(z.string().min(1)).optional().describe("AUTHOR_NOT_VIEWER: --close someone else's PR"),
    reason: z.string().optional().describe('Why the override is allowed (who asked); required with --override'),
    kind: json(z.enum(['note', 'precondition', 'status', 'supersede'])).optional(),
    body: json(z.string()).optional(),
    condition: json(z.unknown()).optional(),
    state: json(z.string()).optional(),
    refs: json(z.array(z.string())).optional(),
    by: json(z.string()).optional(),
  })
  .describe('A coordination comment (02 §7.1): {kind, …} through --input');

const Output = z.object({
  ref: PrRef,
  id: CommentId,
  kind: CommentKind,
  commentId: z.number().int(),
  url: z.string(),
  closed: z.boolean(),
  overrides: z.array(z.object({ code: z.literal('AUTHOR_NOT_VIEWER'), reason: z.string() })),
  precondition: z.object({ status: PreconditionStatus, evidence: z.string() }).nullable(),
});

const Posted = z.object({ id: z.number().int(), html_url: z.string() });

function preconditionAtCreate(
  c: PrCommentInput,
  id: string,
  refs: Map<string, RefState | null>,
  full: (r: string) => string | null,
): z.input<typeof Output>['precondition'] {
  if (c.kind !== 'precondition') return null;
  const cond = c.condition;
  if (cond.type === 'manual') {
    return { status: 'unknown', evidence: `manual: waiting for ghx pr resolve ${id} --status met --note "…"` };
  }
  const pr = refs.get(full(cond.ref) ?? '');
  if (cond.type === 'pr-merged' && pr) {
    if (pr.state === 'MERGED')
      return { status: 'met', evidence: `${cond.ref} merged at ${pr.mergedAt ?? 'unknown time'}` };
    return {
      status: 'unmet',
      evidence: pr.state === 'CLOSED' ? `${cond.ref} was closed without merging` : `${cond.ref} is open`,
    };
  }
  return { status: 'unknown', evidence: 'evaluated by ghx pr status and ghx pr merge' };
}

export default defineCommand({
  name: ['pr', 'comment'],
  summary: 'Post a typed coordination comment: note, merge precondition, status or supersede',
  description:
    'Write {kind, …} with your file tool and pass --input c.json. Kinds: note {body}; precondition ' +
    '{condition: {type: pr-merged|release-includes, ref} | {type: manual, text}}; status {state, body, refs?}; ' +
    'supersede {by}. Refs must exist and not be this PR. --close closes the PR (not with a precondition); ' +
    "on someone else's PR it is AUTHOR_NOT_VIEWER unless --override AUTHOR_NOT_VIEWER --reason.",
  kind: 'write',
  input: Input,
  output: Output,
  positionals: ['pr'],
  needs: { repo: 'inferred', config: 'none' },
  jsonInput: 'required',
  replaces: ['gh pr comment', 'gh pr close --comment'],
  examples: [
    {
      argv: 'ghx pr comment octo/demo#7 --input -',
      note: 'or --input c.json',
      input: { kind: 'precondition', condition: { type: 'pr-merged', ref: '#6' } },
    },
    { argv: 'ghx pr comment 7 --input note.json', note: '{"kind":"note","body":"…"}' },
    { argv: 'ghx pr comment 7 --input s.json --close', note: '{"kind":"supersede","by":"#9"}, then close' },
  ],
  async run(raw, ctx) {
    const t = await resolveTarget(ctx, raw.pr);
    const { pr: _pr, close, override, reason, ...fields } = raw;
    const overrides = parseCommandOverrides(override, reason, ['AUTHOR_NOT_VIEWER'] as const);
    const parsed = PrCommentInput.safeParse(fields);
    if (!parsed.success) throw validationError(mapZodIssues(parsed.error, { schema: PrCommentInput, input: fields }));
    const c = parsed.data;
    const full = (r: string) => fullRef(r, t.repo);
    const issues: IssueDetail[] = [];
    if (close && c.kind === 'precondition') {
      issues.push({
        path: 'close',
        code: 'comment.close_with_precondition',
        message: 'a precondition gates a future merge; it cannot be posted with --close',
      });
    }
    const refs = commentRefs(c);
    for (const r of refs) {
      if (full(r.ref)?.toLowerCase() === t.ref.toLowerCase()) {
        issues.push({ path: r.path, code: 'comment.ref_self', message: `${r.ref} is this PR` });
      }
    }
    if (issues.length > 0) throw validationError(issues);

    const pr = await readPrForWrite(ctx, t);
    assertOpen(t, pr);
    if (close && !isViewer(pr) && overrides === null) {
      throw new GhxError(
        'AUTHOR_NOT_VIEWER',
        `${t.ref} is authored by ${pr.authorLogin ?? 'a deleted user'}, not you (${pr.viewerLogin}); --close would close it.`,
        {
          hint: 'Only close your own PRs; if the user asked for this one, add --override AUTHOR_NOT_VIEWER --reason "<who asked>".',
          details: { author: pr.authorLogin },
        },
      );
    }
    const found = await lookupRefs(
      ctx.gh,
      t.repo,
      refs.map((r) => r.ref),
    );
    const missing = refs.filter((r) => found.get(full(r.ref) ?? '') == null);
    if (missing.length > 0) {
      const list = missing.map((r) => r.ref).join(', ');
      throw new GhxError(
        'REF_NOT_FOUND',
        `${missing.length === 1 ? 'Ref' : 'Refs'} ${list} ${missing.length === 1 ? 'does' : 'do'} not exist.`,
        {
          hint: 'Use an existing PR ref (owner/repo#N for cross-repo).',
          details: { missing: missing.map((r) => ({ path: r.path, ref: r.ref })) },
        },
      );
    }
    if (c.kind === 'supersede' && !close) {
      ctx.warn({
        code: 'SUPERSEDED_STILL_OPEN',
        message: `${t.ref} is marked superseded by ${c.by} but stays open; pass --close to close it.`,
      });
    }

    const id = idAllocator(ctx, pr).next('comment');
    const gen = `ghx/${VERSION}`;
    const block: Exclude<CommentBlock, { kind: 'resolve' }> =
      c.kind === 'note'
        ? { t: 'comment', id, gen, kind: 'note' }
        : c.kind === 'precondition'
          ? { t: 'comment', id, gen, kind: 'precondition', condition: c.condition }
          : c.kind === 'status'
            ? { t: 'comment', id, gen, kind: 'status', state: c.state, ...(c.refs?.length ? { refs: c.refs } : {}) }
            : { t: 'comment', id, gen, kind: 'supersede', by: c.by };
    const body = renderCommentBody(block, 'body' in c ? c.body : undefined);
    assertBodySize(body, 'comment');
    ctx.preview({ ref: t.ref, id, kind: c.kind, body, close });

    const posted = await ctx.gh.api(
      { method: 'POST', path: `repos/{owner}/{repo}/issues/${t.number}/comments`, repo: t.repo, body: { body } },
      Posted,
      { notFound: 'PR_NOT_FOUND' },
    );
    if (posted.notModified) throw new GhxError('INTERNAL', 'POST issues/comments returned 304.');
    let closed = false;
    if (close) {
      try {
        await ctx.gh.api(
          { method: 'PATCH', path: `repos/{owner}/{repo}/pulls/${t.number}`, repo: t.repo, body: { state: 'closed' } },
          z.unknown(),
          { notFound: 'PR_NOT_FOUND' },
        );
        closed = true;
      } catch (e) {
        rethrowControlFlow(e);
        if (!(e instanceof GhxError)) throw e;
        throw new GhxError(
          e.code,
          `The comment was posted (${posted.data.html_url}), but closing ${t.ref} failed: ${e.message}`,
          {
            hint: `Do not re-run (the comment would repeat); close ${t.ref} in the GitHub UI.`,
            details: { ...(e.details ?? {}), commentId: posted.data.id, url: posted.data.html_url },
            cause: e,
          },
        );
      }
    }
    return {
      ref: t.ref,
      id,
      kind: c.kind,
      commentId: posted.data.id,
      url: posted.data.html_url,
      closed,
      overrides: overrides ? [{ code: 'AUTHOR_NOT_VIEWER' as const, reason: overrides.reason }] : [],
      precondition: preconditionAtCreate(c, id, found, full),
    };
  },
});
