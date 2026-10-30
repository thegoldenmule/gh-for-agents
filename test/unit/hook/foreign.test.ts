// The hook's enforcement scope by named repo (src/hook/foreign.ts): a gh call that names another repo
// (-R, a URL, a literal gh api repos/o/r path) from inside a ghx checkout is judged by that repo.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { isForeign, localRepoSlugs, namedRepo, remoteUrls, repoSlugOf } from '../../../src/hook/foreign.ts';
import { runHook } from '../../../src/hook/rules.ts';
import { scanShell } from '../../../src/hook/shell.ts';
import { FakeClock } from '../../helpers/fake-clock.ts';

const tmp = mkdtempSync(join(tmpdir(), 'ghx-foreign-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const inv = (command: string) => {
  const i = scanShell(command).invocations[0];
  assert.ok(i, command);
  return i;
};

test('repoSlugOf reads -R values, https/ssh/scp remotes and URLs into a repo', () => {
  const cases: [string, string | undefined][] = [
    ['o/r', 'o/r'],
    ['Owner/Repo', 'owner/repo'],
    ['github.com/o/r', 'o/r'],
    ['ghe.example.com/o/r', 'o/r'],
    ['https://github.com/o/r.git', 'o/r'],
    ['https://github.com/o/r', 'o/r'],
    ['https://github.com/nodejs/node/pull/123', 'nodejs/node'],
    ['https://github.com/nodejs/node/pull/123#issuecomment-1', 'nodejs/node'],
    ['git@github.com:o/r.git', 'o/r'],
    ['ssh://git@github.com/o/r.git', 'o/r'],
    ['r', undefined],
    ['', undefined],
    ['o/r b', undefined],
  ];
  for (const [v, want] of cases) assert.equal(repoSlugOf(v), want, v);
});

test('remoteUrls reads only [remote "x"] url lines', () => {
  const cfg = [
    '[core]',
    '\turl = not-a-remote',
    '[remote "origin"]',
    '\turl = https://github.com/o/r.git',
    '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    '[remote "upstream"]',
    '  url=git@github.com:up/r.git',
    '[branch "main"]',
    '\tremote = origin',
  ].join('\n');
  assert.deepEqual(remoteUrls(cfg), ['https://github.com/o/r.git', 'git@github.com:up/r.git']);
});

test('namedRepo: -R/--repo anywhere, a URL positional, a literal gh api repos path; else none', () => {
  const cases: [string, string | undefined][] = [
    ['gh pr view 1 -R nodejs/node', 'nodejs/node'],
    ['gh -R nodejs/node pr view 1', 'nodejs/node'],
    ['gh pr view 1 --repo=nodejs/node', 'nodejs/node'],
    ['gh pr view https://github.com/nodejs/node/pull/5', 'nodejs/node'],
    ['gh api repos/nodejs/node/pulls/5', 'nodejs/node'],
    ['gh api /repos/nodejs/node/pulls/5', 'nodejs/node'],
    ['gh api -X PUT repos/o/r/pulls/12/merge', 'o/r'],
    ['gh api repos/{owner}/{repo}/pulls/5', undefined],
    ['gh api repos/:owner/:repo/pulls', undefined],
    ['gh api user', undefined],
    ['gh pr view 12', undefined],
  ];
  for (const [c, want] of cases) assert.equal(namedRepo(inv(c)), want, c);
});

test('isForeign: only a named repo that is not this one', () => {
  const same = (s: string) => s === 'o/r';
  assert.equal(isForeign(inv('gh pr merge 1 -R nodejs/node'), same), true);
  assert.equal(isForeign(inv('gh pr merge 1 -R o/r'), same), false);
  assert.equal(isForeign(inv('gh pr merge 1 -R O/R'), same), false);
  assert.equal(isForeign(inv('gh pr merge 1'), same), false);
});

/** A checkout: `.git` dir with a remote, or a worktree `.git` file → gitdir → commondir → config. */
function checkout(name: string, o: { remote?: string; worktree?: boolean; relative?: boolean }): string {
  const root = join(tmp, name);
  mkdirSync(join(root, '.github'), { recursive: true });
  writeFileSync(join(root, '.github', 'ghx.json'), '{}\n');
  const cfg = o.remote ? `[remote "origin"]\n\turl = ${o.remote}\n` : '[core]\n';
  if (o.worktree) {
    const main = join(tmp, `${name}-main`, '.git');
    const gitdir = join(main, 'worktrees', name);
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(main, 'config'), cfg);
    writeFileSync(join(gitdir, 'commondir'), '../..\n');
    writeFileSync(join(root, '.git'), `gitdir: ${o.relative ? `../${name}-main/.git/worktrees/${name}` : gitdir}\n`);
  } else {
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'config'), cfg);
  }
  return root;
}

test('localRepoSlugs: a checkout, a worktree (absolute or relative gitdir), or nothing', () => {
  assert.deepEqual([...localRepoSlugs(checkout('plain', { remote: 'https://github.com/o/r.git' }))], ['o/r']);
  assert.deepEqual([...localRepoSlugs(checkout('wt', { remote: 'git@github.com:o/w.git', worktree: true }))], ['o/w']);
  assert.deepEqual(
    [...localRepoSlugs(checkout('wtrel', { remote: 'git@github.com:o/x.git', worktree: true, relative: true }))],
    ['o/x'],
  );
  assert.deepEqual([...localRepoSlugs(checkout('noremote', {}))], []);
  assert.deepEqual([...localRepoSlugs(join(tmp, 'missing'))], []);
  assert.deepEqual([...localRepoSlugs(undefined)], []);
  assert.deepEqual([...localRepoSlugs('')], []);
  const broken = join(tmp, 'broken');
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, '.git'), 'not a gitdir line\n');
  assert.deepEqual([...localRepoSlugs(broken)], []);
});

const hook = (cwd: string, command: string) => {
  const out = runHook(
    JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } }),
    {},
    new FakeClock(),
  );
  return out === null ? null : JSON.parse(out).hookSpecificOutput;
};

test('from a configured checkout of o/r: gh aimed at another repo passes; at o/r it is enforced', () => {
  const root = checkout('enforced', { remote: 'https://github.com/o/r.git' });
  for (const c of [
    'gh pr view 1 -R nodejs/node',
    'gh -R nodejs/node pr merge 1',
    'gh pr view https://github.com/nodejs/node/pull/1',
    'gh api repos/nodejs/node/pulls/1',
    'gh pr create --repo other/repo --title x',
    'while true; do gh pr checks 1 -R nodejs/node; sleep 30; done',
  ]) {
    assert.equal(hook(root, c), null, c);
  }
  for (const c of [
    'gh pr view 1 -R o/r',
    'gh -R o/r pr merge 1',
    'gh pr view 1',
    'gh api -X PUT repos/o/r/pulls/1/merge',
  ]) {
    assert.equal(hook(root, c)?.permissionDecision, 'deny', c);
  }
  // Mixed: the local write is still denied when chained with a foreign read.
  assert.equal(hook(root, 'gh pr view 1 -R nodejs/node && gh pr merge 2')?.permissionDecision, 'deny');
});

test('a checkout with no readable remote treats every named repo as foreign (fail open)', () => {
  const root = checkout('anon', {});
  assert.equal(hook(root, 'gh pr merge 1 -R o/r'), null);
  assert.equal(hook(root, 'gh pr merge 1')?.permissionDecision, 'deny', 'an unnamed repo is still the cwd');
});
