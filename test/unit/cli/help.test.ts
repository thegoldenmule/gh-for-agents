// Global help stays under the 4 KB contract (01 §7) with room for the full v1 command set.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { globalHelp } from '../../../src/cli/help.ts';
import type { AnyCommandSpec } from '../../../src/core/command.ts';

/** A worst-case spec: the longest summary the registry allows (100 chars) and a replaces list. */
function fakeSpec(i: number): AnyCommandSpec {
  return {
    name: ['groupname', `command-${String(i).padStart(2, '0')}`],
    kind: i % 2 === 0 ? 'read' : 'write',
    mode: i % 5 === 0 ? 'stream' : 'single',
    summary: `Command ${i}: ${'x'.repeat(100)}`.slice(0, 100),
    replaces: ['gh pr view --json a,b,c', 'gh api repos/{o}/{r}/pulls/{n}/reviews', 'gh run view --log-failed'],
  } as unknown as AnyCommandSpec;
}

test('global help with 20 worst-case commands is under 4 KB, one short line per command', () => {
  const specs = Array.from({ length: 20 }, (_, i) => fakeSpec(i));
  const help = globalHelp(specs, '0.1.0');
  const bytes = Buffer.byteLength(JSON.stringify(help));
  assert.ok(bytes < 4096, `${bytes} bytes`);
  const commands = help.commands as Record<string, string>;
  assert.equal(Object.keys(commands).length, 20 + 2, '20 commands plus the help and schema builtins');
  for (const line of Object.values(commands)) assert.match(line, /^(read|write): \S/);
  assert.match(commands['groupname command-01'] ?? '', /^write: Command 1:/);
  assert.match(commands.help ?? '', /^read: /);
});
