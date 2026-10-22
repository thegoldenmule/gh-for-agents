// Artifact store (01 §8): deterministic paths, and pruning that only ever touches ghx's own files.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createArtifactStore, PRUNE_AFTER_MS } from '../../../src/core/artifacts.ts';
import { FakeClock } from '../../helpers/fake-clock.ts';

const tmp = mkdtempSync(join(tmpdir(), 'ghx-artifacts-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const repo = { host: 'github.com', owner: 'o', name: 'r' };
const NOW = Date.parse('2026-10-22T00:00:00Z');

function old(path: string): string {
  const dir = join(path, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, 'x');
  const t = (NOW - PRUNE_AFTER_MS - 60_000) / 1000;
  utimesSync(path, t, t);
  return path;
}

test('paths are <root>/<host>/<owner>/<repo>/<kind>/<name>, or <root>/_local/<kind>/<name>', async () => {
  const root = mkdtempSync(join(tmp, 'paths-'));
  const store = createArtifactStore({ root, clock: new FakeClock(NOW) });
  assert.equal(
    (await store.write({ kind: 'logs', name: 'a.log', content: 'x', repo })).path,
    join(root, 'github.com/o/r/logs/a.log'),
  );
  assert.equal(
    (await store.write({ kind: 'output', name: 'b.json', content: 'y' })).path,
    join(root, '_local/output/b.json'),
  );
});

test('pruning removes only old files in ghx-created kind directories; unrelated user files survive', async () => {
  const root = mkdtempSync(join(tmp, 'prune-'));
  // A first run creates ghx's own directories.
  const first = createArtifactStore({ root, clock: new FakeClock(NOW) });
  await first.write({ kind: 'logs', name: 'keep.log', content: 'x', repo });
  await first.write({ kind: 'output', name: 'keep.json', content: 'x' });
  const ownOld = old(join(root, 'github.com/o/r/logs/old.log'));
  const ownLocalOld = old(join(root, '_local/output/old.json'));
  // Old files ghx did not create, including ones that happen to sit at the artifact layout's depth.
  const userRoot = old(join(root, 'notes.txt'));
  const userDeep = old(join(root, 'a/b/c/d/old.txt'));
  const userLocal = old(join(root, '_local/mine/old.txt'));
  const userBeside = old(join(root, 'github.com/o/r/report.txt'));

  const second = createArtifactStore({ root, clock: new FakeClock(NOW) });
  await second.write({ kind: 'logs', name: 'new.log', content: 'x', repo });

  assert.equal(existsSync(ownOld), false, 'old ghx artifact pruned');
  assert.equal(existsSync(ownLocalOld), false, 'old _local ghx artifact pruned');
  for (const p of [userRoot, userDeep, userLocal, userBeside]) assert.equal(existsSync(p), true, `${p} survives`);
  assert.equal(existsSync(join(root, 'github.com/o/r/logs/keep.log')), true, 'fresh artifacts survive');
});
