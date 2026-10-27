// pr status with several selectors (02 §4.4), pure parts: bounded concurrency in argument order, the
// pr create --batch exit rule, and the shared byte budget (water-filled; small PRs keep everything).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ExitCode } from '../../../src/core/exit.ts';
import { byteLength, DEFAULT_MAX_BYTES } from '../../../src/core/output.ts';
import { mapLimit, statusesExitCode } from '../../../src/pr/status/batch.ts';
import { type PrStatusErrorEntry, PrStatusOutput } from '../../../src/pr/status/schema.ts';
import { fitStatus, fitStatuses } from '../../../src/pr/status/truncate.ts';

const GOLDEN = PrStatusOutput.parse(
  JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'golden', 'pr-status-3301.json'), 'utf8')),
);

const notFound = (n: number): PrStatusErrorEntry => ({
  selector: `#${n}`,
  ref: `o/r#${n}`,
  error: { code: 'PR_NOT_FOUND', message: `No PR #${n}.`, hint: null, details: null },
});

/** The golden PR with `n` long comment bodies (each capped to 500 code points by fitStatus). */
function large(n: number): PrStatusOutput {
  const doc = structuredClone(GOLDEN);
  const base = doc.feedback.comments[0];
  assert.ok(base);
  doc.feedback.comments = Array.from({ length: n }, (_, i) => ({
    ...base,
    id: `ic:${500000 + i}`,
    at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
    body: `${i} ${'word '.repeat(200)}`,
  }));
  return doc;
}

test('mapLimit keeps argument order and never runs more than the limit at once', async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([5, 1, 4, 2, 3, 0, 6], 3, async (x) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, x));
    running--;
    return x * 10;
  });
  assert.deepEqual(out, [50, 10, 40, 20, 30, 0, 60]);
  assert.equal(peak, 3);
});

test('exit: 0 all read, 7 some failed, the first error’s own code when all failed', () => {
  assert.equal(statusesExitCode([GOLDEN, GOLDEN]), ExitCode.OK);
  assert.equal(statusesExitCode([GOLDEN, notFound(2)]), ExitCode.GH_FAILED);
  const forbidden = { ...notFound(3), error: { ...notFound(3).error, code: 'GH_FORBIDDEN' } };
  assert.equal(statusesExitCode([notFound(2), forbidden]), ExitCode.NOT_FOUND);
  assert.equal(statusesExitCode([forbidden, notFound(2)]), ExitCode.GH_FAILED);
});

test('fitStatuses: under the budget, each PR is fitted alone and nothing more is cut', () => {
  const out = fitStatuses([GOLDEN, notFound(2)]);
  assert.deepEqual(out, [fitStatus(GOLDEN), notFound(2)]);
});

/** The golden PR with only its open finding: about 4 KB. */
function small(): PrStatusOutput {
  const doc = structuredClone(GOLDEN);
  doc.feedback = { ...doc.feedback, reviews: [], comments: [], bots: [] };
  doc.feedback.findings = doc.feedback.findings.filter((f) => f.id === 'f_n2c6rv');
  return doc;
}

test('fitStatuses: a small PR keeps all of its feedback; the large ones split what is left', () => {
  const out = fitStatuses([large(30), small(), large(30), notFound(4)]) as [
    PrStatusOutput,
    PrStatusOutput,
    PrStatusOutput,
    PrStatusErrorEntry,
  ];
  assert.ok(byteLength(JSON.stringify({ results: out })) <= DEFAULT_MAX_BYTES);
  assert.deepEqual(out[1], fitStatus(small()), 'the small PR is untouched');
  assert.deepEqual(out[3], notFound(4));
  for (const big of [out[0], out[2]]) {
    assert.ok(big.feedback.counts.omitted > 0);
    assert.ok(byteLength(JSON.stringify(big)) > byteLength(JSON.stringify(out[1])), 'the slack went to the large PRs');
    assert.ok(big.warnings.some((w) => w.code === 'FEEDBACK_OMITTED'));
  }
});
