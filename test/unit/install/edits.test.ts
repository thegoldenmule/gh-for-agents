// The pure pieces of ghx install: the settings merge, the CLAUDE.md block and the unified diff.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BEGIN, END, installBlock, removeBlock } from '../../../src/install/claude-md.ts';
import { unifiedDiff } from '../../../src/install/diff.ts';
import { hookCommand, shellQuote } from '../../../src/install/files.ts';
import {
  GHX_DENY_RULES,
  inspectSettings,
  installSettings,
  parseSettings,
  recordAdded,
  serializeSettings,
  uninstallSettings,
} from '../../../src/install/settings.ts';
import { WRAPPED_WRITES } from '../../../src/passthrough/policy.ts';

const CMD = "'/n' '/g/bin/ghx.js' hook claude-pretooluse";

test('the deny rules are exactly the gh writes the hook denies, one prefix rule each', () => {
  assert.deepEqual(
    GHX_DENY_RULES,
    [...WRAPPED_WRITES].map((w) => `Bash(gh ${w}:*)`),
  );
  assert.equal(GHX_DENY_RULES.length, 8);
});

test('installSettings keeps other keys and order, adds missing deny rules once, and one ghx hook', () => {
  const before = {
    model: 'opus',
    permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(rm:*)', 'Bash(gh pr merge:*)'] },
    hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'lint' }] }] },
  };
  const after = installSettings(before, { deny: true, hookCommand: CMD });
  assert.deepEqual(Object.keys(after), ['model', 'permissions', 'hooks']);
  const deny = (after.permissions as { deny: string[] }).deny;
  assert.deepEqual(deny.slice(0, 2), ['Bash(rm:*)', 'Bash(gh pr merge:*)']);
  assert.equal(deny.filter((r) => r === 'Bash(gh pr merge:*)').length, 1);
  assert.equal(deny.length, 1 + GHX_DENY_RULES.length);
  assert.deepEqual((after.hooks as { PreToolUse: unknown[] }).PreToolUse, [
    { matcher: 'Edit', hooks: [{ type: 'command', command: 'lint' }] },
    { matcher: 'Bash|Monitor', hooks: [{ type: 'command', command: CMD, timeout: 5 }] },
  ]);
  assert.deepEqual(installSettings(after, { deny: true, hookCommand: CMD }), after, 'idempotent');
  assert.equal(before.permissions.deny.length, 2, 'the input is not mutated');
});

test('a re-install replaces an older ghx hook in place, including the bare manual one', () => {
  const s = {
    hooks: {
      PreToolUse: [
        { matcher: 'Bash|Monitor', hooks: [{ type: 'command', command: 'ghx hook claude-pretooluse', timeout: 5 }] },
        { matcher: 'Write', hooks: [{ type: 'command', command: 'fmt' }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: '/old/ghx hook claude-pretooluse' }] },
      ],
    },
  };
  const after = installSettings(s, { deny: false, hookCommand: CMD });
  assert.deepEqual(
    (after.hooks as { PreToolUse: { matcher: string }[] }).PreToolUse.map((g) => g.matcher),
    ['Bash|Monitor', 'Write'],
  );
  assert.deepEqual(inspectSettings(after).hookCommands, [CMD]);
  assert.equal(after.permissions, undefined, '--no-deny adds no permissions');
});

test('hook mode: deny sets env.GHX_HOOK_MODE, ask removes it, omitted leaves env alone', () => {
  const withDeny = installSettings({ env: { A: '1' } }, { deny: false, hookCommand: null, hookMode: 'deny' });
  assert.deepEqual(withDeny.env, { A: '1', GHX_HOOK_MODE: 'deny' });
  assert.deepEqual(installSettings(withDeny, { deny: false, hookCommand: null, hookMode: 'ask' }).env, { A: '1' });
  assert.deepEqual(installSettings(withDeny, { deny: false, hookCommand: null }).env, withDeny.env);
  assert.equal(
    installSettings({ env: { GHX_HOOK_MODE: 'deny' } }, { deny: false, hookCommand: null, hookMode: 'ask' }).env,
    undefined,
  );
});

test('recordAdded names only what ghx added; uninstallSettings takes exactly that out', () => {
  const orig = {
    permissions: { deny: ['Bash(rm:*)', 'Bash(gh pr merge:*)'] },
    hooks: { PreToolUse: [] },
    env: { X: '1', GHX_HOOK_MODE: 'off' },
  };
  const none = { deny: [], containers: [], hookMode: null };
  const installed = installSettings(orig, { deny: true, hookCommand: CMD, hookMode: 'deny' });
  const added = recordAdded(none, orig, installed);
  assert.ok(!added.deny.includes('Bash(gh pr merge:*)'), "the user's own identical rule is not ghx's");
  assert.equal(added.deny.length, GHX_DENY_RULES.length - 1);
  assert.deepEqual(added.containers, [], 'every container was already there');
  assert.deepEqual(added.hookMode, { set: 'deny', prev: 'off' });
  assert.deepEqual(uninstallSettings(installed, added), orig, 'the empty PreToolUse and the user rule stay');
  // A second install folds into the first record; a fresh file owns every container it got.
  assert.deepEqual(recordAdded(added, installed, installed), added);
  const fresh = installSettings({}, { deny: true, hookCommand: CMD });
  const freshAdded = recordAdded(none, {}, fresh);
  assert.deepEqual(freshAdded.containers, ['permissions', 'permissions.deny', 'hooks', 'hooks.PreToolUse']);
  assert.deepEqual(uninstallSettings(fresh, freshAdded), {});
  assert.deepEqual(uninstallSettings({ env: { GHX_HOOK_MODE: 'weird' } }, freshAdded), {
    env: { GHX_HOOK_MODE: 'weird' },
  });
});

test('parseSettings refuses what it cannot merge into, with the path in details', () => {
  assert.deepEqual(parseSettings(null, '/s'), {});
  assert.deepEqual(parseSettings(' \n', '/s'), {});
  for (const bad of [
    '{"a":',
    '[]',
    '{"permissions":[]}',
    '{"permissions":{"deny":{}}}',
    '{"hooks":{"PreToolUse":{}}}',
    '{"env":1}',
  ]) {
    assert.throws(
      () => parseSettings(bad, '/s'),
      (e: { code?: string; details?: { path?: string } }) =>
        e.code === 'INSTALL_SETTINGS_INVALID' && e.details?.path === '/s',
      bad,
    );
  }
});

test('serializeSettings keeps the indentation and trailing-newline choice of the original', () => {
  assert.equal(serializeSettings({ a: 1 }, null), '{\n  "a": 1\n}\n');
  assert.equal(serializeSettings({ a: 1 }, '{\n\t"b": 2\n}'), '{\n\t"a": 1\n}');
  assert.equal(serializeSettings({ a: [1] }, '{\n    "b": 2\n}\n'), '{\n    "a": [\n        1\n    ]\n}\n');
});

test('CLAUDE.md block: appended after a blank line, replaced in place, removed byte for byte', () => {
  const orig = '# Rules\n\n- one\n';
  const once = installBlock(orig, '## ghx\n\nv1\n', '/c');
  assert.equal(once, `${orig}\n${BEGIN}\n## ghx\n\nv1\n${END}\n`);
  assert.equal(installBlock(once, '## ghx\n\nv1\n', '/c'), once, 'idempotent');
  const edited = `${once}\n## Mine\n`;
  const twice = installBlock(edited, '## ghx\n\nv2\n', '/c');
  assert.equal(twice, `${orig}\n${BEGIN}\n## ghx\n\nv2\n${END}\n\n## Mine\n`);
  assert.equal(removeBlock(once, '/c'), orig);
  assert.equal(removeBlock(twice, '/c'), `${orig}\n## Mine\n`);
  assert.equal(removeBlock(orig, '/c'), orig);
  assert.equal(removeBlock(installBlock(null, 'x', '/c'), '/c'), '');
  assert.equal(removeBlock(installBlock('no newline', 'x', '/c'), '/c'), 'no newline\n');
});

test('CLAUDE.md block: stray or repeated markers are refused', () => {
  for (const bad of [`${BEGIN}\nx\n`, `x\n${END}\n`, `${END}\n${BEGIN}\n`, `${BEGIN}\n${END}\n${BEGIN}\n${END}\n`]) {
    assert.throws(
      () => installBlock(bad, 's', '/c'),
      (e: { code?: string }) => e.code === 'INSTALL_CLAUDE_MD_INVALID',
      bad,
    );
  }
});

test('unifiedDiff: hunks with three lines of context, and /dev/null for a new file', () => {
  const a = 'a\nb\nc\nd\ne\nf\ng\nh\ni\n';
  const b = 'a\nb\nc\nd\nE\nf\ng\nh\ni\n';
  assert.equal(unifiedDiff('/f', a, b), '--- /f\n+++ /f\n@@ -2,7 +2,7 @@\n b\n c\n d\n-e\n+E\n f\n g\n h\n');
  assert.equal(unifiedDiff('/f', null, 'x\n'), '--- /dev/null\n+++ /f\n@@ -0,0 +1 @@\n+x\n');
  assert.equal(unifiedDiff('/f', a, a), '');
});

test('the hook command shell-quotes both absolute paths', () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(hookCommand('/a b/node', '/r/bin/ghx.js'), "'/a b/node' '/r/bin/ghx.js' hook claude-pretooluse");
  assert.match(hookCommand(), /^'\/.+' '\/.+\/bin\/ghx\.js' hook claude-pretooluse$/);
});
