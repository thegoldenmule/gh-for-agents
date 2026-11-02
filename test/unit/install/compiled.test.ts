// The standalone binary (bun build --compile) in install and doctor: hook commands of both shapes, the
// warnings for a hook that runs another ghx, --bin-dir and npx. The compiled runtime is injected, so this
// runs under Node.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Git } from '../../../src/git/index.ts';
import {
  binaryHookCommand,
  commitBinLink,
  nodeHookCommand,
  planBinLink,
  planBinUnlink,
} from '../../../src/install/files.ts';
import { hookWarnings, inspectInstall } from '../../../src/install/inspect.ts';
import { runsFromNpx } from '../../../src/install/npx.ts';
import type { Runtime } from '../../../src/util/runtime.ts';
import { VERSION } from '../../../src/version.ts';

const tmp = mkdtempSync(join(tmpdir(), 'ghx-inspect-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const exe = join(tmp, 'ghx');
writeFileSync(exe, '');
const node = join(tmp, 'node');
writeFileSync(node, '');
const pkg = join(tmp, 'pkg');
mkdirSync(join(pkg, 'bin'), { recursive: true });
writeFileSync(join(pkg, 'bin', 'ghx.js'), '');
writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version: VERSION }));

const compiled: Runtime = { compiled: true, name: 'bun', version: '1.3.8', execPath: exe };
const onNode: Runtime = { compiled: false, name: 'node', version: '24.1.0', execPath: node };
const noGit = { available: async () => false } as unknown as Git;

let n = 0;
async function inspect(command: string, runtime: Runtime, versionOf?: (exe: string) => Promise<string | null>) {
  const home = join(tmp, `home-${n++}`);
  mkdirSync(join(home, '.claude'), { recursive: true });
  const settings = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] } };
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(settings));
  const r = await inspectInstall({ HOME: home }, noGit, { runtime, ...(versionOf ? { versionOf } : {}) });
  assert.ok(r.user);
  return r.user.hook;
}

test('a binary hook that is this executable: its version is ours, no probe, no warnings', async () => {
  const probed: string[] = [];
  const hook = await inspect(binaryHookCommand(exe), compiled, async (e) => {
    probed.push(e);
    return null;
  });
  assert.equal(hook.installed, true);
  assert.equal(hook.node, null);
  assert.equal(hook.binary, exe);
  assert.equal(hook.version, VERSION);
  assert.deepEqual(probed, []);
  assert.deepEqual(hookWarnings('user', hook, compiled), []);
});

test('a binary hook that is another executable: doctor asks it its version', async () => {
  const other = join(tmp, 'other-ghx');
  writeFileSync(other, '');
  const hook = await inspect(binaryHookCommand(other), compiled, async (e) => (e === other ? '0.0.1' : null));
  assert.equal(hook.binary, other);
  assert.equal(hook.version, '0.0.1');
  assert.deepEqual(
    hookWarnings('user', hook, compiled).map((w) => w.code),
    ['INSTALL_HOOK_VERSION_MISMATCH'],
  );
  // Same version, other path: nothing to say (as for two npm installs of one version).
  const same = await inspect(binaryHookCommand(other), compiled, async () => VERSION);
  assert.deepEqual(hookWarnings('user', same, compiled), []);
  // No way to ask (or it did not answer): version unknown, still no node mismatch.
  const unknown = await inspect(binaryHookCommand(other), compiled);
  assert.equal(unknown.version, null);
  assert.deepEqual(hookWarnings('project', unknown, compiled), []);
});

test('an npm hook seen from the binary is another install, never a node mismatch', async () => {
  const hook = await inspect(nodeHookCommand(node, join(pkg, 'bin', 'ghx.js')), compiled);
  assert.equal(hook.node, node);
  assert.equal(hook.binary, null);
  assert.equal(hook.version, VERSION);
  const w = hookWarnings('project', hook, compiled);
  assert.deepEqual(
    w.map((x) => x.code),
    ['INSTALL_HOOK_OTHER_INSTALL'],
  );
  assert.match(w[0]?.message ?? '', /runs ghx on Node\.js .*\(the standalone binary .*ghx install --scope project/);
});

test('a binary hook seen from npm ghx is another install; node to node keeps the node mismatch', async () => {
  const hook = await inspect(binaryHookCommand(exe), onNode, async () => VERSION);
  assert.deepEqual(
    hookWarnings('user', hook, onNode).map((w) => w.code),
    ['INSTALL_HOOK_OTHER_INSTALL'],
  );
  const npm = await inspect(nodeHookCommand(node, join(pkg, 'bin', 'ghx.js')), onNode);
  assert.deepEqual(hookWarnings('user', npm, onNode), []);
  const otherNode = { ...onNode, execPath: join(tmp, 'node-2') };
  assert.deepEqual(
    hookWarnings('user', npm, otherNode).map((w) => w.code),
    ['INSTALL_HOOK_NODE_MISMATCH'],
  );
});

test('a hook whose paths are gone is left to INSTALL_HOOK_STALE', async () => {
  const hook = await inspect(binaryHookCommand(join(tmp, 'gone')), compiled, async () => '0.0.1');
  assert.equal(hook.version, null);
  assert.deepEqual(hook.missingPaths, [join(tmp, 'gone')]);
  assert.deepEqual(hookWarnings('user', hook, compiled), []);
});

test('--bin-dir from the binary: links to the executable, and the executable itself in the dir is left alone', () => {
  const dir = join(tmp, 'bindir');
  mkdirSync(dir);
  const link = planBinLink(dir, { PATH: dir }, exe);
  assert.deepEqual(link, { path: join(dir, 'ghx'), target: exe, action: 'created', onPath: true });
  commitBinLink(link);
  assert.equal(readlinkSync(join(dir, 'ghx')), exe);
  assert.equal(planBinLink(dir, {}, exe).action, 'unchanged');
  assert.equal(planBinUnlink(dir, {}, undefined, exe).action, 'removed');
  // install.sh put the binary straight into the dir: nothing to link, and uninstall never removes it.
  const home = join(tmp, 'local-bin');
  mkdirSync(home);
  const installed = join(home, 'ghx');
  writeFileSync(installed, '');
  assert.equal(planBinLink(home, {}, installed).action, 'unchanged');
  assert.equal(planBinUnlink(home, {}, installed, installed).action, 'unchanged');
  assert.throws(() => planBinLink(home, {}, exe), /INSTALL_BIN_CONFLICT|already exists/);
});

test('runsFromNpx is never true for the binary', () => {
  assert.equal(runsFromNpx('/$bunfs', { npm_command: 'exec' }, compiled), false);
  assert.equal(runsFromNpx('/x/_npx/1/node_modules/@thegoldenmule/ghx', {}, compiled), false);
  assert.equal(runsFromNpx('/x/_npx/1/node_modules/@thegoldenmule/ghx', {}, onNode), true);
});
