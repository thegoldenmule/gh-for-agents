import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GhxError, isGhxError } from '../../../src/core/errors.ts';
import { enrichNotFound, resolveCwdRepo, resolveRepo } from '../../../src/gh/repo.ts';
import { fakeGit, gitCheckout } from '../../helpers/fake-git.ts';

const gh = (owner: string, name: string, host = 'github.com') => ({ host, owner, name });

test('precedence: --repo, then the ref, then GH_REPO, then the cwd', async () => {
  const git = gitCheckout('o/cwd');
  const env = { GH_REPO: 'o/env' };
  assert.equal((await resolveRepo({ flag: 'o/flag', env, git, need: 'inferred' }))?.source, 'flag');
  const byRef = await resolveRepo({ ref: gh('o', 'ref'), env, git, need: 'inferred' });
  assert.deepEqual([byRef?.source, byRef?.repo.name], ['url', 'ref']);
  const byEnv = await resolveRepo({ env, git, need: 'inferred' });
  assert.deepEqual([byEnv?.source, byEnv?.repo.name], ['env', 'env']);
  const byCwd = await resolveRepo({ env: {}, git, need: 'inferred' });
  assert.deepEqual(byCwd, { repo: gh('o', 'cwd'), source: 'cwd', cwdRepo: gh('o', 'cwd'), cwdToplevel: '/work/cwd' });
});

test('an explicit repo carries the cwd repo for rule 5 warnings', async () => {
  const r = await resolveRepo({
    flag: 'powerhouse-inc/powerhouse',
    env: {},
    git: gitCheckout('thegoldenmule/sektar'),
    need: 'inferred',
  });
  assert.deepEqual(r?.cwdRepo, gh('thegoldenmule', 'sektar'));
});

test('rule 1: --repo and the ref disagree', async () => {
  await assert.rejects(
    resolveRepo({ flag: 'o/a', ref: gh('o', 'b'), env: {}, git: fakeGit(), need: 'inferred' }),
    (e) => {
      assert.ok(isGhxError(e, 'USAGE_REPO_MISMATCH'));
      assert.deepEqual(e.details, { flag: 'o/a', selector: 'o/b' });
      return true;
    },
  );
  assert.ok(await resolveRepo({ flag: 'O/A', ref: gh('o', 'a'), env: {}, git: fakeGit(), need: 'inferred' }));
});

test('rule 2: explicit need refuses cwd inference with a hint naming the cwd repo', async () => {
  await assert.rejects(resolveRepo({ env: {}, git: gitCheckout('o/cwd'), need: 'explicit' }), (e) => {
    assert.ok(isGhxError(e, 'USAGE_REPO_REQUIRED'));
    assert.match(e.hint ?? '', /cwd resolves to o\/cwd/);
    return true;
  });
  assert.ok(await resolveRepo({ flag: 'o/x', env: {}, git: gitCheckout('o/cwd'), need: 'explicit' }));
});

test('rule 3: several remotes to different repos and none gh-resolved is ambiguous', async () => {
  const git = fakeGit({
    toplevel: '/w',
    remotes: [
      { name: 'origin', url: 'git@github.com:me/fork.git' },
      { name: 'upstream', url: 'https://github.com/org/repo.git' },
    ],
  });
  await assert.rejects(resolveRepo({ env: {}, git, need: 'inferred' }), (e) => {
    assert.ok(isGhxError(e, 'REPO_AMBIGUOUS'));
    assert.deepEqual(e.details?.remotes, [
      { remote: 'upstream', repo: 'org/repo' },
      { remote: 'origin', repo: 'me/fork' },
    ]);
    return true;
  });
  assert.equal(await resolveRepo({ env: {}, git, need: 'optional' }), undefined);
});

test('gh-resolved=base wins; same-repo remotes are not ambiguous; non-GitHub hosts ignored', async () => {
  const resolved = await resolveCwdRepo(
    fakeGit({
      toplevel: '/w',
      remotes: [
        { name: 'origin', url: 'git@github.com:me/fork.git' },
        { name: 'upstream', url: 'https://github.com/org/repo.git', ghResolved: 'base' },
      ],
    }),
    {},
  );
  assert.deepEqual(resolved.repo, gh('org', 'repo'));
  const same = await resolveCwdRepo(
    fakeGit({
      toplevel: '/w',
      remotes: [
        { name: 'origin', url: 'git@github.com:o/r.git' },
        { name: 'github', url: 'https://github.com/o/r' },
        { name: 'gitlab', url: 'git@gitlab.com:o/other.git' },
      ],
    }),
    {},
  );
  assert.deepEqual(same.repo, gh('o', 'r'));
  const ghe = await resolveCwdRepo(
    fakeGit({ toplevel: '/w', remotes: [{ name: 'origin', url: 'git@ghe.corp:o/r.git' }] }),
    {
      GH_HOST: 'ghe.corp',
    },
  );
  assert.deepEqual(ghe.repo, gh('o', 'r', 'ghe.corp'));
});

test('nothing resolves: REPO_NOT_FOUND, or undefined when optional; none never resolves', async () => {
  await assert.rejects(resolveRepo({ env: {}, git: fakeGit(), need: 'inferred' }), (e) =>
    isGhxError(e, 'REPO_NOT_FOUND'),
  );
  await assert.rejects(
    resolveRepo({ env: {}, git: fakeGit({ toplevel: '/w' }), need: 'inferred' }),
    /no GitHub remote/,
  );
  assert.equal(await resolveRepo({ env: {}, git: fakeGit(), need: 'optional' }), undefined);
  assert.equal(await resolveRepo({ flag: 'o/r', env: {}, git: fakeGit(), need: 'none' }), undefined);
});

test('rule 4: a cwd-inferred not-found is enriched (sektar #3258)', async () => {
  const resolved = await resolveRepo({ env: {}, git: gitCheckout('thegoldenmule/sektar'), need: 'inferred' });
  const e = enrichNotFound(new GhxError('PR_NOT_FOUND', 'GraphQL: Could not resolve'), resolved, 'PR #3258');
  assert.ok(isGhxError(e, 'PR_NOT_FOUND'));
  assert.deepEqual(e.details, { repo: 'thegoldenmule/sektar', repoSource: 'cwd', cwdToplevel: '/work/sektar' });
  assert.match(e.hint ?? '', /PR #3258 not found in thegoldenmule\/sektar \(inferred from cwd\)\. Pass --repo/);
  assert.equal(e.exitCode, 5);
  const explicit = await resolveRepo({
    flag: 'o/r',
    env: {},
    git: gitCheckout('thegoldenmule/sektar'),
    need: 'inferred',
  });
  const same = new GhxError('PR_NOT_FOUND', 'x');
  assert.equal(enrichNotFound(same, explicit, 'PR #1'), same);
});
