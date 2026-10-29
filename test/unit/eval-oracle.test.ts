// Tier 2 replay oracle (plan 07, M4): the measurement pieces, world composition, and the done-when: every
// question is answered correctly by the ghx and gh-expert scripts, the same way on every run.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildReport,
  estimateResultTokens,
  judge,
  QUESTIONS,
  renderMarkdown,
  runQuestions,
  selectQuestions,
  serializeReport,
} from '../../scripts/eval/oracle/index.ts';
import { SCRUB_ROOT, scrub } from '../../scripts/eval/oracle/scrub.ts';
import { charCount } from '../../scripts/eval/oracle/tokens.ts';
import { ARMS } from '../../scripts/eval/oracle/types.ts';
import { composeWorld } from '../../scripts/eval/oracle/world.ts';
import { loadScenario, pickFixture, replyStdout } from '../helpers/fixture-match.ts';
import { scratchDir } from '../helpers/harness.ts';

test('result tokens: chars / 2.2 + 70 per tool call, rounded; chars are code points', () => {
  assert.equal(estimateResultTokens(0), 70);
  assert.equal(estimateResultTokens(22), 80);
  assert.equal(estimateResultTokens(1000), 525);
  assert.equal(charCount('a🤖b'), 3);
});

test('scrub: the answer directory becomes SCRUB_ROOT; clock-derived names keep their length', () => {
  const root = '/var/folders/xy/T/ghx-oracle-abc/pr-status/ghx';
  const text = `{"logPath":"${root}/artifacts/x.log","eventsPath":"${root}/events/ci-wait-1793288830664-f9d2abc6.ndjson","elapsedSec":12}`;
  const out = scrub(text, root);
  assert.equal(
    out,
    `{"logPath":"${SCRUB_ROOT}/artifacts/x.log","eventsPath":"${SCRUB_ROOT}/events/ci-wait-0000000000000-00000000.ndjson","elapsedSec":0}`,
  );
});

test('judge: seen facts read the tool results, call facts the gh argv, no-call facts forbid one', () => {
  const r = judge(
    [
      { id: 'a', kind: 'seen', pattern: /MERGED/ },
      { id: 'b', kind: 'call', pattern: /^api .*-X PUT .*pulls\/1\/merge/ },
      { id: 'c', kind: 'no-call', pattern: /rerun/ },
      { id: 'd', kind: 'seen', pattern: /absent/ },
    ],
    ['state: OPEN', 'state: MERGED'],
    [{ argv: ['api', '--include', '-X', 'PUT', 'repos/o/r/pulls/1/merge'] }],
  );
  assert.deepEqual(
    r.map((f) => [f.id, f.ok]),
    [
      ['a', true],
      ['b', true],
      ['c', true],
      ['d', false],
    ],
  );
});

test('composeWorld: base scenarios then extras, in source order; stdoutFile copied and rewritten; skip drops', () => {
  const out = mkdtempSync(join(scratchDir(), 'oracle-world-'));
  const n = composeWorld(
    {
      repo: 'powerhouse-inc/powerhouse',
      base: [{ scenario: 'smoke/ci-why', skip: ['005-actions-runs.json'] }],
      extras: 'pr-status',
    },
    out,
  );
  const files = readdirSync(out).filter((f) => f.endsWith('.json'));
  assert.equal(n, files.length);
  assert.ok(!files.some((f) => f.includes('005-actions-runs.json')), 'skipped');
  assert.ok(files[0]?.startsWith('00-'), 'base first');
  assert.ok(files.at(-1)?.startsWith('90-'), 'extras last');
  const fixtures = loadScenario(out);
  const log = fixtures.find((f) => f.stdoutFile !== undefined);
  assert.ok(log && existsSync(join(out, log.stdoutFile as string)), 'the log is copied next to its fixture');
  assert.match(replyStdout(log), /AssertionError/);
  const view = pickFixture(fixtures, ['pr', 'view', '3301'], undefined, { counts: {} });
  assert.match(view.stdout, /^title:\t/);
  assert.throws(
    () => composeWorld({ repo: 'o/r', base: [{ scenario: 'smoke/ci-why', skip: ['nope.json'] }] }, `${out}-2`),
    /no nope\.json to skip/,
  );
});

test('every question has a unique id, one answer per arm, and at least one fact', () => {
  const ids = QUESTIONS.map((q) => q.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const q of QUESTIONS) {
    assert.deepEqual(q.answers.map((a) => a.arm).sort(), [...ARMS].sort(), q.id);
    assert.ok(q.truth.length > 0, q.id);
    for (const a of q.answers) assert.ok(a.steps.length > 0, `${q.id}/${a.arm}`);
  }
  assert.throws(() => selectQuestions(QUESTIONS, ['no-such-question']), /unknown question no-such-question/);
  assert.deepEqual(
    selectQuestions(QUESTIONS, ['pr-status']).map((q) => q.id),
    ['pr-status'],
  );
});

test('M4 done-when: every ghx and gh-expert answer is correct; two runs give the same report bytes', async () => {
  const work = mkdtempSync(join(scratchDir(), 'oracle-run-'));
  const [first, second] = await Promise.all([
    runQuestions(QUESTIONS, { workDir: work, concurrency: 4 }),
    runQuestions(QUESTIONS, { workDir: work, concurrency: 4 }),
  ]);
  const report = buildReport(first);
  const wrong = report.questions.flatMap((q) =>
    q.answers
      .filter((a) => a.arm !== 'gh-typical' && !a.correct)
      .map((a) => {
        const seen = first.find((x) => x.id === q.id)?.answers.find((x) => x.arm === a.arm)?.seen ?? [];
        return `${q.id}/${a.arm} missing ${a.missing.join(', ')}:\n${seen.join('\n---\n').slice(0, 4000)}`;
      }),
  );
  assert.deepEqual(wrong, []);
  assert.equal(report.done, true);
  assert.deepEqual(
    report.questions.map((q) => q.id),
    [...QUESTIONS.map((q) => q.id)].sort(),
  );
  for (const q of report.questions) {
    assert.deepEqual(
      q.answers.map((a) => a.arm),
      [...ARMS],
    );
    for (const a of q.answers) {
      assert.ok(a.toolCalls >= 1 && a.bytes > 0 && a.tokens >= 70 * a.toolCalls, `${q.id}/${a.arm} measured`);
      assert.equal(
        a.tokens,
        a.steps.reduce((n, s) => n + s.tokens, 0),
      );
    }
  }
  const json = serializeReport(report);
  assert.equal(json, serializeReport(buildReport(second)), 'deterministic');
  assert.doesNotMatch(json, new RegExp(work.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'no machine paths');
  const md = renderMarkdown(report);
  assert.match(md, /^\| pr-status \| ghx \| yes \|/m);
});
