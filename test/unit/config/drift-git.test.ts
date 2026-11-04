// CONFIG_DRIFT against real git repositories (config/load.ts inspectLocal): the stale checkout of
// tally#27 warns; a PR branch that edits the file while main left it alone, and a shallow clone whose
// counts are unreliable, do not (review of PR #1, findings 4a and 4b).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { inspectLocal } from '../../../src/config/load.ts';
import { realClock } from '../../../src/core/clock.ts';
import type { ResolvedRepo } from '../../../src/gh/repo.ts';
import { createGit } from '../../../src/git/index.ts';
import { createSpawnRunner } from '../../../src/proc/runner.ts';

const tmp = mkdtempSync(join(tmpdir(), 'ghx-drift-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const ENV = {
  PATH: process.env.PATH,
  HOME: tmp,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const TARGET: ResolvedRepo = {
  repo: { host: 'github.com', owner: 'o', name: 'r' },
  source: 'cwd',
  cwdRepo: { host: 'github.com', owner: 'o', name: 'r' },
};

function commitConfig(dir: string, text: string, msg: string) {
  writeFileSync(join(dir, '.github', 'ghx.json'), text);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', msg);
}

/** An "origin" with two commits, and a clone of it whose remote URL says github.com/o/r. */
function world(name: string, cloneArgs: string[] = []) {
  const origin = join(tmp, `${name}-origin`);
  git(tmp, 'init', '-q', '-b', 'main', origin);
  execFileSync('mkdir', ['-p', join(origin, '.github')]);
  commitConfig(origin, '{"v":1}', 'one');
  commitConfig(origin, '{"v":1,"x":1}', 'two');
  const clone = join(tmp, `${name}-clone`);
  git(tmp, 'clone', '-q', ...cloneArgs, `file://${origin}`, clone);
  git(clone, 'remote', 'set-url', 'origin', 'git@github.com:o/r.git');
  return { origin, clone };
}

const inspect = (dir: string) =>
  inspectLocal(
    createGit({
      proc: createSpawnRunner({ clock: realClock }),
      cwd: dir,
      env: ENV,
      signal: new AbortController().signal,
    }),
    join(dir, '.github', 'ghx.json'),
    TARGET,
  );

test('real git: a checkout behind a base that changed the config warns CONFIG_DRIFT', async () => {
  const { clone } = world('stale');
  git(clone, 'reset', '-q', '--hard', 'HEAD~1');
  const r = await inspect(clone);
  assert.equal(r.dirty, false);
  assert.deepEqual(
    r.warnings.map((w) => [w.code, w.details?.base, w.details?.behind]),
    [['CONFIG_DRIFT', 'origin/main', 1]],
  );
});

test('real git: a branch editing the config while behind an unchanged base does not warn', async () => {
  const { origin, clone } = world('branch');
  // main moves on without touching the config; the branch (forked before) edits it.
  writeFileSync(join(origin, 'README'), 'x');
  git(origin, 'add', '.');
  git(origin, 'commit', '-q', '-m', 'readme');
  git(clone, 'checkout', '-q', '-b', 'feat');
  commitConfig(clone, '{"v":1,"x":2}', 'edit config');
  git(clone, 'fetch', '-q', `file://${origin}`, 'main:refs/remotes/origin/main');
  const r = await inspect(clone);
  assert.deepEqual(r.warnings, []);
});

test('real git: a shallow clone never warns (its merge-base and counts are unreliable)', async () => {
  const { origin, clone } = world('shallow', ['--depth', '1']);
  commitConfig(origin, '{"v":1,"x":3}', 'three');
  git(clone, 'fetch', '-q', '--depth', '1', `file://${origin}`, '+main:refs/remotes/origin/main');
  const r = await inspect(clone);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.dirty, false);
});
