// ghx pr review <pr> --input review.json [--expect-head <sha>] (02 §7.2, 03 M11.2): a real review with a
// verdict, inline findings and blocks, in one atomic POST. Flow: strict input + reviewRules → Q1 (state,
// head, author, viewer, ids) → HEAD_MOVED → pulls/N/files (path_not_in_pr, hunk placement) → render →
// POST pulls/N/reviews pinned to the head (--dry-run halts here) → map comment ids back to finding ids.
// On the viewer's own PR GitHub rejects APPROVE and REQUEST_CHANGES, so ghx posts COMMENT and keeps the
// verdict in the block (verdictDowngraded).
import { z } from 'zod';
import { defineCommand } from '../../core/command.ts';
import { rethrowControlFlow } from '../../core/control-flow.ts';
import { GhxError, type IssueDetail, mapZodIssues } from '../../core/errors.ts';
import { GhFailure } from '../../gh/index.ts';
import type { FindingBlock, ReviewBlock } from '../../meta/schemas.ts';
import { validationError } from '../../pr/create/rules.ts';
import { readPull } from '../../pr/create/submit.ts';
import { inHunk, parseHunks } from '../../pr/feedback-writes/hunks.ts';
import { assertBodySize, githubMessage } from '../../pr/feedback-writes/post.ts';
import { assertOpen, idAllocator, readPrForWrite, resolveTarget } from '../../pr/feedback-writes/read.ts';
import { PrReviewInput, reviewRules } from '../../pr/feedback-writes/review-schema.ts';
import { renderInlineFinding, renderReviewBody } from '../../render/review.ts';
import { FindingId, PrRef, ReviewId, Sha, ShaInput } from '../../schemas/common.ts';
import { Severity, Verdict } from '../../schemas/pr.ts';
import { VERSION } from '../../version.ts';

/** pulls/N/files pages of 100: GitHub lists at most 3,000 files. */
const FILE_PAGES = 30;

const json = <T extends z.ZodType>(s: T) => s.meta({ jsonOnly: true });

const Input = z
  .strictObject({
    pr: z.string().min(1).describe('PR: 3198, #3198, owner/repo#3198 or a PR URL'),
    expectHead: ShaInput.optional().describe('Refuse with HEAD_MOVED unless the head is this SHA'),
    verdict: json(z.string()).optional(),
    summary: json(z.string()).optional(),
    scope: json(z.string()).optional(),
    findings: json(z.array(z.unknown())).optional(),
  })
  .describe('A review (02 §7.2): {verdict, summary, scope?, findings[]} through --input');

const PostedAs = z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']);

const Output = z.object({
  ref: PrRef,
  id: ReviewId,
  githubReviewId: z.number().int(),
  url: z.string(),
  verdict: Verdict,
  postedAs: PostedAs,
  verdictDowngraded: z.boolean(),
  commit: Sha,
  findings: z.array(
    z.object({
      id: FindingId,
      severity: Severity,
      inline: z.boolean(),
      commentId: z.number().int().nullable(),
      url: z.string(),
    }),
  ),
});

const PrFile = z.looseObject({ filename: z.string(), status: z.string(), patch: z.string().optional() });
const PostedReview = z.looseObject({ id: z.number().int(), html_url: z.string() });
const ReviewComment = z.looseObject({ id: z.number().int(), body: z.string(), html_url: z.string() });

const EVENT = { approve: 'APPROVE', 'request-changes': 'REQUEST_CHANGES', comment: 'COMMENT' } as const;

export default defineCommand({
  name: ['pr', 'review'],
  summary: 'Post a review: verdict, inline findings in the diff, hidden blocks, pinned to the head',
  description:
    'Write {verdict, summary, scope?, findings[]} with your file tool and pass --input review.json. A finding ' +
    'goes inline only inside a diff hunk (else in the body, FINDING_NOT_INLINE). On your own PR the verdict ' +
    'posts as COMMENT (VERDICT_DOWNGRADED). --expect-head pins the head (HEAD_MOVED).',
  kind: 'write',
  input: Input,
  output: Output,
  positionals: ['pr'],
  needs: { repo: 'inferred', config: 'none' },
  jsonInput: 'required',
  replaces: ['gh pr review'],
  examples: [
    {
      argv: 'ghx pr review octo/demo#7 --input -',
      note: 'or --input review.json',
      input: {
        verdict: 'request-changes',
        summary: 'The banner never clears after a successful retry.',
        findings: [
          {
            severity: 'medium',
            path: 'src/banner.ts',
            line: 12,
            title: 'Banner state is never reset',
            body: 'onSuccess does not clear retrying, so the banner stays up.',
          },
        ],
      },
    },
    { argv: 'ghx pr review 7 --input review.json --expect-head 9f2c4e1', note: 'refuse if the head moved' },
  ],
  async run(raw, ctx) {
    const t = await resolveTarget(ctx, raw.pr);
    const { pr: _pr, expectHead, ...fields } = raw;
    const parsed = PrReviewInput.safeParse(fields);
    if (!parsed.success) throw validationError(mapZodIssues(parsed.error, { schema: PrReviewInput, input: fields }));
    const input = parsed.data;
    const offline = reviewRules(input);
    if (offline.length > 0) throw validationError(offline);

    const pr = await readPrForWrite(ctx, t);
    assertOpen(t, pr);
    const head = pr.headSha;
    if (expectHead !== undefined && !head.startsWith(expectHead)) {
      throw new GhxError('HEAD_MOVED', `Head is ${head.slice(0, 7)}, expected ${expectHead.slice(0, 7)}.`, {
        hint: `Re-check the new head: ghx pr status ${t.ref}, then retry with --expect-head ${head.slice(0, 7)}.`,
        details: { expected: expectHead, actual: head },
      });
    }

    const files = await ctx.gh.api(
      {
        path: `repos/{owner}/{repo}/pulls/${t.number}/files`,
        repo: t.repo,
        paginate: { maxPages: FILE_PAGES, perPage: 100 },
      },
      z.array(PrFile),
      { notFound: 'PR_NOT_FOUND' },
    );
    if (files.notModified) throw new GhxError('INTERNAL', 'GET pulls/files returned 304.');
    const byPath = new Map(files.data.map((f) => [f.filename, f]));
    const issues: IssueDetail[] = [];
    input.findings.forEach((f, i) => {
      if (!byPath.has(f.path) && !files.truncated) {
        issues.push({
          path: `findings[${i}].path`,
          code: 'finding.path_not_in_pr',
          message: `${f.path} is not in the diff`,
        });
      }
    });
    if (issues.length > 0) throw validationError(issues);

    const ids = idAllocator(ctx, pr);
    const gen = `ghx/${VERSION}`;
    const reviewId = ids.next('review');
    const blocks: { block: FindingBlock; inline: boolean }[] = input.findings.map((f) => {
      const block: FindingBlock = {
        t: 'finding',
        id: ids.next('finding'),
        gen,
        review: reviewId,
        severity: f.severity,
        path: f.path,
        line: f.line,
        ...(f.endLine !== undefined && f.endLine !== f.line ? { endLine: f.endLine } : {}),
        side: f.side,
        alsoAt: f.alsoAt,
        title: f.title,
        body: f.body,
        ...(f.suggestion !== undefined ? { suggestion: f.suggestion } : {}),
        commit: head,
      };
      const file = byPath.get(f.path);
      const inline = file !== undefined && inHunk(parseHunks(file.patch), f.side, f.line, block.endLine ?? f.line);
      if (!inline) {
        const why =
          file === undefined
            ? 'its file is beyond the 3,000 files GitHub lists'
            : file.patch === undefined
              ? 'GitHub shows no diff for its file'
              : `${f.side} line${block.endLine ? `s ${f.line}-${block.endLine}` : ` ${f.line}`} is outside the diff hunks`;
        ctx.warn({
          code: 'FINDING_NOT_INLINE',
          message: `Finding ${block.id} (${f.path}:${f.line}) goes in the review body: ${why}.`,
        });
      }
      return { block, inline };
    });

    const review: ReviewBlock = {
      t: 'review',
      id: reviewId,
      gen,
      verdict: input.verdict,
      summary: input.summary,
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      commit: head,
      findings: blocks.map((b) => b.block.id),
    };
    const selfReview = pr.authorLogin !== null && pr.authorLogin === pr.viewerLogin;
    const verdictDowngraded = selfReview && input.verdict !== 'comment';
    const event = verdictDowngraded ? 'COMMENT' : EVENT[input.verdict];
    if (verdictDowngraded) {
      ctx.warn({
        code: 'VERDICT_DOWNGRADED',
        message: `${t.ref} is your own PR; GitHub refuses ${EVENT[input.verdict]} there, so it is posted as COMMENT with verdict ${input.verdict} kept in the block.`,
      });
    }

    const body = renderReviewBody(
      review,
      blocks.map((b) => b.block),
      blocks.filter((b) => !b.inline).map((b) => b.block),
    );
    assertBodySize(body, 'review');
    const comments = blocks
      .filter((b) => b.inline)
      .map(({ block: f }) => {
        const text = renderInlineFinding(f);
        assertBodySize(text, `inline finding ${f.id}`);
        return f.endLine !== undefined
          ? { path: f.path, body: text, start_line: f.line, start_side: f.side, line: f.endLine, side: f.side }
          : { path: f.path, body: text, line: f.line, side: f.side };
      });
    const request = { commit_id: head, body, event, comments };
    // The head was read before pulls/N/files, and the placements above come from those files. A push in
    // between would pin the review to a commit whose diff the files no longer describe: re-check it.
    const now = (await readPull(ctx, t.repo, t.number)).head.sha;
    if (now !== head) {
      throw new GhxError(
        'HEAD_MOVED',
        `Head moved from ${head.slice(0, 7)} to ${now.slice(0, 7)} while the diff was read.`,
        {
          hint: `Re-check the new head: ghx pr status ${t.ref}, then re-run the review against it.`,
          details: { expected: head, actual: now },
        },
      );
    }
    ctx.preview({ ref: t.ref, id: reviewId, postedAs: event, verdictDowngraded, request });

    let posted: z.infer<typeof PostedReview>;
    try {
      const r = await ctx.gh.api(
        { method: 'POST', path: `repos/{owner}/{repo}/pulls/${t.number}/reviews`, repo: t.repo, body: request },
        PostedReview,
        { notFound: 'PR_NOT_FOUND' },
      );
      if (r.notModified) throw new GhxError('INTERNAL', 'POST pulls/reviews returned 304.');
      posted = r.data;
    } catch (e) {
      rethrowControlFlow(e);
      if (e instanceof GhFailure && e.failure.status === 422) {
        const why = githubMessage(e);
        throw new GhxError('REVIEW_REJECTED', `GitHub rejected the review: '${why}'.`, {
          hint: 'Re-run; ghx recomputes diff hunks against the current head.',
          details: { status: 422, github: why },
          cause: e,
        });
      }
      throw e;
    }

    // The review exists now: a failed id mapping only warns.
    const byFinding = new Map<string, { id: number; url: string }>();
    if (comments.length > 0) {
      try {
        const r = await ctx.gh.api(
          {
            path: `repos/{owner}/{repo}/pulls/${t.number}/reviews/${posted.id}/comments`,
            repo: t.repo,
            paginate: { maxPages: 5, perPage: 100 },
          },
          z.array(ReviewComment),
        );
        for (const c of r.notModified ? [] : r.data) {
          const m = /"id":"(f_[0-9a-hjkmnp-tv-z]{6})"/.exec(c.body);
          if (m?.[1]) byFinding.set(m[1], { id: c.id, url: c.html_url });
        }
      } catch (e) {
        rethrowControlFlow(e);
        ctx.warn({
          code: 'REVIEW_COMMENTS_UNMAPPED',
          message: `The review was posted, but its comments could not be read back (${(e as Error).message}); commentId is null.`,
        });
      }
    }

    return {
      ref: t.ref,
      id: reviewId,
      githubReviewId: posted.id,
      url: posted.html_url,
      verdict: input.verdict,
      postedAs: event,
      verdictDowngraded,
      commit: head,
      findings: blocks.map(({ block, inline }) => {
        const c = inline ? byFinding.get(block.id) : undefined;
        return {
          id: block.id,
          severity: block.severity,
          inline,
          commentId: c?.id ?? null,
          url: c?.url ?? posted.html_url,
        };
      }),
    };
  },
});
