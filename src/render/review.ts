// A ghx review (02 §7.2, §14.3): the review body lists every finding and carries the `review` block plus
// a `finding` block per body-only finding, which is where the fold derives body-only findings from; an
// inline finding's comment carries its own block. Blocks go through the strict encodeBlock.
// A `suggestion` (not in 02's inline template) is rendered as a GitHub ```suggestion fence on an inline
// RIGHT-side comment; elsewhere it lives only in the block.
import { encodeBlock, type FindingBlock, type ReviewBlock } from '../meta/schemas.ts';
import { hasFindingLocation } from '../schemas/evidence.ts';
import { inlineCode, joinParagraphs } from './markdown.ts';

const where = (f: Pick<FindingBlock, 'path' | 'line' | 'endLine'>) =>
  inlineCode(`${f.path}:${f.line}${f.endLine !== undefined && f.endLine !== f.line ? `-${f.endLine}` : ''}`);

function renderEvidence(f: FindingBlock): string | null {
  if (f.evidence === undefined) return null;
  const url = f.evidence.url;
  // A bracketed, encoded destination cannot end the link or inject Markdown/HTML.
  const destination = url?.replace(/[<>\\\s]/g, (c) => encodeURIComponent(c));
  return joinParagraphs([
    `Evidence: ${inlineCode(f.evidence.source)}${destination ? ` ([source](<${destination}>))` : ''}`,
    f.evidence.quote
      .split('\n')
      .map((line) => `> ${line.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}`)
      .join('\n'),
  ]);
}

function renderBodyFinding(f: FindingBlock): string {
  return joinParagraphs([
    `**${inlineCode(f.id)} · [${f.severity}] ${f.title}**${hasFindingLocation(f) ? ` · ${where(f)}` : ''}`,
    f.body,
    f.source !== undefined ? `Source: ${inlineCode(f.source)}` : null,
    renderEvidence(f),
    f.suggestion !== undefined ? `Suggestion: ${f.suggestion}` : null,
    f.alsoAt.length > 0 ? `Also at: ${f.alsoAt.map(where).join(', ')}` : null,
  ]);
}

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
  const list = findings
    .map((f, i) => `${i + 1}. **[${f.severity}]** ${hasFindingLocation(f) ? `${where(f)} ` : ''}${f.title}`)
    .join('\n');
  const blocks = [encodeBlock(review), ...bodyOnly.map((f) => encodeBlock(f))].join('\n');
  return joinParagraphs([
    `**ghx review** · ${review.verdict} · ${findingCount(findings)}`,
    review.summary,
    review.scope !== undefined ? `Scope: ${review.scope}` : null,
    list,
    ...bodyOnly.map(renderBodyFinding),
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
    f.source !== undefined ? `Source: ${inlineCode(f.source)}` : null,
    renderEvidence(f),
    f.suggestion !== undefined && f.side === 'RIGHT' ? suggestionFence(f.suggestion) : null,
    f.alsoAt.length > 0 ? `Also at: ${f.alsoAt.map((l) => where(l)).join(', ')}` : null,
    encodeBlock(f),
  ]);
}
