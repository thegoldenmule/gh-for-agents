import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { GhxError, isGhxError } from '../../../src/core/errors.ts';
import { seededRandom } from '../../../src/core/random.ts';
import { createGh, DryRunHalt, type GhDeps, GhFailure } from '../../../src/gh/index.ts';
import { FakeClock } from '../../helpers/fake-clock.ts';
import { FakeProc } from '../../helpers/fake-proc.ts';

const repo = { host: 'github.com', owner: 'o', name: 'r' };

function setup(mode: GhDeps['mode'], extra: Partial<GhDeps> = {}) {
  const clock = new FakeClock(0);
  const fake = new FakeProc({ clock });
  const gh = createGh({
    proc: fake.runner(),
    clock,
    signal: new AbortController().signal,
    mode,
    env: { PATH: '/bin', GH_FORCE_TTY: '1' },
    random: seededRandom(1),
    ...extra,
  });
  return { clock, fake, gh };
}

test('exec appends -R host/owner/name and sends the sanitized env', async () => {
  const { fake, gh } = setup('read');
  fake.on({ cmd: 'gh', args: ['pr', 'view'] }, { stdout: '{}' });
  await gh.exec({ args: ['pr', 'view', '1'], repo });
  const call = fake.calls[0];
  assert.deepEqual(call?.args, ['pr', 'view', '1', '-R', 'github.com/o/r']);
  assert.equal(call?.env.GH_PROMPT_DISABLED, '1');
  assert.equal(call?.env.GH_PAGER, '');
  assert.ok(!('GH_FORCE_TTY' in (call?.env ?? {})));
  assert.equal(call?.stdin, undefined);
});

test('read mode refuses a mutating call before spawning', async () => {
  const { fake, gh } = setup('read');
  await assert.rejects(gh.exec({ args: ['pr', 'merge', '1'], repo }), (e) => isGhxError(e, 'INTERNAL_READ_MUTATION'));
  assert.equal(fake.calls.length, 0);
});

test('dry-run write mode halts at the first mutating call with the exact argv and stdin', async () => {
  const { fake, gh } = setup('write', { dryRun: true });
  fake.on({ cmd: 'gh', args: ['pr', 'view'] }, { stdout: '{}' });
  await gh.exec({ args: ['pr', 'view', '1'], repo });
  await assert.rejects(
    gh.exec({ args: ['api', '-X', 'PUT', 'repos/o/r/pulls/1/merge', '--input', '-'], stdin: '{"sha":"x"}' }),
    (e) => e instanceof DryRunHalt && e.argv[0] === 'gh' && e.stdin === '{"sha":"x"}',
  );
  assert.equal(fake.calls.length, 1);
});

test('a mutates flag that disagrees with the guard is INTERNAL', async () => {
  const { gh } = setup('write');
  await assert.rejects(gh.exec({ args: ['pr', 'view', '1'], mutates: true }), (e) => isGhxError(e, 'INTERNAL'));
});

test('transient failures retry on the fake clock; reads only', async () => {
  const { clock, fake, gh } = setup('read');
  fake.on({ cmd: 'gh', args: ['api'] }, [
    { exitCode: 1, stderr: 'gh: Server Error (HTTP 502)' },
    { exitCode: 1, stderr: 'gh: Server Error (HTTP 502)' },
    { stdout: '{"ok":true}' },
  ]);
  const p = gh.exec({ args: ['api', 'repos/o/r'] });
  await clock.advance(20_000);
  const r = await p;
  assert.equal(r.attempts, 3);
  assert.equal(fake.calls.length, 3);
});

test('mutating calls are not retried by default', async () => {
  const { fake, gh } = setup('write');
  fake.on({ cmd: 'gh', args: ['api'] }, { exitCode: 1, stderr: 'gh: Server Error (HTTP 502)' });
  await assert.rejects(gh.exec({ args: ['api', '-X', 'POST', 'repos/o/r/pulls'] }), (e) => isGhxError(e, 'GH_FAILED'));
  assert.equal(fake.calls.length, 1);
});

test('failures carry the public code, argv and stderr tail; internal code stays on .failure', async () => {
  const { fake, gh } = setup('read');
  fake.on(
    { cmd: 'gh' },
    { exitCode: 1, stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 3258.' },
  );
  try {
    await gh.exec({ args: ['pr', 'view', '3258'], repo, notFound: 'PR_NOT_FOUND' });
    assert.fail('expected a failure');
  } catch (e) {
    assert.ok(e instanceof GhFailure);
    assert.equal(e.code, 'PR_NOT_FOUND');
    assert.equal(e.failure.code, 'GH_NOT_FOUND');
    assert.equal(e.exitCode, 5);
    assert.deepEqual(e.details?.argv, ['gh', 'pr', 'view', '3258', '-R', 'github.com/o/r']);
    assert.ok(!JSON.stringify(e.details).includes('GH_NOT_FOUND'));
  }
});

test('gh missing → ENV_GH_MISSING (exit 4)', async () => {
  const { fake, gh } = setup('read');
  fake.on({ cmd: 'gh' }, { spawnError: 'ENOENT' });
  await assert.rejects(gh.version(), (e) => isGhxError(e, 'ENV_GH_MISSING') && (e as GhxError).exitCode === 4);
});

test('allowExit treats listed exits as data', async () => {
  const { fake, gh } = setup('read');
  fake.on({ cmd: 'gh' }, { exitCode: 8, stdout: '[]' });
  const r = await gh.exec({ args: ['pr', 'checks', '1'], allowExit: [8] });
  assert.equal(r.exitCode, 8);
});

test('json validates gh output; drift is GH_OUTPUT_UNEXPECTED', async () => {
  const { fake, gh } = setup('read');
  fake.on({ cmd: 'gh' }, [{ stdout: '{"number":1}' }, { stdout: '{"number":"x"}' }, { stdout: 'not json' }]);
  const S = z.object({ number: z.number() });
  assert.deepEqual(await gh.json({ args: ['pr', 'view', '1'] }, S), { number: 1 });
  await assert.rejects(gh.json({ args: ['pr', 'view', '1'] }, S), (e) => isGhxError(e, 'GH_OUTPUT_UNEXPECTED'));
  await assert.rejects(gh.json({ args: ['pr', 'view', '1'] }, S), (e) => isGhxError(e, 'GH_OUTPUT_UNEXPECTED'));
});

test('cache memoizes identical reads', async () => {
  const { fake, gh } = setup('read');
  fake.on({ cmd: 'gh' }, { stdout: 'x' });
  await gh.exec({ args: ['repo', 'view'], cache: true });
  await gh.exec({ args: ['repo', 'view'], cache: true });
  assert.equal(fake.calls.length, 1);
});

test('version parses and memoizes', async () => {
  const { fake, gh } = setup('read');
  fake.on({ cmd: 'gh', args: ['--version'] }, { stdout: 'gh version 2.86.0 (2026-01-21)\n' });
  assert.equal((await gh.version()).raw, '2.86.0');
  await gh.version();
  assert.equal(fake.calls.length, 1);
});

test('an aborted command signal surfaces as its reason', async () => {
  const clock = new FakeClock(0);
  const fake = new FakeProc({ clock });
  const c = new AbortController();
  const gh = createGh({ proc: fake.runner(), clock, signal: c.signal, mode: 'read' });
  fake.on({ cmd: 'gh' }, { hang: true });
  const p = gh.exec({ args: ['pr', 'view', '1'] });
  c.abort(new GhxError('INTERRUPTED', 'x', { details: { signal: 'SIGTERM' } }));
  await assert.rejects(p, (e) => isGhxError(e, 'INTERRUPTED'));
});

test('withSignal: a scoped view kills its own children on abort; the parent client is unaffected', async () => {
  const clock = new FakeClock(0);
  const fake = new FakeProc({ clock });
  const gh = createGh({ proc: fake.runner(), clock, signal: new AbortController().signal, mode: 'read' });
  fake.on({ cmd: 'gh', args: ['run', 'view'] }, { hang: true });
  fake.on({ cmd: 'gh', args: ['pr', 'view'] }, { stdout: '{}' });
  const scope = new AbortController();
  const view = gh.withSignal?.(scope.signal);
  assert.ok(view);
  const p = view.exec({ args: ['run', 'view', '1'] });
  scope.abort(new DOMException('budget', 'AbortError'));
  await assert.rejects(p, (e) => e instanceof Error && e.name === 'AbortError');
  assert.equal((await gh.exec({ args: ['pr', 'view', '1'] })).stdout, '{}');
  await assert.rejects(view.exec({ args: ['pr', 'view', '1'] }), (e) => e instanceof Error && e.name === 'AbortError');
});

test('GH_HOST in the env never redirects a github.com target: --hostname is always explicit', async () => {
  const { fake, gh } = setup('read', { env: { PATH: '/bin', GH_HOST: 'ghe.corp.example' } });
  const restOk = 'HTTP/2.0 200 OK\nContent-Type: application/json\n\n{"number":1}';
  const gqlOk = 'HTTP/2.0 200 OK\nContent-Type: application/json\n\n{"data":{"viewer":{"login":"x"}}}';
  fake.on({ cmd: 'gh', args: ['api'] }, { stdout: restOk });
  fake.on({ cmd: 'gh', args: ['api', 'graphql'] }, { stdout: gqlOk });
  await gh.api({ path: 'repos/{owner}/{repo}/pulls/1', repo }, z.object({ number: z.number() }));
  await gh.graphql('{ viewer { login } }', {}, z.object({ viewer: z.object({ login: z.string() }) }), { repo });
  assert.equal(fake.calls.length, 2);
  for (const call of fake.calls) {
    const i = call.args.indexOf('--hostname');
    assert.ok(i > 0, `--hostname missing from gh ${call.args.join(' ')}`);
    assert.equal(call.args[i + 1], 'github.com');
    assert.equal(call.env.GH_HOST, 'ghe.corp.example');
  }
});

test('a mutating call with a retry policy must declare idempotent: true, or it is INTERNAL', async () => {
  const { fake, gh } = setup('write');
  fake.on({ cmd: 'gh' }, { stdout: '{}' });
  const policy = { attempts: 3, baseMs: 10, maxMs: 100, jitter: 0 };
  await assert.rejects(
    gh.exec({ args: ['pr', 'merge', '1'], repo, retry: policy }),
    (e) => isGhxError(e, 'INTERNAL') && /idempotent/.test(e.message),
  );
  assert.equal(fake.calls.length, 0, 'refused before spawning');
  await gh.exec({ args: ['pr', 'merge', '1'], repo, retry: { ...policy, idempotent: true } });
  await gh.exec({ args: ['pr', 'merge', '1'], repo, retry: 'none' });
  await gh.exec({ args: ['pr', 'view', '1'], repo, retry: policy });
  assert.equal(fake.calls.length, 3);
});

test('a per-attempt timeout (GH_TIMEOUT) is retried once, not up to the policy limit (01 §4.3)', async () => {
  let calls = 0;
  const { clock, gh } = setup('read', {
    proc: async () => {
      calls++;
      return {
        exitCode: null,
        signal: 'SIGTERM',
        stdout: '',
        stderr: '',
        timedOut: true,
        aborted: false,
        durationMs: 0,
      };
    },
  });
  const p = gh.exec({ args: ['api', 'repos/o/r'] });
  const settled = p.then(
    () => undefined,
    (e: unknown) => e,
  );
  await clock.advance(60_000);
  const e = await settled;
  assert.ok(e instanceof GhFailure && e.failure.code === 'GH_TIMEOUT', String(e));
  assert.equal(calls, 2);
});
