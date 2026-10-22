import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { seededRandom } from '../../../src/core/random.ts';
import { createGh } from '../../../src/gh/index.ts';
import { parseRateLimitResponse, RateTracker, suggestInterval } from '../../../src/gh/ratelimit.ts';
import { FakeClock } from '../../helpers/fake-clock.ts';
import { FakeProc } from '../../helpers/fake-proc.ts';

const NOW = Date.UTC(2026, 9, 22, 12);

test('suggestInterval: floor at base, stretch to last until reset with 20% headroom, wait on exhaustion', () => {
  const clock = new FakeClock(NOW);
  const b = (remaining: number, resetInMs: number) => ({
    resource: 'core',
    limit: 5000,
    remaining,
    used: 5000 - remaining,
    resetAt: NOW + resetInMs,
    observedAt: NOW,
  });
  assert.equal(suggestInterval(10_000, undefined, clock), 10_000);
  assert.equal(suggestInterval(10_000, b(4000, 3_600_000), clock), 10_000);
  assert.equal(suggestInterval(10_000, b(100, 3_600_000), clock), 45_000);
  assert.equal(suggestInterval(10_000, b(0, 600_000), clock), 600_000);
  assert.equal(suggestInterval(10_000, b(4000, 3_600_000), clock, 60_000), 60_000);
});

test('RateTracker ignores responses without rate headers (job-log blobs)', () => {
  const t = new RateTracker();
  assert.equal(t.observe({ server: 'Windows-Azure-Blob/1.0' }, NOW), undefined);
  assert.equal(t.get(), undefined);
});

test('parseRateLimitResponse and refreshRateBudget', async () => {
  const body = {
    resources: {
      core: { limit: 5000, remaining: 4000, used: 1000, reset: 1792670400 },
      graphql: { limit: 5000, remaining: 10, reset: 1792670400 },
    },
  };
  const parsed = parseRateLimitResponse(body, NOW);
  assert.equal(parsed.core?.remaining, 4000);
  assert.equal(parsed.graphql?.used, 4990);
  const clock = new FakeClock(NOW);
  const fake = new FakeProc({ clock });
  fake.on({ cmd: 'gh' }, { stdout: `HTTP/2.0 200 OK\n\n${JSON.stringify(body)}` });
  const gh = createGh({
    proc: fake.runner(),
    clock,
    signal: new AbortController().signal,
    mode: 'read',
    random: seededRandom(1),
  });
  await gh.refreshRateBudget();
  assert.equal(gh.rateBudget('graphql')?.remaining, 10);
  assert.deepEqual(fake.calls[0]?.args, ['api', '--include', '-X', 'GET', 'rate_limit']);
  void z;
});
