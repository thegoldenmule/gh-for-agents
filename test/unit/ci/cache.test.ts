// The JSON disk cache (03 M2.5; 03 puts its test at test/unit/core/cache.test.ts, the module lives in src/ci/).
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { createJsonCache, repoCache } from '../../../src/ci/cache.ts';
import { FakeClock } from '../../helpers/fake-clock.ts';
import { ciEnv, repoOf, tempRoot } from './_helpers.ts';

const Value = z.object({ n: z.number() });

test('TTL on the FakeClock: a hit before expiry, a miss at and after it', async () => {
  const clock = new FakeClock();
  const c = createJsonCache({ dir: join(tempRoot(), 'ttl'), clock });
  c.set('k', { n: 1 }, 60_000);
  assert.deepEqual(c.get('k', Value), { n: 1 });
  await clock.advance(59_999);
  assert.deepEqual(c.get('k', Value), { n: 1 });
  await clock.advance(1);
  assert.equal(c.get('k', Value), undefined);
});

test('ttl null never expires', async () => {
  const clock = new FakeClock();
  const c = createJsonCache({ dir: join(tempRoot(), 'forever'), clock });
  c.set('tests:job-1', { n: 2 }, null);
  await clock.advance(365 * 24 * 3_600_000);
  assert.deepEqual(c.get('tests:job-1', Value), { n: 2 });
});

test('a corrupt file, a wrong shape and a missing key are all misses', () => {
  const clock = new FakeClock();
  const dir = join(tempRoot(), 'corrupt');
  const c = createJsonCache({ dir, clock });
  c.set('k', { n: 1 }, null);
  const [file] = readdirSync(dir);
  assert.ok(file);
  writeFileSync(join(dir, file), '{not json');
  assert.equal(c.get('k', Value), undefined);
  c.set('k', { n: 'x' }, null);
  assert.equal(c.get('k', Value), undefined);
  assert.equal(c.get('missing', Value), undefined);
});

test('keys with odd characters map to distinct files', () => {
  const c = createJsonCache({ dir: join(tempRoot(), 'keys'), clock: new FakeClock() });
  c.set('a/b', { n: 1 }, null);
  c.set('a_b', { n: 2 }, null);
  assert.deepEqual(c.get('a/b', Value), { n: 1 });
  assert.deepEqual(c.get('a_b', Value), { n: 2 });
});

test('repoCache lives under <root>/<host>/<owner>/<repo>/cache/<ns>/', async () => {
  const env = ciEnv();
  const c = await repoCache({ artifacts: env.artifacts, repo: repoOf('o/r'), clock: env.clock, ns: 'compare-main' });
  c.set('x', { n: 3 }, null);
  assert.equal(readdirSync(join(env.artifacts.root, 'github.com', 'o', 'r', 'cache', 'compare-main')).length, 1);
});
