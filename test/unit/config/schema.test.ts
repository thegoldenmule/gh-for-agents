import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { parseConfigText } from '../../../src/config/load.ts';
import { ConfigSchema, defaultConfig } from '../../../src/config/schema.ts';
import { type GhxError, isGhxError } from '../../../src/core/errors.ts';
import { isValidGlob, matchesGlob } from '../../../src/util/glob.ts';

const FIX = join(import.meta.dirname, '../../fixtures/config');
const local = (f: string) => ({ kind: 'local' as const, path: join(FIX, f) });
const parseFixture = (f: string) => parseConfigText(readFileSync(join(FIX, f), 'utf8'), local(f));

test('prefault populates every section from the minimal config (zod 4 .prefault, not .default)', () => {
  const c = parseFixture('valid-minimal.json');
  assert.deepEqual(c, {
    version: 1,
    components: { x: {} },
    title: {
      types: ['feat', 'fix', 'docs', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert', 'style'],
      scopeRequired: false,
    },
    render: { descriptionMaxChars: 500 },
    create: { requirePassingTest: true },
    merge: { method: 'merge', allowedMethods: ['merge'] },
    ci: { ignore: [] },
    trust: {},
    bots: {},
  });
});

test('the full sample parses', () => {
  const c = parseFixture('valid-full.json');
  assert.deepEqual(c.merge.allowedMethods, ['merge', 'squash']);
  assert.equal(c.ci.ignore.length, 2);
});

test('defaults (file absent, need optional) have no components and merge by default', () => {
  const d = defaultConfig();
  assert.deepEqual(d.components, {});
  assert.equal(d.merge.method, 'merge');
});

test('invalid JSON reports line and column with the source', () => {
  assert.throws(
    () => parseFixture('invalid-json.json'),
    (e: GhxError) => {
      assert.ok(isGhxError(e, 'CONFIG_INVALID_JSON'));
      assert.equal(e.exitCode, 3);
      assert.equal(e.details?.line, 4);
      assert.deepEqual(e.details?.source, { kind: 'local', path: join(FIX, 'invalid-json.json') });
      return true;
    },
  );
});

test('unknown keys get did-you-mean: componets → components', () => {
  assert.throws(
    () => parseFixture('invalid-key.json'),
    (e: GhxError) => {
      assert.ok(isGhxError(e, 'CONFIG_INVALID'));
      const issues = e.details?.issues as { path: string; suggestion?: string }[];
      assert.ok(issues.some((i) => i.path === 'componets' && i.suggestion === 'components'));
      assert.match(e.hint ?? '', /did you mean 'components'/);
      return true;
    },
  );
});

test('merge.method must be in allowedMethods; globs must compile; one component at least', () => {
  for (const [f, path] of [
    ['invalid-method.json', 'merge.method'],
    ['invalid-glob.json', 'components.x.paths[0]'],
    ['invalid-no-components.json', 'components'],
  ] as const) {
    assert.throws(
      () => parseFixture(f),
      (e: GhxError) => {
        assert.ok(isGhxError(e, 'CONFIG_INVALID'), f);
        assert.ok(
          ((e.details?.issues ?? []) as { path: string }[]).some((i) => i.path === path),
          `${f}: ${JSON.stringify(e.details?.issues)}`,
        );
        return true;
      },
    );
  }
});

test('an unsupported version is CONFIG_UNSUPPORTED_VERSION', () => {
  assert.throws(
    () => parseFixture('unsupported-version.json'),
    (e) => isGhxError(e, 'CONFIG_UNSUPPORTED_VERSION'),
  );
});

test('the schema is representable as JSON Schema (ghx schema config)', () => {
  const js = z.toJSONSchema(ConfigSchema, { io: 'input' }) as {
    required?: string[];
    properties?: Record<string, unknown>;
  };
  assert.deepEqual(js.required, ['version', 'components']);
  assert.ok(js.properties?.merge && js.properties.ci);
});

test('glob validity and matching', () => {
  for (const ok of ['packages/*/src/**', '**/*.md', 'docs/{a,b}/**', 'a\\[b']) assert.ok(isValidGlob(ok), ok);
  for (const bad of ['', '/abs/**', '../x', 'a/[b', 'a/{b', 'a}', 'x\\']) assert.ok(!isValidGlob(bad), bad);
  assert.ok(matchesGlob('packages/reactor/src/a.ts', 'packages/reactor/**'));
});
