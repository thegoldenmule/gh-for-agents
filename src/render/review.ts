// A ghx review (02 §7.2, §14.3): the review body lists every finding and carries the `review` block plus
// a `finding` block per body-only finding, which is where the fold derives body-only findings from; an
// inline finding's comment carries its own block. Blocks go through the strict encodeBlock.
// A `suggestion` (not in 02's inline template) is rendered as a GitHub ```suggestion fence on an inline
// RIGHT-side comment; elsewhere it lives only in the block.
import { encodeBlock, type FindingBlock, type ReviewBlock } from '../meta/schemas.ts';
import { inlineCode, joinParagraphs } from './markdown.ts';

const where = (f: Pick<FindingBlock, 'path' | 'line' | 'endLine'>) =>
  inlineCode(`${f.path}:${f.line}${f.endLine !== undefined && f.endLine !== f.line ? `-${f.endLine}` : ''}`);

/** `2 findings (1 high, 0 medium, 1 low)`; `1 finding (…)`; `0 findings`. */
export function findingCount(findings: readonly Pick<FindingBlock, 'severity'>[]): string {
  const n = findings.length;
  const label = `${n} finding${n === 1 ? '' : 's'}`;
  if (n === 0) return label;
  const c = (s: string) => findings.filter((f) => f.severity === s).length;
  return `${label} (${c('high')} high, ${c('medium')} medium, ${c('low')} low)`;
}

/** The review body: header, summary, scope, the numbered findings, then the blocks (one per line). */
export function renderReviewBody(
  review: ReviewBlock,
  findings: readonly FindingBlock[],
  bodyOnly: readonly FindingBlock[],
): string {
  const list = findings.map((f, i) => `${i + 1}. **[${f.severity}]** ${where(f)} ${f.title}`).join('\n');
  const blocks = [encodeBlock(review), ...bodyOnly.map((f) => encodeBlock(f))].join('\n');
  return joinParagraphs([
    `**ghx review** · ${review.verdict} · ${findingCount(findings)}`,
    review.summary,
    review.scope !== undefined ? `Scope: ${review.scope}` : null,
    list,
    blocks,
  ]);
}

function suggestionFence(s: string): string {
  const longest = Math.max(2, ...(s.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}suggestion\n${s}\n${fence}`;
}

/** An inline finding's comment: bold title, body, suggestion, `Also at:`, then its block. */
export function renderInlineFinding(f: FindingBlock): string {
  return joinParagraphs([
    `**[${f.severity}] ${f.title}**`,
    f.body,
    f.suggestion !== undefined && f.side === 'RIGHT' ? suggestionFence(f.suggestion) : null,
    f.alsoAt.length > 0 ? `Also at: ${f.alsoAt.map((l) => where(l)).join(', ')}` : null,
    encodeBlock(f),
  ]);
}
