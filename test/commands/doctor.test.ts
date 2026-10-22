import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { MIN_GH_VERSION } from '../../src/gh/version.ts';
import { EXIT } from '../contract/exit-table.ts';
import { fakeGit, gitCheckout } from '../helpers/fake-git.ts';
import { FakeProc } from '../helpers/fake-proc.ts';
import { replayGh } from '../helpers/fixture-match.ts';
import { runInProcess } from '../helpers/harness.ts';

const tmp = mkdtempSync(join(tmpdir(), 'ghx-doctor-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function checkout(name: string, config?: string) {
  const dir = join(tmp, name);
  mkdirSync(join(dir, '.github'), { recursive: true });
  if (config !== undefined) writeFileSync(join(dir, '.github', 'ghx.json'), config);
  return gitCheckout(`o/${name}`, { toplevel: dir });
}

const VALID = '{"version":1,"components":{"core":{}}}';
const doctor = (scenario: string, git = checkout(`c-${scenario}`, VALID), env: Record<string, string> = {}) =>
  runInProcess(['doctor'], { proc: replayGh(scenario), git, env });
const check = (r: Awaited<ReturnType<typeof doctor>>, name: string) =>
  r.json.checks.find((c: { name: string }) => c.name === name);

test('all ok: exit 0 with gh, auth, git and config reported', async () => {
  const r = await doctor('doctor-ok');
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.gh.version, '2.86.0');
  assert.equal(r.json.gh.minVersion, MIN_GH_VERSION);
  assert.equal(r.json.gh.ok, true);
  assert.deepEqual(r.json.auth, {
    host: 'github.com',
    login: 'viewer-user',
    ok: true,
    scopes: ['gist', 'read:org', 'repo', 'workflow'],
  });
  assert.equal(r.json.git.repo, 'o/c-doctor-ok');
  assert.equal(r.json.git.repoSource, 'cwd');
  assert.equal(r.json.config.status, 'valid');
  assert.equal(r.json.config.source.kind, 'local');
  assert.deepEqual(
    r.calls.map((c) => c.args.join(' ')),
    ['--version', 'auth status --json hosts', 'pr checks --help'],
  );
  assert.ok(r.calls.every((c) => c.env.GH_PROMPT_DISABLED === '1' && c.env.GH_PAGER === ''));
});

test('gh missing: exit 4, gh.ok and auth.ok false, no further gh calls', async () => {
  const proc = new FakeProc().on({ cmd: 'gh' }, { spawnError: 'ENOENT' }).runner();
  const r = await runInProcess(['doctor'], { proc, git: checkout('missing', VALID) });
  assert.equal(r.exitCode, EXIT.ENV);
  assert.equal(r.json.gh.ok, false);
  assert.equal(r.json.gh.path, null);
  assert.equal(r.json.auth.ok, false);
  assert.match(check(r, 'gh-version').message, /not found/);
  assert.equal(r.calls.length, 1);
});

test('gh too old with failed probes: exit 4 with upgrade hints', async () => {
  const r = await doctor('doctor-old');
  assert.equal(r.exitCode, EXIT.ENV);
  assert.equal(r.json.gh.version, '2.40.1');
  assert.equal(r.json.gh.ok, false);
  assert.equal(check(r, 'gh-version').ok, false);
  assert.equal(check(r, 'feature: auth status --json').ok, false);
  assert.equal(check(r, 'feature: pr checks --json').ok, false);
  assert.match(check(r, 'gh-version').hint, /Upgrade/);
});

test('unauthenticated, bad token, and a token without the repo scope: exit 4', async () => {
  const none = await doctor('doctor-unauthenticated');
  assert.equal(none.exitCode, EXIT.ENV);
  assert.equal(none.json.auth.ok, false);
  assert.match(check(none, 'auth').hint, /gh auth login/);
  const bad = await doctor('doctor-bad-token');
  assert.equal(bad.exitCode, EXIT.ENV);
  assert.match(check(bad, 'auth').message, /state 'error'.*Bad credentials/);
  const scope = await doctor('doctor-no-repo-scope');
  assert.equal(scope.exitCode, EXIT.ENV);
  assert.match(check(scope, 'auth').hint, /gh auth refresh -s repo/);
});

test('invalid config: exit 3 with issues; missing config: exit 3 with an init hint', async () => {
  const invalid = await doctor('doctor-ok', checkout('invalid', '{"version":1,"componets":{}}'));
  assert.equal(invalid.exitCode, EXIT.CONFIG);
  assert.equal(invalid.json.config.status, 'invalid');
  assert.ok(invalid.json.config.issues.some((i: { suggestion?: string }) => i.suggestion === 'components'));
  const missing = await doctor('doctor-ok', checkout('nocfg'));
  assert.equal(missing.exitCode, EXIT.CONFIG);
  assert.equal(missing.json.config.status, 'missing');
  assert.match(check(missing, 'config').hint, /ghx init/);
});

test('outside a checkout: config skipped, still ok', async () => {
  const r = await doctor('doctor-ok', fakeGit({}));
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.config.status, 'skipped');
  assert.equal(r.json.git.toplevel, null);
});

test('two GitHub remotes and no gh default: the repo check fails with a --repo hint, exit 2 (not 1)', async () => {
  const dir = join(tmp, 'ambiguous');
  mkdirSync(join(dir, '.github'), { recursive: true });
  writeFileSync(join(dir, '.github', 'ghx.json'), VALID);
  const git = fakeGit({
    toplevel: dir,
    remotes: [
      { name: 'origin', url: 'git@github.com:me/fork.git' },
      { name: 'upstream', url: 'git@github.com:org/repo.git' },
    ],
  });
  const r = await doctor('doctor-ok', git);
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  assert.equal(check(r, 'repo').ok, false);
  assert.match(check(r, 'repo').hint, /--repo/);
});

test('GHX_TEST_* in the environment is warned about', async () => {
  const r = await doctor('doctor-ok', undefined, { GHX_TEST_HOOKS: '1' });
  assert.deepEqual(
    r.json.warnings.map((w: { code: string }) => w.code),
    ['TEST_HOOKS_SET'],
  );
});
