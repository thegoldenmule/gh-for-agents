import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { deriveInterface, kebab, mergeSources, positionalValues } from '../../../src/cli/args.ts';
import { isGhxError } from '../../../src/core/errors.ts';

test('kebab-case flag names', () => {
  assert.equal(kebab('expectHead'), 'expect-head');
  assert.equal(kebab('noDiagnose'), 'no-diagnose');
  assert.equal(kebab('until'), 'until');
});

test('deriveInterface: scalars and scalar arrays are flags; objects, unions and nullable are JSON-only', () => {
  const d = deriveInterface({
    input: z.strictObject({
      pr: z.string(),
      expectHead: z.string().optional(),
      check: z.array(z.string()).optional(),
      n: z.number().optional(),
      until: z.enum(['a', 'b']).default('a'),
      testing: z.array(z.object({ kind: z.string() })),
      either: z.union([z.string(), z.number()]).optional(),
      maybe: z.string().nullable().optional(),
    }),
    positionals: ['pr'],
  });
  assert.deepEqual(
    d.flags.map((f) => [f.flag, f.type, f.multiple, f.required]),
    [
      ['--expect-head', 'string', false, false],
      ['--check', 'string', true, false],
      ['--n', 'number', false, false],
      ['--until', 'string', false, false],
    ],
  );
  assert.deepEqual(d.jsonOnly, ['testing', 'either', 'maybe']);
  assert.deepEqual(d.positionals, [{ field: 'pr', variadic: false, required: true }]);
});

test('positionalValues maps in order and rejects extras', () => {
  const d = deriveInterface({
    input: z.strictObject({ a: z.string(), b: z.array(z.string()) }),
    positionals: ['a', 'b'],
  });
  assert.deepEqual(positionalValues(['x', 'y', 'z'], d, 't'), { a: 'x', b: ['y', 'z'] });
  const one = deriveInterface({ input: z.strictObject({ a: z.string() }), positionals: ['a'] });
  assert.throws(
    () => positionalValues(['x', 'y'], one, 't'),
    (e) => isGhxError(e, 'VALIDATION'),
  );
});

test('mergeSources refuses duplicates', () => {
  assert.deepEqual(
    mergeSources([
      { name: 'a', values: { x: 1 } },
      { name: 'b', values: { y: 2 } },
    ]),
    { x: 1, y: 2 },
  );
  assert.throws(
    () =>
      mergeSources([
        { name: 'a', values: { x: 1 } },
        { name: 'b', values: { x: 2 } },
      ]),
    (e) => isGhxError(e, 'USAGE_INPUT_CONFLICT'),
  );
});
