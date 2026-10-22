// The real binary as Claude Code runs it (03 M12.2): the reply on stdout, exit 0 on every path, and
// a stdin that never closes gives up quietly instead of hanging the tool call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnGhx } from '../helpers/spawn.ts';

const event = JSON.stringify({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'ghx ci wait 12', description: 'Wait for CI' },
});

test('the spawned hook rewrites a foreground ghx ci wait and exits 0', async () => {
  const r = await spawnGhx(['hook', 'claude-pretooluse'], { stdin: event });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(JSON.parse(r.stdout), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { command: 'ghx ci wait 12', description: 'Wait for CI', run_in_background: true },
    },
  });
});

test('unparseable stdin: exit 0, nothing on stdout', async () => {
  const r = await spawnGhx(['hook', 'claude-pretooluse'], { stdin: 'not json {' });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, '');
});

test('a stdin that never closes: exit 0 with no output after the 2 s give-up', async () => {
  const r = await spawnGhx(['hook', 'claude-pretooluse'], { openStdin: true, timeoutMs: 10_000 });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, '');
});
