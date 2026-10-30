// Where a ghx ci wait runs (src/hook/wait.ts): the main thread in the background, a subagent in the
// foreground with --foreground and the Bash tool's 10-minute timeout.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASH_TIMEOUT_CAP_MS, isSubagent, runWaitAdvice, startsWithWait, waitRewrite } from '../../../src/hook/wait.ts';

const MAIN = { session_id: 's' };
const SUB = { session_id: 's', agent_id: 'a1b2', agent_type: 'general-purpose' };

test('isSubagent: a non-empty string agent_id, nothing else', () => {
  assert.equal(isSubagent(SUB), true);
  for (const ev of [MAIN, { agent_id: '' }, { agent_id: 7 }, { agent_type: 'general-purpose' }]) {
    assert.equal(isSubagent(ev), false, JSON.stringify(ev));
  }
});

test('startsWithWait: ghx ci wait after env assignments only', () => {
  for (const c of ['ghx ci wait 1', '  ghx ci wait 1', "A='x y' ghx ci wait 1", 'ghx ci wait']) {
    assert.equal(startsWithWait(c), true, c);
  }
  for (const c of ['ghx ci why 1', 'cd x && ghx ci wait 1', 'echo ghx ci wait 1', 'ghx ci waiter 1']) {
    assert.equal(startsWithWait(c), false, c);
  }
});

test('main thread: background, the input otherwise unchanged', () => {
  const input = { command: 'ghx ci wait 12', description: 'Wait', timeout: 120_000 };
  assert.deepEqual(waitRewrite(MAIN, input), { kind: 'background', input: { ...input, run_in_background: true } });
  assert.deepEqual(waitRewrite(MAIN, { command: 'ghx ci wait 12', run_in_background: false })?.kind, 'background');
});

test('subagent: foreground, --foreground after the verb, timeout raised to the cap', () => {
  const input = { command: 'ghx ci wait 12 --until mergeable', description: 'Wait' };
  assert.deepEqual(waitRewrite(SUB, input), {
    kind: 'foreground',
    input: {
      command: 'ghx ci wait --foreground 12 --until mergeable',
      description: 'Wait',
      timeout: BASH_TIMEOUT_CAP_MS,
    },
  });
  assert.equal(
    waitRewrite(SUB, { command: 'GHX_X=1 ghx ci wait 12 -R o/r | head -c 500' })?.input.command,
    'GHX_X=1 ghx ci wait --foreground 12 -R o/r | head -c 500',
  );
  assert.equal(waitRewrite(SUB, { command: 'ghx ci wait' })?.input.command, 'ghx ci wait --foreground');
  assert.equal(BASH_TIMEOUT_CAP_MS, 600_000);
});

test('an explicit --foreground stays in the foreground on the main thread too; only the timeout changes', () => {
  for (const ev of [MAIN, SUB]) {
    const r = waitRewrite(ev, { command: 'ghx ci wait 12 --foreground', timeout: 30_000 });
    assert.deepEqual(r, {
      kind: 'foreground',
      input: { command: 'ghx ci wait 12 --foreground', timeout: BASH_TIMEOUT_CAP_MS },
    });
    assert.equal(waitRewrite(ev, { command: 'ghx ci wait 12 --foreground', timeout: BASH_TIMEOUT_CAP_MS }), null);
  }
  assert.equal(
    waitRewrite(SUB, { command: 'ghx ci wait 12', timeout: BASH_TIMEOUT_CAP_MS })?.input.command,
    'ghx ci wait --foreground 12',
    'the cap alone is not the flag',
  );
});

test('left alone: run_in_background: true, --help, -h, --schema, other commands, no string command', () => {
  for (const ev of [MAIN, SUB]) {
    assert.equal(waitRewrite(ev, { command: 'ghx ci wait 12', run_in_background: true }), null);
    for (const c of ['ghx ci wait --help', 'ghx ci wait -h', 'ghx ci wait --schema', 'ghx ci why 12', 'ls']) {
      assert.equal(waitRewrite(ev, { command: c }), null, c);
    }
    assert.equal(waitRewrite(ev, { command: 42 }), null);
  }
});

test('runWaitAdvice: background for main, foreground with --foreground and the exit-15 rule for a subagent', () => {
  assert.match(runWaitAdvice('ghx ci wait 7', false), /run_in_background: true/);
  const sub = runWaitAdvice('ghx ci wait 7', true);
  assert.match(sub, /`ghx ci wait 7 --foreground`/);
  assert.match(sub, /exit 15 re-run the identical command/);
  assert.doesNotMatch(sub, /run_in_background: true/);
});
