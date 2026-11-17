import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigSchema } from '../../../src/config/schema.ts';
import { deriveImpact } from '../../../src/pr/impact/derive.ts';

test('derived ranking is stable, deduplicates paths and includes the overflow risk floor', () => {
  const components = ConfigSchema.parse({
    version: 1,
    components: Object.fromEntries(
      Array.from({ length: 7 }, (_, n) => [
        `part${n}`,
        { paths: [`p${n}/**`], ...(n === 6 ? { minRisk: 'high' } : {}) },
      ]),
    ),
  }).components;
  const files = [...Array.from({ length: 7 }, (_, n) => `p${n}/a.ts`), 'p1/b.ts', 'p1/b.ts'];
  assert.deepEqual(deriveImpact(files, components), {
    components: ['part1', 'part0', 'part2', 'part3', 'part4'],
    alsoTouched: ['part5', 'part6'],
    riskFloor: 'high',
  });
  assert.deepEqual(deriveImpact(['unknown/file'], components), { components: [], alsoTouched: [], riskFloor: null });
});
