// Agent docs (03 M12.1): the generated docs match the specs, and the snippet carries 02 §11.0's
// protocol sentence verbatim, so the one way to wait for CI can't drift.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { generate, ROOT } from '../scripts/docs/gen.ts';
import { PROTOCOL } from '../src/commands/ci/wait.ts';
import { ExitCode } from '../src/core/exit.ts';

const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

test('generated agent docs are up to date (run pnpm docs:gen)', async () => {
  for (const [path, content] of await generate()) {
    let onDisk: string | undefined;
    try {
      onDisk = read(path);
    } catch {
      onDisk = undefined;
    }
    assert.ok(onDisk === content, `${path} is stale: run pnpm docs:gen`);
  }
});

test('the CLAUDE.md snippet and the skill carry the ci wait protocol verbatim', () => {
  assert.ok(read('docs/agents/claude-md-snippet.md').includes(PROTOCOL));
  assert.ok(read('docs/agents/skill/ghx/SKILL.md').includes(PROTOCOL));
});

test('the snippet covers the notification label, --input files and every exit code', () => {
  const s = read('docs/agents/claude-md-snippet.md');
  assert.match(s, /"failed" in the task notification\. That label is not the outcome/);
  assert.match(s, /--input path\.json/);
  assert.match(s, /Write tool/);
  for (const code of new Set(Object.values(ExitCode))) {
    assert.match(s, new RegExp(`^\\| ${code}[ ,|]|, ${code} \\|`, 'm'), `exit ${code} is in the table`);
  }
});

test('the skill has name and description frontmatter', () => {
  const s = read('docs/agents/skill/ghx/SKILL.md');
  const m = /^---\nname: ghx\ndescription: (.+)\n---\n/.exec(s);
  assert.ok(m, 'frontmatter with name and description');
  assert.ok((m[1] ?? '').length <= 1024);
});

test('the reference lists every command', async () => {
  const ref = read('docs/agents/commands.md');
  const { loadSpecs } = await import('../scripts/docs/gen.ts');
  for (const spec of await loadSpecs()) assert.ok(ref.includes(`## ghx ${spec.name.join(' ')}\n`), spec.name.join(' '));
});
