// pr status's size budget (02 §4.1 Truncation; 03 M6.5; 04 wave 4: the 16 KB bound is hard): per-item caps
// first, then, while the document is over the budget, resolved-finding bodies and the oldest comment bodies,
// then whole old or resolved comment entries, bots and settled findings, are dropped and counted in
// feedback.counts.omitted, with a FEEDBACK_OMITTED warning pointing to `pr feedback`. The 01 spill stays
// the safety net only for a document whose non-feedback parts alone are too large. Several PRs (fitStatuses)
// share one budget: PRs that fit their share keep it all, and the rest split what is left. Under --fields or
// --brief (`project`, Context.project) the budget is measured on the projected document, and a cut that the
// projection would hide is undone: only selected content is cut, counted and reported.
import { byteLength, DEFAULT_MAX_BYTES } from '../../core/output.ts';
import type { Comment, Feedback, Finding } from '../../feedback/schemas.ts';
import type { PrStatusEntry, PrStatusOutput } from './schema.ts';

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

/** The --fields/--brief projection the runner will apply (Context.project); the identity without one. */
export type Projection = ((doc: unknown) => unknown) | undefined;

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
 * With `project`, the bound is on project(doc) and a cut that leaves project(doc) unchanged is undone.
 */
export function fitStatus(doc: PrStatusOutput, maxBytes = DEFAULT_MAX_BYTES, project?: Projection): PrStatusOutput {
  const out: PrStatusOutput = structuredClone(doc);
  out.description.text = capText(out.description.text, STATUS_CAPS.description).text;
  out.feedback = capFeedback(out.feedback, STATUS_CAPS);
  const view = (): string => JSON.stringify(project ? project(out) : out);
  if (byteLength(view()) <= maxBytes) return out;

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

  // One cut each: the lists it changes (undefined when there is nothing to cut), its count key, and whether
  // it drops the whole entry.
  type Lists = Partial<Pick<Feedback, 'findings' | 'comments' | 'bots' | 'reviews'>>;
  type Cut = { key: string; whole: boolean; apply: () => Lists | undefined };
  const settled = fb.findings.filter((f) => !keepsFinding(f));
  const cuts: Cut[] = [
    // Bodies.
    ...settled
      .filter((f) => f.body !== '')
      .map((f) => ({
        key: `f:${f.id}`,
        whole: false,
        apply: () => ({ findings: fb.findings.map((x) => (x.id === f.id ? { ...x, body: '', truncated: true } : x)) }),
      })),
    ...byAge(fb.comments.filter((c) => c.body !== '')).map((c) => ({
      key: `c:${c.id}`,
      whole: false,
      apply: () => ({ comments: fb.comments.map((x) => (x.id === c.id ? { ...x, body: '', truncated: true } : x)) }),
    })),
    // Whole entries.
    ...[0, 1, 2].flatMap((tier) =>
      byAge(fb.comments.filter((c) => commentTier(c) === tier)).map((c) => ({
        key: `c:${c.id}`,
        whole: true,
        apply: () => ({ comments: fb.comments.filter((x) => x.id !== c.id) }),
      })),
    ),
    ...byAge(fb.bots).map((b) => ({
      key: `b:${b.id}`,
      whole: true,
      apply: () => ({ bots: fb.bots.filter((x) => x.id !== b.id) }),
    })),
    ...settled.map((f) => ({
      key: `f:${f.id}`,
      whole: true,
      apply: () => ({ findings: fb.findings.filter((x) => x.id !== f.id) }),
    })),
    ...byAge(fb.reviews.map((r) => ({ r, at: r.submittedAt }))).map(({ r }) => ({
      key: `r:${r.id}`,
      whole: true,
      apply: () =>
        r.githubState === 'CHANGES_REQUESTED' || fb.findings.some((f) => f.reviewId === r.id)
          ? undefined
          : { reviews: fb.reviews.filter((x) => x.id !== r.id) },
    })),
  ];
  setHint();
  let seen = view();
  for (const cut of cuts) {
    if (byteLength(seen) <= maxBytes) break;
    const next = cut.apply();
    if (!next) continue;
    const before = { findings: fb.findings, comments: fb.comments, bots: fb.bots, reviews: fb.reviews };
    Object.assign(fb, next);
    // Under a projection that does not select this content the cut saves nothing: undo it, uncounted.
    const after = view();
    if (project && after === seen) {
      Object.assign(fb, before);
      continue;
    }
    count(cut.key, cut.whole);
    setHint();
    seen = view();
  }
  if (fb.counts.omitted === doc.feedback.counts.omitted) out.warnings = out.warnings.filter((w) => w !== hint);
  return out;
}

/**
 * `{results}` for several PRs within `maxBytes` (02 §4.4): each PR is fitted alone first; over the budget,
 * the budget is water-filled. Error entries and PRs already within an equal share keep their size, and the
 * others are re-fitted to an equal split of what is left, until every share holds. A PR's non-feedback core
 * is never cut, so ten large PRs can still exceed the budget: the 01 spill is the safety net there too.
 * With `project`, each entry is measured as the projection keeps a results[] element.
 */
export function fitStatuses(
  entries: readonly PrStatusEntry[],
  maxBytes = DEFAULT_MAX_BYTES,
  project?: Projection,
): PrStatusEntry[] {
  const isPr = (e: PrStatusEntry): e is PrStatusOutput => !('error' in e);
  // An element is projected as part of {results} (RESULT_KEEP), not as a document of its own.
  const element: Projection = project && ((e) => (project({ results: [e] }) as { results: unknown[] }).results[0]);
  const measure = (e: unknown): number => size(element ? element(e) : e);
  const out = entries.map((e) => (isPr(e) ? fitStatus(e, maxBytes, element) : e));
  if (size(project ? project({ results: out }) : { results: out }) <= maxBytes) return out;
  // The wrapper and the commas between entries.
  let budget = maxBytes - size({ results: [] }) - Math.max(0, out.length - 1);
  let open: number[] = [];
  out.forEach((e, i) => {
    if (isPr(e)) open.push(i);
    else budget -= measure(e);
  });
  while (open.length > 0) {
    const share = Math.max(0, Math.floor(budget / open.length));
    const within = open.filter((i) => measure(out[i]) <= share);
    if (within.length === 0) {
      for (const i of open) out[i] = fitStatus(entries[i] as PrStatusOutput, share, element);
      break;
    }
    for (const i of within) budget -= measure(out[i]);
    open = open.filter((i) => !within.includes(i));
  }
  return out;
}
