import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { ConfigSchema } from '../../../../src/config/schema.ts';
import { normalizeComponents } from '../../../../src/pr/create/check.ts';
import { createExample, createRulesSummary } from '../../../../src/pr/create/example.ts';
import { createRules } from '../../../../src/pr/create/rules.ts';
import { PrCreateInput } from '../../../../src/pr/create/schema.ts';

const ticket = { format: 'ticket', ticket: { pattern: '^ENG-\\d+$', example: 'ENG-123' } };
const config = (title: unknown = ticket) => ConfigSchema.parse({ version: 1, components: { app: {} }, title });
const input = (title: string) =>
  PrCreateInput.parse({
    ...createExample(config()),
    title,
    base: 'main',
    head: 'feat/x',
  });
const codes = (title: string, cfg = config()) => createRules(input(title), { config: cfg }).map((i) => i.code);

test('ticket configuration requires a valid regex and matching example, and exports to JSON Schema', () => {
  for (const title of [
    { format: 'ticket' },
    { ...ticket, ticket: { pattern: '[', example: 'ENG-1' } },
    { ...ticket, ticket: { pattern: '^ENG-\\d+$', example: 'ENG-x' } },
    { ...ticket, ticket: { pattern: '.+', example: 'ENG 1' } },
    { ...ticket, ticket: { pattern: '.+', example: 'ENG:1' } },
  ]) {
    assert.equal(ConfigSchema.safeParse({ version: 1, components: { app: {} }, title }).success, false);
  }
  assert.equal(config({}).title.format, 'conventional');
  assert.doesNotThrow(() => z.toJSONSchema(ConfigSchema, { io: 'input' }));
});

test('ticket mode validates the complete key and keeps shared title rules', () => {
  assert.deepEqual(codes('ENG-123: repair retry ordering'), []);
  for (const title of [
    'ENG-x: repair',
    'fix(app): repair',
    'ENG-123:',
    'ENG-123: ',
    'xENG-123: repair',
    'ENG-123x: repair',
  ]) {
    assert.ok(codes(title).includes('title.format'), title);
  }
  const unanchored = config({ ...ticket, ticket: { pattern: 'ENG-\\d+', example: 'ENG-1' } });
  assert.ok(codes('prefixENG-123: repair', unanchored).includes('title.format'));
  assert.deepEqual(codes('ENG-123:  repair'), ['title.whitespace']);
  assert.deepEqual(codes('ENG-123: repair.'), ['title.trailing_period']);
  assert.deepEqual(codes('ENG-123: repair (#12)'), ['title.pr_suffix']);
  assert.deepEqual(codes(`ENG-1: ${'🤖'.repeat(65)}`), []);
  assert.deepEqual(codes(`ENG-1: ${'🤖'.repeat(66)}`), ['title.too_long']);
  assert.deepEqual(codes('ENG-1: repair', config({ ...ticket, scopeRequired: true })), []);
});

test('ticket examples remain valid even with a long configured key', () => {
  const cfg = config({ format: 'ticket', ticket: { pattern: 'X+', example: 'X'.repeat(60) } });
  const example = PrCreateInput.parse({ ...createExample(cfg), base: 'main', head: 'feat/x' });
  assert.deepEqual(createRules(example, { config: cfg }), []);
  assert.match(createRulesSummary(cfg)[0] ?? '', /KEY: summary/);
});

test('component aliases never rewrite ticket keys that resemble conventional scopes', () => {
  const cfg = ConfigSchema.parse({
    version: 1,
    components: { app: { aliases: ['old'] } },
    title: { format: 'ticket', ticket: { pattern: 'ENG\\(old\\)', example: 'ENG(old)' } },
  });
  const value = { title: 'ENG(old): repair', components: ['old'] };
  normalizeComponents(value, cfg, { addScope: true });
  assert.equal(value.title, 'ENG(old): repair');
  assert.deepEqual(value.components, ['app']);
});
