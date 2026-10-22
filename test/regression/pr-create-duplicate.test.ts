// Duplicate PRs (03 §5, 02 §2.4; gh-usage-findings §9.4): a head that already has an open PR is
// DUPLICATE_PR (exit 6) pointing at `pr edit`, whether the preflight sees it or a concurrent create wins
// the race (422 "already exists"). A transient POST failure never re-posts blindly: the open-PR re-check
// runs first, and a PR carrying this run's block id is taken as created, so one PR results, not two.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fail, HEAD_OID, INPUT, scene, sequence } from '../commands/pr-create-scene.ts';
import { EXIT } from '../contract/exit-table.ts';
import { runInProcess } from '../helpers/harness.ts';

const ARGV = ['pr', 'create', '-R', 'octo/demo', '--input', '-'];
const stdin = JSON.stringify(INPUT);

test('preflight duplicate: exit 6 and no POST', async () => {
  const s = scene({ branches: { 'feat/retry-banner': { oid: HEAD_OID, prs: [{ number: 3301 }] } } });
  const r = await runInProcess(ARGV, { gh: s.gh, stdin });
  assert.equal(r.exitCode, EXIT.POLICY);
  assert.equal(r.json.error.code, 'DUPLICATE_PR');
  assert.equal(r.json.error.details.existing, 'octo/demo#3301');
  s.gh.expectNoMutations();
});

test('422 race: exit 6 with the winner, and the POST is not retried', async () => {
  const s = scene({
    post: [
      fail(
        422,
        {
          message: 'Validation Failed',
          errors: [{ message: 'A pull request already exists for octo:feat/retry-banner.' }],
        },
        'Unprocessable Entity',
      ),
    ],
    recheck: [{ number: 3302 }],
  });
  const r = await runInProcess(ARGV, { gh: s.gh, stdin });
  assert.equal(r.exitCode, EXIT.POLICY);
  assert.equal(r.json.error.details.existing, 'octo/demo#3302');
  assert.equal(sequence(s.gh).filter((c) => c === 'post').length, 1);
});

test('transient failure whose PR exists with another block id: DUPLICATE_PR, no second POST', async () => {
  const s = scene({
    post: [fail(503, { message: 'unavailable' }, 'Service Unavailable')],
    recheck: [{ number: 3303, body: 'not ours' }],
  });
  const r = await runInProcess(ARGV, { gh: s.gh, stdin });
  assert.equal(r.exitCode, EXIT.POLICY);
  assert.equal(r.json.error.details.existing, 'octo/demo#3303');
  assert.deepEqual(sequence(s.gh).slice(3), ['post', 'recheck']);
});
