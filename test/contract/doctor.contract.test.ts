// ghx doctor end to end (01 §9 commit 14): the real bin, router, args, context, mode-guarded gh, proc
// spawn, real git, config, output contract and exit code, against the fake gh on PATH.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { nodeBinDir, spawnGhx } from '../helpers/spawn.ts';
import { EXIT } from './exit-table.ts';

const tmp = mkdtempSync(join(tmpdir(), 'ghx-doctor-e2e-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function gitRepo(name: string, config?: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, env: { PATH: '/usr/bin:/bin', HOME: tmp }, stdio: 'ignore' });
  git('init', '-q');
  git('remote', 'add', 'origin', 'git@github.com:octo/widgets.git');
  if (config) {
    mkdirSync(join(dir, '.github'), { recursive: true });
    writeFileSync(join(dir, '.github', 'ghx.json'), config);
  }
  return dir;
}

function fake(scenario: string) {
  const dir = mkdtempSync(join(tmp, 'fake-'));
  const log = join(dir, 'calls.ndjson');
  return { log, env: { GHX_FAKE_SCENARIO: scenario, GHX_FAKE_LOG: log, GHX_FAKE_STATE: dir } };
}

test('doctor ok: JSON shape, exit 0, and the fake gh saw the sanitized env', async () => {
  const cwd = gitRepo('ok', '{"version":1,"components":{"core":{}}}');
  const f = fake('doctor-ok');
  const r = await spawnGhx(['doctor'], { fakeGh: true, cwd, env: { ...f.env, GH_FORCE_TTY: '1', GH_PAGER: 'less' } });
  assert.equal(r.exitCode, EXIT.OK, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), ['ok', 'gh', 'auth', 'git', 'config', 'checks']);
  assert.equal(out.git.repo, 'octo/widgets');
  assert.equal(out.config.status, 'valid');
  const calls = readFileSync(f.log, 'utf8')
    .trimEnd()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    calls.map((c) => c.argv.join(' ')),
    ['--version', 'auth status --json hosts', 'pr checks --help'],
  );
  for (const c of calls) {
    assert.equal(c.fake, true);
    assert.equal(c.env.GH_PROMPT_DISABLED, '1');
    assert.equal(c.env.GH_PAGER, '');
    assert.equal(c.env.NO_COLOR, '1');
    assert.equal(c.env.GH_NO_UPDATE_NOTIFIER, '1');
    assert.ok(!('GH_FORCE_TTY' in c.env));
    assert.equal(c.stdinSha256, null);
  }
});

test('doctor unauthenticated: exit 4', async () => {
  const f = fake('doctor-unauthenticated');
  const r = await spawnGhx(['doctor'], {
    fakeGh: true,
    cwd: gitRepo('unauth', '{"version":1,"components":{"core":{}}}'),
    env: f.env,
  });
  assert.equal(r.exitCode, EXIT.ENV);
  assert.equal(JSON.parse(r.stdout).auth.ok, false);
});

test('doctor invalid config: exit 3', async () => {
  const f = fake('doctor-ok');
  const r = await spawnGhx(['doctor'], {
    fakeGh: true,
    cwd: gitRepo('invalid', '{"version":1,"components":{"core":{}},"merge":{"method":"squash"}}'),
    env: f.env,
  });
  assert.equal(r.exitCode, EXIT.CONFIG);
  assert.equal(JSON.parse(r.stdout).config.status, 'invalid');
});

test('no gh on PATH: doctor reports it with exit 4', async () => {
  const r = await spawnGhx(['doctor'], { cwd: tmp, env: { PATH: nodeBinDir(), GHX_GH_PATH: join(tmp, 'no-such-gh') } });
  assert.equal(r.exitCode, EXIT.ENV);
  const out = JSON.parse(r.stdout);
  assert.equal(out.gh.ok, false);
  assert.equal(out.gh.path, null);
});
