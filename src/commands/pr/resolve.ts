// ghx pr resolve <pr> <id>… --status S [--commit sha] [--note "…"] [--tracking #N] (02 §7.3, §9.4; 03 M11.3):
// append `resolve` status events. Never edits a comment. Ids must be findings or preconditions the fold
// trusts (an untrusted author's block is not an id). An inline finding gets a thread reply, then a
// best-effort resolveReviewThread (unresolve for `open`); everything else shares one issue comment.
// An id already in the requested status is skipped with ALREADY_IN_STATUS (exit 0).
import { z } from 'zod';
import { defineCommand } from '../../core/command.ts';
import { rethrowControlFlow } from '../../core/control-flow.ts';
import { GhxError, type IssueDetail } from '../../core/errors.ts';
import { foldFeedback } from '../../feedback/fold.ts';
import type { CommentBlock } from '../../meta/schemas.ts';
import { validationError } from '../../pr/create/rules.ts';
import { assertBodySize } from '../../pr/feedback-writes/post.ts';
import { idAllocator, readPrForWrite, resolveTarget } from '../../pr/feedback-writes/read.ts';
import {
  checkCommitInPr,
  offlineResolveIssues,
  RESOLVE_STATUSES,
  statusIssue,
} from '../../pr/feedback-writes/resolve.ts';
import { renderResolveComment, renderResolveReply } from '../../render/comment.ts';
import { IssueRef, OneLine, PrRef, ShaInput } from '../../schemas/common.ts';
import { VERSION } from '../../version.ts';

type ResolveBlock = Extract<CommentBlock, { kind: 'resolve' }>;
type Target = ResolveBlock['targets'][number];

const Input = z.strictObject({
  pr: z.string().min(1).describe('PR: 3198, #3198, owner/repo#3198 or a PR URL'),
  ids: z.array(z.string().min(1)).min(1).max(50).describe('Finding (f_…) or precondition (c_…) ids'),
  status: z
    .enum(RESOLVE_STATUSES)
    .describe('Findings: addressed|wontfix|deferred|open; preconditions: met|withdrawn|unmet'),
  commit: ShaInput.optional().describe('The fix commit (required for addressed); must be in the PR'),
  note: OneLine(200).optional().describe('One line, ≤200 chars (required for wontfix, deferred, met, withdrawn)'),
  tracking: IssueRef.optional().describe('Issue tracking deferred work: #N or owner/repo#N'),
});

const Output = z.object({
  ref: PrRef,
  events: z.array(
    z.object({
      id: z.string(),
      from: z.string(),
      to: z.string(),
      commentId: z.number().int(),
      url: z.string(),
      /** null when the item is not an inline finding (or its thread could not be found). */
      threadResolved: z.boolean().nullable(),
    }),
  ),
});

const Posted = z.looseObject({ id: z.number().int(), html_url: z.string() });
const ThreadResult = z.looseObject({});
const RESOLVE_THREAD = 'mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{isResolved}}}';
const UNRESOLVE_THREAD =
  'mutation($threadId:ID!){unresolveReviewThread(input:{threadId:$threadId}){thread{isResolved}}}';

interface Plan {
  id: string;
  from: string;
  target: Target;
  thread: { id: string; rootDatabaseId: number; isResolved: boolean } | null;
}

export default defineCommand({
  name: ['pr', 'resolve'],
  summary: 'Set the status of findings or preconditions (append-only event; resolves the review thread)',
  description:
    'addressed needs --commit (in the PR); wontfix, deferred, met and withdrawn need --note. Ids come from ' +
    'ghx pr feedback. An inline finding gets a thread reply and its thread resolved; others get one issue comment.',
  kind: 'write',
  input: Input,
  output: Output,
  positionals: ['pr', 'ids'],
  needs: { repo: 'inferred', config: 'optional' },
  examples: [
    { argv: 'ghx pr resolve octo/demo#7 f_h4x8pz --status addressed --commit bbbbbbb', note: 'after pushing the fix' },
    { argv: 'ghx pr resolve 7 f_n2c6rv --status wontfix --note "The id is logged one frame up."' },
    {
      argv: 'ghx pr resolve 7 c_a1b2c3 --status met --note "Ops confirmed the window."',
      note: 'a manual precondition',
    },
  ],
  async run(input, ctx) {
    const t = await resolveTarget(ctx, input.pr);
    const ids = [...new Set(input.ids)];
    const offline = offlineResolveIssues(input);
    if (offline.length > 0) throw validationError(offline);
    const { config } = await ctx.config({ ref: t.repo });

    const pr = await readPrForWrite(ctx, t);
    const fold = foldFeedback(pr.feedbackInput({ trust: config.trust, bots: config.bots }));
    const findings = new Map(fold.feedback.findings.map((f) => [f.id, f]));
    const preconditions = new Map(fold.preconditions.map((p) => [p.id, p]));
    const unknown = ids.filter((id) => !findings.has(id) && !preconditions.has(id));
    if (unknown.length > 0) {
      const known = [...findings.keys(), ...preconditions.keys()];
      throw new GhxError('ID_NOT_FOUND', `No finding or precondition ${unknown.join(', ')} on ${t.ref}.`, {
        hint: `List ids: ghx pr feedback ${t.ref} --open`,
        details: { known: known.slice(0, 50), missing: unknown },
      });
    }
    const issues = ids
      .map((id) => statusIssue(id, findings.has(id) ? 'finding' : 'precondition', input.status))
      .filter((i): i is IssueDetail => i !== null);
    let sha: string | undefined;
    if (issues.length === 0 && input.commit !== undefined) {
      const c = await checkCommitInPr(ctx.gh, t.repo, t.number, input.commit);
      if (c.ok) sha = c.sha;
      else issues.push(c.issue);
    }
    if (issues.length > 0) throw validationError(issues);

    const plans: Plan[] = [];
    for (const id of ids) {
      const finding = findings.get(id);
      const precondition = preconditions.get(id);
      const from = finding ? finding.status : (precondition?.override?.status ?? precondition?.status ?? 'unknown');
      const sameCommit = input.status !== 'addressed' || finding?.statusEvent?.commit === sha;
      if (from === input.status && sameCommit) {
        ctx.warn({ code: 'ALREADY_IN_STATUS', message: `${id} is already ${input.status}; nothing posted for it.` });
        continue;
      }
      const target: Target = {
        id,
        status: input.status,
        ...(sha !== undefined ? { commit: sha } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.tracking !== undefined ? { tracking: input.tracking } : {}),
      };
      let thread: Plan['thread'] = null;
      if (finding?.inline) {
        for (const th of pr.q1.threads) {
          const root = th.comments.nodes.find((n) => n.url === finding.url);
          if (root) thread = { id: th.id, rootDatabaseId: root.databaseId, isResolved: th.isResolved };
        }
      }
      plans.push({ id, from, target, thread });
    }
    if (plans.length === 0) return { ref: t.ref, events: [] };

    const alloc = idAllocator(ctx, pr);
    const gen = `ghx/${VERSION}`;
    const block = (targets: Target[]): ResolveBlock => ({
      t: 'comment',
      id: alloc.next('comment'),
      gen,
      kind: 'resolve',
      targets,
    });
    const replies = plans
      .filter((p) => p.thread !== null)
      .map((p) => ({ plan: p, body: renderResolveReply(block([p.target])) }));
    const rest = plans.filter((p) => p.thread === null);
    const issueBody = rest.length > 0 ? renderResolveComment(block(rest.map((p) => p.target))) : null;
    for (const r of replies) assertBodySize(r.body, 'reply');
    if (issueBody !== null) assertBodySize(issueBody, 'comment');
    ctx.preview({
      ref: t.ref,
      replies: replies.map((r) => ({ id: r.plan.id, inReplyTo: r.plan.thread?.rootDatabaseId, body: r.body })),
      comment: issueBody,
    });

    const events: z.input<typeof Output>['events'] = [];
    let current = '';
    try {
      for (const { plan, body } of replies) {
        current = plan.id;
        const thread = plan.thread as NonNullable<Plan['thread']>;
        const posted = await ctx.gh.api(
          {
            method: 'POST',
            path: `repos/{owner}/{repo}/pulls/${t.number}/comments/${thread.rootDatabaseId}/replies`,
            repo: t.repo,
            body: { body },
          },
          Posted,
          { notFound: 'ID_NOT_FOUND' },
        );
        if (posted.notModified) throw new GhxError('INTERNAL', 'POST replies returned 304.');
        const want = input.status !== 'open';
        let threadResolved = thread.isResolved;
        if (thread.isResolved !== want) {
          try {
            await ctx.gh.graphql(want ? RESOLVE_THREAD : UNRESOLVE_THREAD, { threadId: thread.id }, ThreadResult, {
              repo: t.repo,
              mutates: true,
            });
            threadResolved = want;
          } catch (e) {
            rethrowControlFlow(e);
            ctx.warn({
              code: 'THREAD_RESOLVE_FAILED',
              message: `Replied on ${plan.id}'s thread, but ${want ? 'resolving' : 'unresolving'} it failed: ${(e as Error).message}`,
            });
          }
        }
        events.push({
          id: plan.id,
          from: plan.from,
          to: input.status,
          commentId: posted.data.id,
          url: posted.data.html_url,
          threadResolved,
        });
      }
      if (issueBody !== null) {
        current = rest.map((p) => p.id).join(', ');
        const posted = await ctx.gh.api(
          {
            method: 'POST',
            path: `repos/{owner}/{repo}/issues/${t.number}/comments`,
            repo: t.repo,
            body: { body: issueBody },
          },
          Posted,
          { notFound: 'PR_NOT_FOUND' },
        );
        if (posted.notModified) throw new GhxError('INTERNAL', 'POST issues/comments returned 304.');
        for (const p of rest) {
          events.push({
            id: p.id,
            from: p.from,
            to: input.status,
            commentId: posted.data.id,
            url: posted.data.html_url,
            threadResolved: null,
          });
        }
      }
    } catch (e) {
      rethrowControlFlow(e);
      if (events.length === 0 || !(e instanceof GhxError)) throw e;
      throw new GhxError(
        'PARTIAL_FAILURE',
        `Posted ${events.length} status event(s); the write for ${current} failed: ${e.message}`,
        {
          hint: `Re-run for the rest only: ghx pr resolve ${t.ref} ${current} --status ${input.status} …`,
          details: { posted: events, failed: current, code: e.code },
          cause: e,
        },
      );
    }
    events.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    return { ref: t.ref, events };
  },
});
