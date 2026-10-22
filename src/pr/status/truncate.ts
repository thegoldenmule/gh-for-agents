// pr status's size budget (02 §4.1 Truncation; 03 M6.5): per-item caps first, then, while the document is
// over the budget, resolved-finding bodies and then the oldest comment bodies are dropped and counted in
// feedback.counts.omitted, with a FEEDBACK_OMITTED warning pointing to `pr feedback`. The 01 spill stays
// the safety net for anything still too large.
import { byteLength, DEFAULT_MAX_BYTES } from '../../core/output.ts';
import type { Feedback } from '../../feedback/schemas.ts';
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

export function fitStatus(doc: PrStatusOutput, maxBytes = DEFAULT_MAX_BYTES): PrStatusOutput {
  const out: PrStatusOutput = structuredClone(doc);
  out.description.text = capText(out.description.text, STATUS_CAPS.description).text;
  out.feedback = capFeedback(out.feedback, STATUS_CAPS);
  if (size(out) <= maxBytes) return out;

  const hint = { code: 'FEEDBACK_OMITTED', message: '' };
  out.warnings = [...out.warnings, hint];
  const fb = out.feedback;
  const setHint = () => {
    hint.message = `${fb.counts.omitted} feedback bodies were omitted to fit ${maxBytes} bytes; read them in full with ghx pr feedback ${out.ref}.`;
  };
  const drops: (() => void)[] = [
    ...fb.findings
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => f.status !== 'open' && f.body !== '')
      .map(({ i }) => () => {
        fb.findings[i] = { ...(fb.findings[i] as (typeof fb.findings)[number]), body: '', truncated: true };
      }),
    ...fb.comments
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.body !== '')
      .sort((a, b) => Date.parse(a.c.at) - Date.parse(b.c.at) || a.i - b.i)
      .map(({ i }) => () => {
        fb.comments[i] = { ...(fb.comments[i] as (typeof fb.comments)[number]), body: '', truncated: true };
      }),
  ];
  setHint();
  for (const drop of drops) {
    if (size(out) <= maxBytes) break;
    drop();
    fb.counts.omitted++;
    setHint();
  }
  if (fb.counts.omitted === 0) out.warnings = out.warnings.filter((w) => w !== hint);
  return out;
}
