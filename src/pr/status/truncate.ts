// pr status's size budget (02 §4.1 Truncation; 03 M6.5; 04 wave 4: the 16 KB bound is hard): per-item caps
// first, then, while the document is over the budget, resolved-finding bodies and the oldest comment bodies,
// then whole old or resolved comment entries, bots and settled findings, are dropped and counted in
// feedback.counts.omitted, with a FEEDBACK_OMITTED warning pointing to `pr feedback`. The 01 spill stays
// the safety net only for a document whose non-feedback parts alone are too large.
import { byteLength, DEFAULT_MAX_BYTES } from '../../core/output.ts';
import type { Comment, Feedback, Finding } from '../../feedback/schemas.ts';
import type { PrStatusOutput } from './schema.ts';

export const STATUS_CAPS = { description: 1000, comment: 500, finding: 600, summary: 400 } as const;

/** At most `max` code points, the last one an ellipsis when cut. */
export function capText(s: string, max: number): { text: string; cut: boolean } {
  const cps = [...s];
  if (cps.length <= max) return { text: s, cut: false };
  return { text: `${cps.slice(0, Math.max(0, max - 1)).join('')}…`, cut: true };
}

/** Caps every inline body of the feedback (finding, comment, review and bot summary limits as given). */
export function capFeedback(f: Feedback, caps: { comment: number; finding: number; summary: number }): Feedback {
  return {
    ...f,
    reviews: f.reviews.map((r) => {
      const c = capText(r.summary, caps.summary);
      return { ...r, summary: c.text, truncated: r.truncated || c.cut };
    }),
    findings: f.findings.map((x) => {
      const c = capText(x.body, caps.finding);
      return { ...x, body: c.text, truncated: x.truncated || c.cut };
    }),
    comments: f.comments.map((x) => {
      const c = capText(x.body, caps.comment);
      return { ...x, body: c.text, truncated: x.truncated || c.cut };
    }),
    bots: f.bots.map((b) => ({ ...b, summary: capText(b.summary, caps.summary).text })),
  };
}

const size = (doc: unknown): number => byteLength(JSON.stringify(doc));

/** Open for the merge policy: open, or addressed with an unverified commit (04). Never dropped. */
const keepsFinding = (f: Finding): boolean =>
  f.status === 'open' || (f.status === 'addressed' && f.statusEvent?.verified == null);

const byAge = <T extends { at: string }>(xs: readonly T[]): T[] =>
  xs
    .map((x, i) => ({ x, i }))
    .sort((a, b) => Date.parse(a.x.at) - Date.parse(b.x.at) || a.i - b.i)
    .map(({ x }) => x);

/** Comment drop tiers: resolved threads, then plain comments, then open threads; oldest first in each. */
const commentTier = (c: Comment): number => (c.threadResolved === true ? 0 : c.threadResolved === null ? 1 : 2);

/**
 * The 16 KB bound is hard (04 wave 4 review decisions). Per-item caps first; then, while over the budget:
 * settled-finding bodies, the oldest comment bodies, then whole entries (comments, resolved and oldest
 * first; bots, oldest first; settled findings; reviews no finding points to). Each item is counted once in
 * feedback.counts.omitted, with a FEEDBACK_OMITTED hint to `pr feedback`. Open and unverified findings,
 * preconditions, openFindings and merge.* are never dropped; the fold's counts stay the totals.
 */
export function fitStatus(doc: PrStatusOutput, maxBytes = DEFAULT_MAX_BYTES): PrStatusOutput {
  const out: PrStatusOutput = structuredClone(doc);
  out.description.text = capText(out.description.text, STATUS_CAPS.description).text;
  out.feedback = capFeedback(out.feedback, STATUS_CAPS);
  if (size(out) <= maxBytes) return out;

  const hint = { code: 'FEEDBACK_OMITTED', message: '' };
  out.warnings = [...out.warnings, hint];
  const fb = out.feedback;
  const cut = new Set<string>();
  let dropped = 0;
  const count = (key: string, whole: boolean) => {
    if (whole) dropped++;
    if (cut.has(key)) return;
    cut.add(key);
    fb.counts.omitted++;
  };
  const setHint = () => {
    hint.message =
      `${fb.counts.omitted} feedback items were cut to fit ${maxBytes} bytes (${cut.size - dropped} bodies emptied, ` +
      `${dropped} whole entries dropped); read them in full with ghx pr feedback ${out.ref}.`;
  };

  const settled = fb.findings.filter((f) => !keepsFinding(f));
  const drops: (() => void)[] = [
    // Bodies.
    ...settled
      .filter((f) => f.body !== '')
      .map((f) => () => {
        fb.findings = fb.findings.map((x) => (x.id === f.id ? { ...x, body: '', truncated: true } : x));
        count(`f:${f.id}`, false);
      }),
    ...byAge(fb.comments.filter((c) => c.body !== '')).map((c) => () => {
      fb.comments = fb.comments.map((x) => (x.id === c.id ? { ...x, body: '', truncated: true } : x));
      count(`c:${c.id}`, false);
    }),
    // Whole entries.
    ...[0, 1, 2].flatMap((tier) =>
      byAge(fb.comments.filter((c) => commentTier(c) === tier)).map((c) => () => {
        fb.comments = fb.comments.filter((x) => x.id !== c.id);
        count(`c:${c.id}`, true);
      }),
    ),
    ...byAge(fb.bots).map((b) => () => {
      fb.bots = fb.bots.filter((x) => x.id !== b.id);
      count(`b:${b.id}`, true);
    }),
    ...settled.map((f) => () => {
      fb.findings = fb.findings.filter((x) => x.id !== f.id);
      count(`f:${f.id}`, true);
    }),
    ...byAge(fb.reviews.map((r) => ({ r, at: r.submittedAt }))).map(({ r }) => () => {
      if (r.githubState === 'CHANGES_REQUESTED' || fb.findings.some((f) => f.reviewId === r.id)) return;
      fb.reviews = fb.reviews.filter((x) => x.id !== r.id);
      count(`r:${r.id}`, true);
    }),
  ];
  setHint();
  for (const drop of drops) {
    if (size(out) <= maxBytes) break;
    drop();
    setHint();
  }
  if (fb.counts.omitted === doc.feedback.counts.omitted) out.warnings = out.warnings.filter((w) => w !== hint);
  return out;
}
