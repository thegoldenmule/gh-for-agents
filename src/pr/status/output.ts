// PrStatusOutput from a loaded PR state (02 §4.1), before the size budget (./truncate.ts) is applied.
import type { PrBlockRead, PrBlockResult } from '../../meta/schemas.ts';
import { mergeStateOf } from '../../policy/merge.ts';
import { parsePrBody, type RenderOptions, readBody } from '../../render/pr-body.ts';
import type { Warning } from '../../schemas/common.ts';
import type { PrStatusState } from './compose.ts';
import type { PrMeta, PrStatusOutput } from './schema.ts';

/** The block's data as an object, or null when it is present but not one. */
function dataOf(b: PrBlockRead): Record<string, unknown> | null {
  if (b.data === undefined) return {};
  return b.data !== null && typeof b.data === 'object' && !Array.isArray(b.data)
    ? { ...(b.data as Record<string, unknown>) }
    : null;
}

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
    data: dataOf(b) ?? {},
  };
}

/**
 * meta with the trust gate on data (08 §1): the PR body block is not trust-gated like comments, and a fork
 * author could otherwise hand instructions to a coordinating agent through it.
 */
export function gatedMeta(b: PrBlockRead, author: { login: string; association: string }, trusted: boolean) {
  const meta = prMetaOf(b);
  const warnings: Warning[] = [];
  const data = dataOf(b);
  if (data === null) {
    warnings.push({ code: 'DATA_INVALID', message: "The block's data is not an object; meta.data reads as {}." });
  } else if (!trusted && Object.keys(data).length > 0) {
    meta.data = {};
    warnings.push({
      code: 'UNTRUSTED_DATA',
      message: `meta.data omitted: the PR author ${author.login} (${author.association}) is not trusted (trust.associations).`,
    });
  }
  return { meta, warnings };
}

export function metaErrorOf(m: PrBlockResult): PrStatusOutput['metaError'] {
  return m.status === 'invalid' ? { code: m.code, message: m.error } : null;
}

export interface StatusOutputOptions {
  /** The render options (renderOptions(config)): the template and footer the body is read against. */
  render: RenderOptions;
  /** Command-level warnings (CWD_REPO_MISMATCH, CONFIG_MISSING), listed first. */
  warnings?: readonly Warning[];
}

export function statusOutput(s: PrStatusState, o: StatusOutputOptions): PrStatusOutput {
  const snap = s.snapshot;
  const meta = snap.meta;
  const f = snap.feedback;
  const gated = meta.status === 'ok' ? gatedMeta(meta.block, snap.author, snap.authorTrusted === true) : null;
  const reading = meta.status === 'ok' ? readBody(snap.body, meta.block, o.render, snap.title) : null;
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
      text: reading?.description ?? parsePrBody(snap.body, { footer: o.render.footer }).description,
      structured: meta.status === 'ok',
      drift: reading?.drift ?? [],
    },
    meta: gated?.meta ?? null,
    metaError: metaErrorOf(meta),
    merge: mergeStateOf(snap, s.evaluation),
    ci: s.ci,
    feedback: f.feedback,
    openFindings: f.openFindings,
    preconditions: f.preconditions,
    stack: snap.stack,
    warnings: [...(o.warnings ?? []), ...s.warnings, ...(gated?.warnings ?? [])],
    fetchedAt: snap.fetchedAt,
  };
}
