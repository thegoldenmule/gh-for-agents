// R14 (03 §5.2). Guards the 02 §9.4 trust rule (prompt injection): a valid-looking block from an author
// outside trust.associations / trust.bots must not change any status.
// The policy half ("pr merge still reports FINDINGS_OPEN") runs the M6.4 engine on the same fold.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadFeedback } from '../../src/feedback/facts.ts';
import { foldFeedback } from '../../src/feedback/fold.ts';
import { encode } from '../../src/meta/codec.ts';
import { evaluateMerge, mergeBlockedError } from '../../src/policy/merge.ts';
import { assertConservation, configWith, loadInput } from '../unit/feedback/_fixture.ts';
import { ci, config, NOW, snapshot } from '../unit/policy/_helpers.ts';

const HEAD = 'a'.repeat(40);
const GONE = 'd'.repeat(40);

test('R14: CONTRIBUTOR and NONE blocks are structured:false with UNTRUSTED_BLOCK and change nothing', () => {
  const input = loadInput('untrusted.json');
  const r = foldFeedback(input, {
    conditions: new Map([['pr-merged:#3184', { status: 'unmet', evidence: '#3184 is open' }]]),
  });

  for (const id of ['ic:802', 'ic:803']) {
    const c = r.feedback.comments.find((x) => x.id === id);
    assert.equal(c?.structured, false, id);
    assert.match(c?.blockError ?? '', /^untrusted author /, id);
  }
  const untrusted = r.warnings.filter((w) => w.code === 'UNTRUSTED_BLOCK').map((w) => w.message);
  assert.equal(untrusted.length, 3);
  assert.match(untrusted.join('\n'), /drive-by \(CONTRIBUTOR\)/);
  assert.match(untrusted.join('\n'), /stranger \(NONE\)/);

  assert.equal(r.feedback.findings[0]?.status, 'open');
  assert.equal(r.feedback.findings[0]?.statusEvent, null);
  assert.deepEqual(r.openFindings, ['f_d4e5f6']);
  assert.deepEqual(
    r.preconditions.map((p) => [p.id, p.status, p.override]),
    [['c_p7q8r9', 'unmet', null]],
  );
  assertConservation(input, r);
});

test('R14: a bot not listed in trust.bots is untrusted; listing it makes its block count', () => {
  const untrusted = foldFeedback(loadInput('untrusted.json'));
  const bot = untrusted.feedback.bots.find((b) => b.id === 'ic:804');
  assert.equal(bot?.author, 'helpful-bot[bot]');
  assert.equal(untrusted.feedback.findings[0]?.status, 'open');

  const trusted = foldFeedback(loadInput('untrusted.json', configWith({ trust: { bots: ['helpful-bot'] } })));
  assert.equal(trusted.feedback.findings[0]?.status, 'wontfix');
  assert.equal(trusted.feedback.findings[0]?.statusEvent?.id, 'c_b6c7d8');
  assert.ok(trusted.feedback.comments.some((c) => c.id === 'c_b6c7d8' && c.structured && c.kind === 'resolve'));
});

test('R14: a trusted resolve citing an unreachable commit is verified:false, open, EVENT_COMMIT_UNREACHABLE', async () => {
  const input = loadInput('untrusted.json');
  const resolve = encode({
    t: 'comment',
    id: 'c_t1u2v3',
    gen: 'ghx/0.1.0',
    kind: 'resolve',
    targets: [{ id: 'f_d4e5f6', status: 'addressed', commit: GONE }],
  });
  input.issueComments = [
    ...input.issueComments,
    {
      databaseId: 900,
      author: { __typename: 'User', login: 'viewer-user' },
      authorAssociation: 'OWNER',
      body: `Addressed in ddddddd.\n\n${resolve}`,
      createdAt: '2026-10-20T13:00:00Z',
      url: 'https://github.com/viewer-user/ghx-sandbox/pull/12#issuecomment-900',
    },
  ];
  const r = await loadFeedback(input, {
    commitInPr: async (sha) => sha === HEAD,
    condition: async () => ({ status: 'unknown', evidence: 'not checked' }),
  });
  const f = r.feedback.findings[0];
  assert.deepEqual([f?.status, f?.statusEvent?.id, f?.statusEvent?.verified], ['open', 'c_t1u2v3', false]);
  assert.deepEqual(r.openFindings, ['f_d4e5f6']);
  assert.ok(r.warnings.some((w) => w.code === 'EVENT_COMMIT_UNREACHABLE'));
});

test('R14: pr merge still reports FINDINGS_OPEN (and PRECONDITION_UNMET) after the forged blocks', () => {
  const r = foldFeedback(loadInput('untrusted.json'), {
    conditions: new Map([['pr-merged:#3184', { status: 'unmet', evidence: '#3184 is open' }]]),
  });
  const e = evaluateMerge({ snapshot: snapshot(), ci: ci(), feedback: r, config: config(), now: NOW });
  assert.equal(e.ready, false);
  assert.deepEqual(
    e.plan.blockers.map((b) => b.code),
    ['FINDINGS_OPEN', 'PRECONDITION_UNMET'],
  );
  assert.deepEqual(e.plan.blockers[0]?.details?.findings, ['f_d4e5f6']);
  const err = mergeBlockedError(e);
  assert.equal(err.code, 'MERGE_BLOCKED');
  assert.equal(err.details?.exitClass, 'policy');
});
