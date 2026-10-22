import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  combineRegistries,
  commandRoots,
  fsRegistry,
  scanCommandFiles,
  staticRegistry,
} from '../../../src/cli/registry.ts';
import versionSpec from '../../../src/commands/version.ts';
import { isGhxError } from '../../../src/core/errors.ts';

const tmp = mkdtempSync(join(tmpdir(), 'ghx-reg-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const CORE = join(import.meta.dirname, '../../../src/core/command.ts');
const ZOD = import.meta.resolve('zod');
const spec = (name: string[]) => `import { z } from ${JSON.stringify(ZOD)};
import { defineCommand } from ${JSON.stringify(CORE)};
export default defineCommand({ name: ${JSON.stringify(name)}, summary: 's', kind: 'read', needs: { repo: 'none' },
  input: z.strictObject({}), output: z.object({}), async run() { return {}; } });
`;

test('fs registry: path is the name, helpers are skipped, longest prefix wins', async () => {
  const root = join(tmp, 'a');
  mkdirSync(join(root, 'pr', '_lib'), { recursive: true });
  mkdirSync(join(root, '_private'), { recursive: true });
  writeFileSync(join(root, 'doctor.ts'), spec(['doctor']));
  writeFileSync(join(root, 'pr', 'status.ts'), spec(['pr', 'status']));
  writeFileSync(join(root, 'pr', '_shared.ts'), 'export const x = 1;\n');
  writeFileSync(join(root, 'pr', '_lib', 'thing.ts'), 'export const y = 1;\n');
  writeFileSync(join(root, '_private', 'hidden.ts'), spec(['hidden']));
  writeFileSync(join(root, 'README.md'), 'not a command');
  const reg = fsRegistry([root]);
  assert.deepEqual(await reg.names(), [['doctor'], ['pr', 'status']]);
  const hit = await reg.resolve(['pr', 'status', '3198']);
  assert.equal(hit?.consumed, 2);
  assert.deepEqual(hit?.spec.name, ['pr', 'status']);
  assert.equal(await reg.resolve(['pr']), undefined);
  assert.equal(await reg.resolve(['pr', '_shared']), undefined);
  assert.equal(await reg.resolve(['..', 'x']), undefined);
  assert.deepEqual(
    (await reg.list()).map((s) => s.name.join(' ')),
    ['doctor', 'pr status'],
  );
});

test('a file whose declared name disagrees with its path is INTERNAL', async () => {
  const root = join(tmp, 'b');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'wrong.ts'), spec(['right']));
  await assert.rejects(fsRegistry([root]).resolve(['wrong']), (e) => isGhxError(e, 'INTERNAL'));
});

test('scanCommandFiles skips uppercase/invalid names and is sorted', () => {
  const root = join(tmp, 'c');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'Bad.ts'), '');
  writeFileSync(join(root, 'b.ts'), '');
  writeFileSync(join(root, 'a.ts'), '');
  assert.deepEqual(
    scanCommandFiles(root).map((c) => c.name.join(' ')),
    ['a', 'b'],
  );
});

test('static and combined registries', async () => {
  const reg = combineRegistries(staticRegistry([versionSpec]), staticRegistry([]));
  assert.equal((await reg.resolve(['version']))?.spec, versionSpec);
  assert.deepEqual(await reg.names(), [['version']]);
});

test('the test-only root is added only with GHX_TEST_HOOKS=1', () => {
  const src = join(import.meta.dirname, '../../../src');
  assert.equal(commandRoots({}, src).length, 1);
  assert.equal(commandRoots({ GHX_TEST_HOOKS: '1' }, src).length, 2);
});
