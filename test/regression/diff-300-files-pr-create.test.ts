// The pr create half of R15 (03 §5.2; gh-usage-findings §3.1, §9.10): GitHub's compare stops listing
// files at 300. When the cwd is the target, local `git diff --name-only` fills in the list; otherwise
// components go unchecked with the warning COMPONENTS_UNCHECKED (createNetworkRules).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASE_OID, HEAD_OID, INPUT, localCheckout, scene } from '../commands/pr-create-scene.ts';
import { EXIT } from '../contract/exit-table.ts';
import { gitCheckout } from '../helpers/fake-git.ts';
import { runInProcess } from '../helpers/harness.ts';

const capped = Array.from({ length: 300 }, (_, i) => `src/f${i}.ts`);

test('R15 (pr create): 300 compare files + matching cwd → local git diff; an undeclared component is added', async () => {
  const s = scene({ remoteConfig: false, files: capped });
  const git = gitCheckout('octo/demo', {
    toplevel: localCheckout(),
    diffs: { [`${BASE_OID}...${HEAD_OID}`]: [...capped, 'docs/guide.md'] },
  });
  const r = await runInProcess(['pr', 'create', '--input', '-', '--dry-run'], {
    gh: s.gh,
    git,
    stdin: JSON.stringify(INPUT),
  });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const added = r.json.warnings.find((w: { code: string }) => w.code === 'COMPONENTS_ADDED');
  assert.match(added?.message ?? '', /Added docs \(docs\/guide\.md\)/);
  assert.match(r.json.preview.body, /Components: app, docs/);
});

test('R15 (pr create): 300 compare files and no checkout → COMPONENTS_UNCHECKED, the PR is still created', async () => {
  const s = scene({ files: capped });
  const r = await runInProcess(['pr', 'create', '-R', 'octo/demo', '--input', '-'], {
    gh: s.gh,
    stdin: JSON.stringify(INPUT),
  });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(
    r.json.warnings.map((w: { code: string }) => w.code),
    ['COMPONENTS_UNCHECKED'],
  );
});
