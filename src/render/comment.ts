// Coordination comments and resolve events (02 §7.1, §7.3, §14.3). Visible text derives from the block
// alone, so it cannot disagree with what the fold reads; encodeBlock validates strictly.
// 02 fixes only "Addressed in <sha7>." and the comment leads. Chosen here: a status comment's refs go in a
// `Refs:` paragraph; other resolve statuses read "Won't fix: <note>", "Deferred: <note>", "Reopened.",
// "Met: <note>", "Withdrawn: <note>", "Unmet."; an issue comment leads each line with the target id,
// since it is not attached to the finding.
import { type CommentBlock, encodeBlock } from '../meta/schemas.ts';
import { inlineCode, joinParagraphs } from './markdown.ts';

type NonResolve = Exclude<CommentBlock, { kind: 'resolve' }>;
type ResolveBlock = Extract<CommentBlock, { kind: 'resolve' }>;
export type ResolveTargetBlock = ResolveBlock['targets'][number];

/** The visible lead line of a coordination comment. */
export function commentLead(block: NonResolve): string | null {
  switch (block.kind) {
    case 'note':
      return null;
    case 'precondition': {
      const c = block.condition;
      if (c.type === 'pr-merged') return `**Merge precondition:** merge only after ${c.ref} is merged.`;
      if (c.type === 'release-includes') return `**Merge precondition:** merge only after a release includes ${c.ref}.`;
      return `**Merge precondition:** ${c.text}`;
    }
    case 'status':
      return `**Status:** ${block.state}.`;
    case 'supersede':
      return `Superseded by ${block.by}.`;
  }
}

/**
 * A `pr comment` body: the lead (the status lead shares its line with the body), the body, a `Refs:`
 * paragraph for a status comment's refs, then the block.
 */
export function renderCommentBody(block: NonResolve, body?: string): string {
  const lead = commentLead(block);
  const text = block.kind === 'status' ? [`${lead} ${body ?? ''}`.trim()] : [lead, body];
  const refs = block.kind === 'status' && block.refs?.length ? `Refs: ${block.refs.join(', ')}` : null;
  return joinParagraphs([...text, refs, encodeBlock(block)]);
}

const LEADS_WITH_NOTE: Record<string, string> = {
  wontfix: "Won't fix",
  deferred: 'Deferred',
  met: 'Met',
  withdrawn: 'Withdrawn',
};

/** One target's sentence: "Addressed in 9f2c4e1.", "Won't fix: <note>", … */
export function resolveSentence(t: ResolveTargetBlock): string {
  const tracking = t.tracking ? ` (tracking ${t.tracking})` : '';
  const lead = LEADS_WITH_NOTE[t.status];
  if (lead !== undefined) return `${lead}: ${t.note ?? ''}${tracking}`.trim();
  const head =
    t.status === 'addressed'
      ? `Addressed in ${t.commit ? t.commit.slice(0, 7) : 'an unknown commit'}.`
      : t.status === 'open'
        ? 'Reopened.'
        : t.status === 'unmet'
          ? 'Unmet.'
          : `Status ${t.status}.`;
  return [head, t.note].filter(Boolean).join(' ') + tracking;
}

/** A thread reply for one inline finding (02 §14.3): the sentence, then the block. */
export function renderResolveReply(block: ResolveBlock): string {
  return joinParagraphs([block.targets.map(resolveSentence).join('\n'), encodeBlock(block)]);
}

/** One issue comment for every target that is not an inline finding: a line per target, then the block. */
export function renderResolveComment(block: ResolveBlock): string {
  const lines = block.targets.map((t) => `${inlineCode(t.id)} ${resolveSentence(t)}`);
  return joinParagraphs([lines.join('\n'), encodeBlock(block)]);
}
