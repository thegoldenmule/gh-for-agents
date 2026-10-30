import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGit, parseHistory, parseRemoteConfig } from '../../../src/git/index.ts';
import { FakeProc } from '../../helpers/fake-proc.ts';

test('parseRemoteConfig collects url and gh-resolved per remote', () => {
  const out = [
    'remote.origin.url git@github.com:me/fork.git',
    'remote.upstream.url https://github.com/org/repo.git',
    'remote.upstream.gh-resolved base',
    'remote.broken.gh-resolved base',
  ].join('\n');
  assert.deepEqual(parseRemoteConfig(out), [
    { name: 'origin', url: 'git@github.com:me/fork.git' },
    { name: 'upstream', url: 'https://github.com/org/repo.git', ghResolved: 'base' },
  ]);
});

test('createGit runs git through the runner, memoizes, and handles missing git', async () => {
  const fake = new FakeProc()
    .on({ cmd: 'git', args: ['rev-parse', '--show-toplevel'] }, { stdout: '/work/r\n' })
    .on({ cmd: 'git', args: ['config'] }, { stdout: 'remote.origin.url git@github.com:o/r.git\n' })
    .on({ cmd: 'git', args: ['symbolic-ref'] }, { stdout: 'feat/x\n' })
    .on({ cmd: 'git', args: ['rev-parse', '--verify'] }, { exitCode: 1 })
    .on({ cmd: 'git', args: ['check-ignore'] }, { exitCode: 128 })
    .on({ cmd: 'git', args: ['check-ignore', '-q', '--', '/work/r/a'] }, { exitCode: 0 })
    .on({ cmd: 'git', args: ['check-ignore', '-q', '--', '/work/r/b'] }, { exitCode: 1 })
    .on({ cmd: 'git', args: ['--version'] }, { stdout: 'git version 2.50.0' });
  const git = createGit({
    proc: fake.runner(),
    cwd: '/work/r',
    env: { PATH: '/bin' },
    signal: new AbortController().signal,
  });
  assert.equal(await git.toplevel(), '/work/r');
  assert.equal(await git.toplevel(), '/work/r');
  assert.deepEqual(await git.remotes(), [{ name: 'origin', url: 'git@github.com:o/r.git' }]);
  assert.equal(await git.currentBranch(), 'feat/x');
  assert.equal(await git.revParse('nope'), undefined);
  assert.equal(await git.available(), true);
  assert.equal(await git.isIgnored('/work/r/a'), true);
  assert.equal(await git.isIgnored('/work/r/b'), false);
  assert.equal(await git.isIgnored('/elsewhere'), undefined);
  assert.equal(fake.calls.filter((c) => c.args[0] === 'rev-parse' && c.args[1] === '--show-toplevel').length, 1);
  assert.equal(fake.calls[0]?.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(fake.calls[0]?.cwd, '/work/r');

  const missing = new FakeProc().on({ cmd: 'git' }, { spawnError: 'ENOENT' });
  const g2 = createGit({ proc: missing.runner(), cwd: '/', env: {}, signal: new AbortController().signal });
  assert.equal(await g2.available(), false);
  assert.equal(await g2.toplevel(), undefined);
});

test('history: git log subjects and paths, one record per commit; undefined when git fails', async () => {
  const out = '\x1efeat(cli): a\n\nsrc/a.ts\nsrc/b.ts\n\x1efix: b\n\n\x1edocs(x): c\n\ndocs/c.md\n';
  assert.deepEqual(parseHistory(out), [
    { subject: 'feat(cli): a', files: ['src/a.ts', 'src/b.ts'] },
    { subject: 'fix: b', files: [] },
    { subject: 'docs(x): c', files: ['docs/c.md'] },
  ]);
  const ok = new FakeProc().on({ cmd: 'git', args: ['-c', 'core.quotePath=false', 'log'] }, { stdout: out });
  const git = createGit({ proc: ok.runner(), cwd: '/w', env: {}, signal: new AbortController().signal });
  assert.equal((await git.history?.(5))?.length, 3);
  assert.ok(ok.calls[0]?.args.includes('-n5'));
  const empty = new FakeProc().on({ cmd: 'git' }, { exitCode: 128, stderr: 'fatal: no commits' });
  const g2 = createGit({ proc: empty.runner(), cwd: '/w', env: {}, signal: new AbortController().signal });
  assert.equal(await g2.history?.(5), undefined);
});
