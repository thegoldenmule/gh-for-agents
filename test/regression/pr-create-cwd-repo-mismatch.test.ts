// The pr create half of the cwd/repo mismatch (sektar #3258; 02 §1.2 rule 4; 03 §5.2 R10). The cwd is
// a checkout of another repo: config comes from the TARGET repo through the contents API, local git is
// never consulted (no rev-parse, no diff), and the output warns CWD_REPO_MISMATCH.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Git } from '../../src/git/index.ts';
import { INPUT, scene, sequence } from '../commands/pr-create-scene.ts';
import { EXIT } from '../contract/exit-table.ts';
import { gitCheckout } from '../helpers/fake-git.ts';
import { runInProcess } from '../helpers/harness.ts';

test('cwd is powerhouse-inc/sektar, -R octo/demo: remote config, no local git, CWD_REPO_MISMATCH', async () => {
  const s = scene({ files: Array.from({ length: 300 }, (_, i) => `src/f${i}.ts`) });
  const used: string[] = [];
  const base = gitCheckout('powerhouse-inc/sektar', { refs: { 'refs/heads/feat/retry-banner': 'd'.repeat(40) } });
  const git: Git = {
    ...base,
    revParse: async (ref) => {
      used.push(`rev-parse ${ref}`);
      return base.revParse(ref);
    },
    diffNames: async (a, b) => {
      used.push(`diff ${a}...${b}`);
      return base.diffNames(a, b);
    },
  };
  const r = await runInProcess(['pr', 'create', '-R', 'octo/demo', '--input', '-'], {
    gh: s.gh,
    git,
    stdin: JSON.stringify(INPUT),
  });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(sequence(s.gh), ['config', 'preflight', 'compare', 'post', 'readback']);
  assert.deepEqual(used, [], 'no local git step runs against the wrong checkout');
  const codes = r.json.warnings.map((w: { code: string }) => w.code);
  assert.deepEqual(codes, ['CWD_REPO_MISMATCH', 'COMPONENTS_UNCHECKED']);
  assert.match(r.json.warnings[0].message, /powerhouse-inc\/sektar.*octo\/demo/);
});

test('a cwd outside any checkout with no -R is REPO_NOT_FOUND (exit 5) before any gh call', async () => {
  const s = scene();
  const r = await runInProcess(['pr', 'create', '--input', '-'], { gh: s.gh, stdin: JSON.stringify(INPUT) });
  assert.equal(r.exitCode, EXIT.NOT_FOUND, r.stdout);
  assert.equal(r.json.error.code, 'REPO_NOT_FOUND');
  assert.deepEqual(s.gh.calls, []);
});
