// Shared by the feedback unit tests and R13/R14: load a Q1 feedback fixture and check conservation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigSchema, type GhxConfigInput } from '../../../src/config/schema.ts';
import type { FeedbackInput, FoldResult } from '../../../src/feedback/fold.ts';
import { RawFeedback } from '../../../src/feedback/raw.ts';

export const FIXTURES = join(import.meta.dirname, '../../fixtures/feedback');

export function configWith(over: Partial<Pick<GhxConfigInput, 'trust' | 'bots'>> = {}): FeedbackInput['config'] {
  const c = ConfigSchema.parse({ version: 1, components: { x: {} }, ...over });
  return { trust: c.trust, bots: c.bots };
}

export function loadInput(name: string, config = configWith()): FeedbackInput {
  const raw = JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as { viewerLogin: string; headSha: string };
  return { ...RawFeedback.parse(raw), viewerLogin: raw.viewerLogin, headSha: raw.headSha, config };
}

export function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

/**
 * Brief 7: nothing is dropped. Every raw GitHub item is the source of exactly one primary entry (a review,
 * an inline finding, a comment or a bot item), except empty COMMENTED reviews, which only contain inline
 * comments. Body-only findings are derived from their review and not counted here.
 */
export function assertConservation(input: FeedbackInput, r: FoldResult): void {
  const containers = input.reviews.filter((x) => x.state === 'COMMENTED' && x.body.trim() === '').length;
  const threadComments = input.reviewThreads.reduce((n, t) => n + t.comments.nodes.length, 0);
  const itemsIn = input.reviews.length - containers + threadComments + input.issueComments.length;
  const f = r.feedback;
  const primaryOut = f.reviews.length + f.findings.filter((x) => x.inline).length + f.comments.length + f.bots.length;
  assert.equal(primaryOut, itemsIn, 'items in = items out');
  const ids = [...f.reviews, ...f.findings, ...f.comments, ...f.bots].map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'each item is in exactly one list');
}
