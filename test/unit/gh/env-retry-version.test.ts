import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seededRandom } from '../../../src/core/random.ts';
import { buildGhEnv } from '../../../src/gh/env.ts';
import { backoffMs, DEFAULT_RETRY, withRetry } from '../../../src/gh/retry.ts';
import { compareVersions, parseGhVersion, versionAtLeast } from '../../../src/gh/version.ts';
import { FakeClock } from '../../helpers/fake-clock.ts';

test('gh env disables pager, prompts, color and notifiers; deletes forcing vars; keeps auth', () => {
  const env = buildGhEnv({
    PATH: '/bin',
    GH_TOKEN: 't',
    GH_HOST: 'github.com',
    GH_FORCE_TTY: '1',
    CLICOLOR_FORCE: '1',
    GH_DEBUG: 'api',
    GH_PAGER: 'less',
  });
  assert.equal(env.GH_PAGER, '');
  assert.equal(env.PAGER, 'cat');
  assert.equal(env.NO_COLOR, '1');
  assert.equal(env.CLICOLOR, '0');
  assert.equal(env.GH_PROMPT_DISABLED, '1');
  assert.equal(env.GH_NO_UPDATE_NOTIFIER, '1');
  assert.equal(env.GH_NO_EXTENSION_UPDATE_NOTIFIER, '1');
  assert.equal(env.GH_SPINNER_DISABLED, '1');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.ok(!('GH_FORCE_TTY' in env) && !('CLICOLOR_FORCE' in env) && !('GH_DEBUG' in env));
  assert.equal(env.GH_TOKEN, 't');
  assert.equal(env.GH_HOST, 'github.com');
  assert.equal(env.PATH, '/bin');
  assert.equal(buildGhEnv({ GH_DEBUG: 'api' }, { verbose: true }).GH_DEBUG, 'api');
});

test('backoff doubles to the cap and honors Retry-After', () => {
  const r = seededRandom(1);
  const p = { ...DEFAULT_RETRY, jitter: 0 };
  assert.equal(backoffMs(1, p, r), 500);
  assert.equal(backoffMs(2, p, r), 1_000);
  assert.equal(backoffMs(10, p, r), 8_000);
  assert.equal(backoffMs(1, p, r, 60_000), 60_000);
});

test('withRetry retries transient failures on the fake clock', async () => {
  const clock = new FakeClock(0);
  let n = 0;
  const p = withRetry(
    async () => {
      n++;
      if (n < 3) throw new Error('transient');
      return 'ok';
    },
    {
      policy: { ...DEFAULT_RETRY, jitter: 0 },
      clock,
      signal: new AbortController().signal,
      decide: () => ({ retry: true }),
    },
  );
  await clock.advance(10_000);
  assert.equal(await p, 'ok');
  assert.equal(n, 3);
});

test('withRetry gives up on non-transient, on attempts, and before the deadline', async () => {
  const clock = new FakeClock(0);
  const signal = new AbortController().signal;
  let n = 0;
  await assert.rejects(
    withRetry(
      async () => {
        n++;
        throw new Error('hard');
      },
      { policy: DEFAULT_RETRY, clock, signal, decide: () => ({ retry: false }) },
    ),
    /hard/,
  );
  assert.equal(n, 1);
  n = 0;
  await assert.rejects(
    withRetry(
      async () => {
        n++;
        throw new Error('soft');
      },
      { policy: 'none', clock, signal, decide: () => ({ retry: true }) },
    ),
  );
  assert.equal(n, 1);
  n = 0;
  await assert.rejects(
    withRetry(
      async () => {
        n++;
        throw new Error('late');
      },
      { policy: { ...DEFAULT_RETRY, jitter: 0 }, clock, signal, deadline: 400, decide: () => ({ retry: true }) },
    ),
    /late/,
  );
  assert.equal(n, 1);
});

test('parse and compare gh versions', () => {
  const v = parseGhVersion('gh version 2.86.0 (2026-01-21)\nhttps://github.com/cli/cli/releases/tag/v2.86.0\n');
  assert.deepEqual(v, { major: 2, minor: 86, patch: 0, raw: '2.86.0', date: '2026-01-21' });
  assert.equal(parseGhVersion('nope'), undefined);
  assert.ok(v && versionAtLeast(v, '2.40.0'));
  assert.ok(v && !versionAtLeast(v, '3.0.0'));
  assert.ok(compareVersions({ major: 2, minor: 9, patch: 0 }, { major: 2, minor: 10, patch: 0 }) < 0);
});
