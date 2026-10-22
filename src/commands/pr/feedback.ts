// ghx pr feedback <pr> (02 §5; 03 M6.7): the full feedback from all three GitHub sources, filterable. Inline
// bodies are capped at 2,000 chars; the same document with every body in full is always written to
// artifactPath. Reads through the PR snapshot (no mergeable retry), so facts and trust match pr status.
import { z } from 'zod';
import { defineCommand } from '../../core/command.ts';
import { GhxError } from '../../core/errors.ts';
import { fetchPrSnapshot } from '../../pr/snapshot/index.ts';
import { filterFeedback } from '../../pr/status/feedback.ts';
import { PrFeedbackOutput } from '../../pr/status/schema.ts';
import { prContext, rethrowNotFound } from '../../pr/status/target.ts';
import { capFeedback } from '../../pr/status/truncate.ts';

/** 02 §5: bodies inline are capped at 2,000 chars. */
export const FEEDBACK_BODY_CAP = 2000;

const ISO = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const SHA = /^[0-9a-f]{7,40}$/;

const Input = z.strictObject({
  pr: z.string().min(1).describe('PR: 3198, #3198, owner/repo#3198 or a PR URL'),
  open: z
    .boolean()
    .default(false)
    .describe('Only what is still open: open findings, unresolved human threads, unmet preconditions, change requests'),
  source: z.enum(['ghx', 'human', 'bot']).optional().describe('Only ghx (structured), human or bot items'),
  since: z.string().min(1).optional().describe("Only items newer than an ISO time or a commit SHA's date"),
  includeOutdated: z.boolean().default(false).describe('With --open, keep findings on outdated lines too'),
});

const CommitDate = z.object({
  commit: z.object({
    committer: z.object({ date: z.string() }).nullable(),
    author: z.object({ date: z.string() }).nullable(),
  }),
});

export default defineCommand({
  name: ['pr', 'feedback'],
  summary: 'All PR feedback (reviews, findings, comments, bots), filterable; full bodies in a file',
  description:
    'Folds issue comments, reviews and inline threads into reviews, findings, comments and bots; unstructured ' +
    'items are kept with structured:false. --open keeps what still needs action. Bodies are capped at 2,000 ' +
    'chars inline; artifactPath holds the same document with every body in full.',
  kind: 'read',
  input: Input,
  positionals: ['pr'],
  output: PrFeedbackOutput,
  needs: { repo: 'inferred', config: 'optional' },
  timeout: { defaultMs: 60_000, maxMs: 300_000 },
  replaces: [
    'gh pr view --comments',
    'gh api repos/{o}/{r}/pulls/{n}/comments',
    'gh api repos/{o}/{r}/issues/{n}/comments',
  ],
  examples: [
    { argv: 'ghx pr feedback 3301 -R powerhouse-inc/powerhouse --open', note: 'What is still open on #3301' },
    { argv: 'ghx pr feedback owner/repo#12 --source human', note: 'Only human, unstructured feedback' },
    { argv: 'ghx pr feedback 12 --since 9f2c4e1', note: 'Only feedback newer than that commit' },
  ],
  async run(input, ctx) {
    const sinceKind =
      input.since === undefined ? null : SHA.test(input.since) ? 'sha' : ISO.test(input.since) ? 'iso' : null;
    if (
      input.since !== undefined &&
      (sinceKind === null || (sinceKind === 'iso' && !Number.isFinite(Date.parse(input.since))))
    ) {
      throw new GhxError('VALIDATION', `--since '${input.since}' is neither an ISO time nor a commit SHA.`, {
        hint: 'Use --since 2026-10-21T16:00:00Z or --since 9f2c4e1.',
        details: {
          issues: [{ path: 'since', code: 'since.format', message: 'expected an ISO time or 7–40 hex chars' }],
        },
      });
    }
    const { resolved, number, config, warnings } = await prContext(ctx, input.pr);
    const repo = resolved.repo;
    let snapshot: Awaited<ReturnType<typeof fetchPrSnapshot>>;
    try {
      snapshot = await fetchPrSnapshot({
        gh: ctx.gh,
        clock: ctx.clock,
        signal: ctx.signal,
        repo,
        number,
        config: { ci: { ignore: config.ci.ignore }, trust: config.trust, bots: config.bots },
        waitMergeable: false,
        blockOnSeverity: config.merge.blockOnSeverity,
      });
    } catch (e) {
      rethrowNotFound(e, resolved, number, 'feedback');
    }
    let since: number | undefined;
    if (input.since !== undefined && sinceKind === 'sha') {
      const r = await ctx.gh.api({ path: `repos/{owner}/{repo}/commits/${input.since}`, repo }, CommitDate, {
        notFound: 'REF_NOT_FOUND',
      });
      if (r.notModified) throw new Error('unreachable: unconditional request returned 304');
      const date = r.data.commit.committer?.date ?? r.data.commit.author?.date;
      if (!date) throw new GhxError('GH_OUTPUT_UNEXPECTED', `Commit ${input.since} has no date.`);
      since = Date.parse(date);
    } else if (input.since !== undefined) {
      since = Date.parse(input.since);
    }

    const view = filterFeedback(snapshot.feedback, {
      open: input.open,
      source: input.source,
      since,
      includeOutdated: input.includeOutdated,
      blockOnSeverity: config.merge.blockOnSeverity,
    });
    const all = [...warnings, ...snapshot.warnings, ...snapshot.feedback.warnings];
    const full = { ref: snapshot.ref, headSha: snapshot.head.sha, ...view, warnings: all };
    const tag = [
      input.open ? 'open' : '',
      input.source ?? '',
      input.includeOutdated ? 'outdated' : '',
      input.since ? `since-${input.since.replace(/[^\w]+/g, '')}` : '',
    ].filter((x) => x !== '');
    const artifact = await ctx.artifacts.write({
      kind: 'feedback',
      name: `pr-${number}-${snapshot.head.sha.slice(0, 7)}${tag.length ? `-${tag.join('-')}` : ''}.json`,
      content: `${JSON.stringify(full, null, 2)}\n`,
      repo,
    });
    const cap = { comment: FEEDBACK_BODY_CAP, finding: FEEDBACK_BODY_CAP, summary: FEEDBACK_BODY_CAP };
    return { ...full, feedback: capFeedback(view.feedback, cap), artifactPath: artifact.path };
  },
});
