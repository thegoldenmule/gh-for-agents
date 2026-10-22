// reviewRules and the review input schema (02 §7.2; 03 §5.1): one pass and one fail boundary per rule.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrReviewInput, reviewRules } from '../../../../src/pr/feedback-writes/review-schema.ts';

const finding = (o: Record<string, unknown> = {}) => ({
  severity: 'low',
  path: 'src/a.ts',
  line: 3,
  title: 'A finding',
  body: 'Why it matters.',
  ...o,
});
const codes = (r: unknown) => reviewRules(PrReviewInput.parse(r)).map((i) => i.code);

test('approve: a low finding passes; a high finding is review.approve_with_high', () => {
  assert.deepEqual(codes({ verdict: 'approve', summary: 'ok', findings: [finding()] }), []);
  assert.deepEqual(codes({ verdict: 'approve', summary: 'ok', findings: [finding({ severity: 'high' })] }), [
    'review.approve_with_high',
  ]);
});

test('request-changes needs a finding', () => {
  assert.deepEqual(codes({ verdict: 'request-changes', summary: 'x', findings: [finding()] }), []);
  assert.deepEqual(codes({ verdict: 'request-changes', summary: 'x' }), ['review.request_changes_without_findings']);
});

test('finding.range and finding.duplicate', () => {
  assert.deepEqual(codes({ verdict: 'comment', summary: 'x', findings: [finding({ endLine: 3 })] }), []);
  assert.deepEqual(codes({ verdict: 'comment', summary: 'x', findings: [finding({ endLine: 2 })] }), ['finding.range']);
  assert.deepEqual(codes({ verdict: 'comment', summary: 'x', findings: [finding(), finding({ body: 'other' })] }), [
    'finding.duplicate',
  ]);
  assert.deepEqual(codes({ verdict: 'comment', summary: 'x', findings: [finding(), finding({ line: 4 })] }), []);
});

test('schema: side defaults to RIGHT, alsoAt to []; caps on summary, title, body and count', () => {
  const r = PrReviewInput.parse({ verdict: 'comment', summary: 'x', findings: [finding()] });
  assert.equal(r.findings[0]?.side, 'RIGHT');
  assert.deepEqual(r.findings[0]?.alsoAt, []);
  assert.equal(PrReviewInput.safeParse({ verdict: 'comment', summary: 'a\nb\nc\nd' }).success, false);
  assert.equal(PrReviewInput.safeParse({ verdict: 'comment', summary: 'x'.repeat(401) }).success, false);
  assert.equal(
    PrReviewInput.safeParse({ verdict: 'comment', summary: 'x', findings: [finding({ title: 'x'.repeat(101) })] })
      .success,
    false,
  );
  assert.equal(
    PrReviewInput.safeParse({ verdict: 'comment', summary: 'x', findings: [finding({ path: '../etc/passwd' })] })
      .success,
    false,
  );
  const many = Array.from({ length: 51 }, (_, i) => finding({ line: i + 1 }));
  assert.equal(PrReviewInput.safeParse({ verdict: 'comment', summary: 'x', findings: many }).success, false);
  assert.equal(PrReviewInput.safeParse({ verdict: 'lgtm', summary: 'x' }).success, false);
});
