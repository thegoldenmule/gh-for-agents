// Agent docs (03 M12.1): the generated docs match the specs, and the snippet carries 02 §11.0's
// protocol sentence verbatim, so the one way to wait for CI can't drift.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { generate, ROOT } from '../scripts/docs/gen.ts';
import { PROTOCOL } from '../src/commands/ci/wait.ts';
import { ExitCode } from '../src/core/exit.ts';
import { GHX_DENY_RULES } from '../src/install/settings.ts';
import { decide } from '../src/passthrough/policy.ts';

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

test('hooks.md: the settings block parses, denies only wrapped gh writes, and registers the hook for Bash|Monitor', () => {
  const md = read('docs/agents/hooks.md');
  const block = /## Settings[\s\S]*?```json\n([\s\S]*?)```/.exec(md)?.[1];
  assert.ok(block, 'a json block under ## Settings');
  const settings = JSON.parse(block) as {
    permissions: { deny: string[] };
    hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string }[] }[] };
  };
  // The same list ghx install writes (one source: WRAPPED_WRITES).
  assert.deepEqual(settings.permissions.deny, GHX_DENY_RULES);
  for (const rule of settings.permissions.deny) {
    const words = (/^Bash\(gh (.+):\*\)$/.exec(rule)?.[1] ?? '').split(' ');
    const d = decide(words);
    assert.ok(d.kind === 'refuse' && d.error.code === 'USAGE_UNKNOWN_COMMAND', `${rule} is a wrapped gh command`);
    const suggestion = (d.error.details as { suggestion?: string[] } | null)?.suggestion;
    assert.equal(suggestion?.[0], 'ghx', `${rule} names its ghx replacement`);
  }
  assert.deepEqual(
    settings.hooks.PreToolUse.map((h) => [h.matcher, h.hooks[0]?.type, h.hooks[0]?.command]),
    [['Bash|Monitor', 'command', 'ghx hook claude-pretooluse']],
  );
});
