// src/ci/wait/targets.ts: the one target grammar of ci wait, ci why and ci rerun (02 §11.5, §12, §13.1).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  boundKey,
  headPolicy,
  parseCiTarget,
  parseWaitTarget,
  targetArg,
  targetKey,
  targetLabel,
} from '../../../../src/ci/wait/targets.ts';

const repo = { host: 'github.com', owner: 'o', name: 'r' };
const usage = (hint: RegExp) => (e: unknown) => {
  const err = e as { code?: string; hint?: string };
  assert.equal(err.code, 'USAGE_BAD_SELECTOR');
  assert.match(err.hint ?? '', hint);
  return true;
};

test('run:<id>, a run URL and a job URL are run targets; a URL carries its repo', () => {
  assert.deepEqual(parseWaitTarget('run:40345582950'), { kind: 'run', raw: 'run:40345582950', runId: 40345582950 });
  assert.deepEqual(parseWaitTarget('https://github.com/a/b/actions/runs/5/attempts/2'), {
    kind: 'run',
    raw: 'run:5',
    runId: 5,
    repo: { host: 'github.com', owner: 'a', name: 'b' },
  });
  const job = parseWaitTarget('https://github.com/a/b/actions/runs/5/job/9');
  assert.equal(job.kind === 'run' && job.runId, 5);
  assert.deepEqual(parseWaitTarget('run:https://github.com/a/b/actions/runs/6'), {
    kind: 'run',
    raw: 'run:6',
    runId: 6,
    repo: { host: 'github.com', owner: 'a', name: 'b' },
  });
  assert.throws(() => parseWaitTarget('run:'), usage(/run:<id>/));
  assert.throws(() => parseWaitTarget('run:abc'), usage(/run:<id>/));
  assert.throws(() => parseWaitTarget('run:0'), usage(/run:<id>/));
});

test('a run target: its own key, label and -R argument; it never follows a head', () => {
  const t = parseWaitTarget('run:77');
  assert.equal(targetKey(t), 'run-77');
  assert.equal(boundKey(t, 'a'.repeat(40)), 'run-77');
  assert.equal(targetLabel(t, repo), 'run:77');
  assert.equal(targetArg(t, repo), 'run:77 -R o/r');
  assert.equal(headPolicy(t, undefined), 'stay');
  assert.equal(headPolicy(t, 'restart'), 'stay');
});

test('targetArg: a PR ref embeds its repo; an unpinned branch is pinned to the given SHA', () => {
  assert.equal(targetArg(parseWaitTarget('12'), repo), 'o/r#12');
  assert.equal(
    targetArg(parseWaitTarget('branch:main'), repo, 'abcdef1'.padEnd(40, '0')),
    'branch:main@abcdef1 -R o/r',
  );
  assert.equal(targetArg(parseWaitTarget('branch:main@9f2c4e1'), repo, 'f'.repeat(40)), 'branch:main@9f2c4e1 -R o/r');
});

test('a bare branch name is refused with the explicit branch: form (never guessed)', () => {
  assert.throws(() => parseWaitTarget('main'), usage(/ci wait branch:main/));
  assert.throws(() => parseWaitTarget('release/1.2'), usage(/branch:release\/1\.2/));
  // A command that takes no branch does not suggest one.
  assert.throws(() => parseCiTarget('main', 'ci rerun', ['pr', 'run']), usage(/takes a PR .*run:<id>/));
});

test('each command accepts only its kinds, and says which it takes', () => {
  assert.throws(
    () => parseCiTarget('branch:main', 'ci rerun', ['pr', 'run']),
    (e: unknown) => {
      assert.match((e as Error).message, /'branch:main' is not a ci rerun target/);
      assert.match((e as { hint: string }).hint, /does not take branch:<name>/);
      return true;
    },
  );
  assert.throws(() => parseCiTarget('run:5', 'pr thing', ['pr']), usage(/does not take run:<id>/));
  assert.equal(parseCiTarget('o/r#3', 'ci why').kind, 'pr');
});
