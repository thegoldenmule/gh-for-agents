// R13 (03 §5.2). Guards brief 7 and the §8c comment types: items without a ghx block are returned with
// structured:false and never dropped, and bot output is separated from human feedback.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foldFeedback } from '../../src/feedback/fold.ts';
import { assertConservation, loadInput } from '../unit/feedback/_fixture.ts';

test('R13: human comments stay as structured:false, bots are separated, nothing is dropped', () => {
  const input = loadInput('unstructured-and-bots.json');
  const r = foldFeedback(input);
  const f = r.feedback;

  const human = f.comments.find((c) => c.id === 'ic:701');
  assert.deepEqual(
    human && { structured: human.structured, kind: human.kind, body: human.body, by: human.author.login },
    { structured: false, kind: null, body: 'Looks good once CI is green.', by: 'maria-dev' },
  );

  assert.equal(f.bots.length, 2);
  const watch = f.bots.find((b) => b.marker === 'ci-duration-watch');
  assert.deepEqual(watch && [watch.author, watch.source, watch.summary], [
    'github-actions[bot]',
    'issue',
    'CI took 14m 2s (p90 11m). Slowest job: Test Reactor (shard 1/3).',
  ]);
  const copilot = f.bots.find((b) => b.source === 'inline');
  assert.deepEqual(copilot && [copilot.author, copilot.path, copilot.line], [
    'copilot-pull-request-reviewer[bot]',
    'src/b.ts',
    41,
  ]);

  assert.deepEqual(
    f.reviews.map((x) => [x.id, x.structured]),
    [['r_a1b2c3', true]],
  );
  assert.deepEqual(
    f.findings.map((x) => [x.id, x.inline, x.status]),
    [['f_d4e5f6', true, 'open']],
  );
  assert.equal(
    f.counts.unresolvedHumanThreads,
    1,
    "maria-dev's inline question; the ghx and Copilot threads are not human",
  );
  assertConservation(input, r);
});
