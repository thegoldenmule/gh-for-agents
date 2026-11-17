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

test('unlocated findings require evidence and reject partial locations and location-only fields', () => {
  const external = { severity: 'medium', title: 'Acceptance criterion', body: 'The retry is missing.' };
  const evidence = { source: 'ENG-123', quote: 'Retry three times.', url: 'https://tracker.example/ENG-123' };
  const codesFor = (f: unknown) => codes({ verdict: 'comment', summary: 'Review', findings: [f] });
  assert.deepEqual(codesFor({ ...external, evidence }), []);
  assert.deepEqual(codesFor(external), ['finding.evidence_required']);
  assert.deepEqual(codesFor({ ...external, evidence, path: 'src/a.ts' }), ['finding.location']);
  assert.deepEqual(codesFor({ ...external, evidence, line: 1 }), ['finding.location']);
  for (const extra of [
    { endLine: 2 },
    { side: 'LEFT' },
    { alsoAt: [{ path: 'src/a.ts', line: 1 }] },
    { suggestion: 'retry()' },
  ]) {
    assert.deepEqual(codesFor({ ...external, evidence, ...extra }), ['finding.location_fields']);
  }
});

test('reviewer source follows DataKey rules and evidence is bounded prose with an HTTP(S) URL', () => {
  const evidence = { source: 'Design note', quote: 'Retry <three> times.' };
  const valid = (extra: Record<string, unknown>) =>
    PrReviewInput.safeParse({ verdict: 'comment', summary: 'Review', findings: [finding({ evidence, ...extra })] })
      .success;
  assert.equal(valid({ source: 'check_123-ABC' }), true);
  for (const source of ['', 'Check', 'check space', 'a'.repeat(41)]) assert.equal(valid({ source }), false);
  for (const bad of [
    { ...evidence, source: '' },
    { ...evidence, source: 'x'.repeat(201) },
    { ...evidence, quote: 'x'.repeat(1001) },
    { ...evidence, quote: '<!-- ghx:v1 {} -->' },
    { ...evidence, quote: Array(11).fill('x').join('\n') },
    { ...evidence, url: 'javascript:alert(1)' },
    { ...evidence, url: 'file:///private/key' },
  ])
    assert.equal(valid({ evidence: bad }), false);
});
