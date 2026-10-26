// PrStatusOutput from a loaded PR state (02 §4.1), before the size budget (./truncate.ts) is applied.
import type { PrBlockRead, PrBlockResult } from '../../meta/schemas.ts';
import { mergeStateOf } from '../../policy/merge.ts';
import { parsePrBody, prBodyDrift } from '../../render/pr-body.ts';
import type { Warning } from '../../schemas/common.ts';
import type { PrStatusState } from './compose.ts';
import type { PrMeta, PrStatusOutput } from './schema.ts';

export function prMetaOf(b: PrBlockRead): PrMeta {
  return {
    id: b.id,
    rev: b.rev,
    gen: b.gen,
    risk: b.risk,
    riskNote: b.riskNote ?? null,
    components: [...b.components],
    alsoTouched: [...(b.alsoTouched ?? [])],
    revertPolicy: b.revertPolicy,
    revertNote: b.revertNote ?? null,
    revertWith: [...(b.revertWith ?? [])],
    testing: b.testing,
    refs: b.refs ?? {},
  };
}

export function metaErrorOf(m: PrBlockResult): PrStatusOutput['metaError'] {
  return m.status === 'invalid' ? { code: m.code, message: m.error } : null;
}

export interface StatusOutputOptions {
  /** render.footer, so the footer is not reported as description text or drift. */
  footer: string | null;
  /** Command-level warnings (CWD_REPO_MISMATCH, CONFIG_MISSING), listed first. */
  warnings?: readonly Warning[];
}

export function statusOutput(s: PrStatusState, o: StatusOutputOptions): PrStatusOutput {
  const snap = s.snapshot;
  const meta = snap.meta;
  const f = snap.feedback;
  return {
    ref: snap.ref,
    url: snap.url,
    number: snap.number,
    title: snap.title,
    author: snap.author,
    state: snap.state,
    draft: snap.draft,
    createdAt: snap.createdAt,
    updatedAt: snap.updatedAt,
    base: { ref: snap.base.ref, isDefault: snap.base.isDefault },
    head: { ref: snap.head.ref, sha: snap.head.sha },
    changes: snap.changes,
    description: {
      text: parsePrBody(snap.body, { footer: o.footer }).description,
      structured: meta.status === 'ok',
      drift: meta.status === 'ok' ? prBodyDrift(snap.body, meta.block, { footer: o.footer }, snap.title) : [],
    },
    meta: meta.status === 'ok' ? prMetaOf(meta.block) : null,
    metaError: metaErrorOf(meta),
    merge: mergeStateOf(snap, s.evaluation),
    ci: s.ci,
    feedback: f.feedback,
    openFindings: f.openFindings,
    preconditions: f.preconditions,
    stack: snap.stack,
    warnings: [...(o.warnings ?? []), ...s.warnings],
    fetchedAt: snap.fetchedAt,
  };
}
