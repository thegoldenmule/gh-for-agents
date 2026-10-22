import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { z } from 'zod';
import { ConfigSchema, defaultConfig } from '../../../src/config/schema.ts';
import * as pr from '../../../src/schemas/pr.ts';
import {
  CommentKindRead,
  ComponentName,
  Condition,
  ConditionRead,
  componentEnum,
  FindingStatus,
  Location,
  PreconditionStatus,
  Refs,
  RefsRead,
  ResolveStatus,
  Risk,
  RiskRead,
  riskRank,
  SeverityRead,
  StatusEvent,
  severityRank,
  TestingItem,
  TestingItemRead,
  Violation,
} from '../../../src/schemas/pr.ts';
import { assertExportable } from './_exportable.ts';

const ok = (s: z.ZodType, v: unknown) => assert.ok(s.safeParse(v).success, `expected pass: ${JSON.stringify(v)}`);
const bad = (s: z.ZodType, v: unknown) => assert.ok(!s.safeParse(v).success, `expected fail: ${JSON.stringify(v)}`);

const config = ConfigSchema.parse({
  version: 1,
  components: { reactor: {}, codegen: { paths: ['packages/codegen/**'] } },
});

test('every exported schema exports to JSON Schema (no transforms)', () => {
  const n = assertExportable(pr, { componentEnum: () => componentEnum(config) });
  assert.ok(n >= 30);
});

test('enums: the 02 §1.5 values exactly', () => {
  assert.deepEqual(Risk.options, ['trivial', 'low', 'medium', 'high']);
  assert.deepEqual(pr.RevertPolicy.options, ['revert-safe', 'revert-with-followup', 'coordinated', 'forward-fix-only']);
  assert.deepEqual(pr.Severity.options, ['high', 'medium', 'low']);
  assert.deepEqual(pr.Verdict.options, ['approve', 'request-changes', 'comment']);
  assert.deepEqual(FindingStatus.options, ['open', 'addressed', 'wontfix', 'deferred']);
  assert.deepEqual(PreconditionStatus.options, ['met', 'unmet', 'unknown', 'withdrawn']);
  bad(Risk, 'critical');
  ok(ResolveStatus, 'addressed');
  ok(ResolveStatus, 'withdrawn');
  bad(ResolveStatus, 'done');
});

test('lenient read enums keep unknown values; strict ones reject them (02 §9.3)', () => {
  assert.equal(RiskRead.parse('catastrophic'), 'catastrophic');
  assert.equal(SeverityRead.parse('blocker'), 'blocker');
  assert.equal(CommentKindRead.parse('poll'), 'poll');
  bad(pr.Severity, 'blocker');
  bad(RiskRead, 3);
});

test('riskRank and severityRank fail closed: unknown ranks as high', () => {
  assert.deepEqual(['trivial', 'low', 'medium', 'high'].map(riskRank), [0, 1, 2, 3]);
  assert.equal(riskRank('catastrophic'), riskRank('high'));
  assert.deepEqual(['low', 'medium', 'high'].map(severityRank), [0, 1, 2]);
  assert.equal(severityRank('blocker'), severityRank('high'));
  assert.ok(riskRank('low') < riskRank('medium'));
});

test('componentEnum: the config record keys; an empty config rejects everything', () => {
  const C = componentEnum(config);
  ok(C, 'reactor');
  ok(C, 'codegen');
  bad(C, 'vetra');
  const none = componentEnum(defaultConfig());
  bad(none, 'reactor');
  ok(ComponentName, 'vetra');
  bad(ComponentName, 'Vetra');
});

test('TestingItem: strict structure; cwd repo-relative; steps 1..5', () => {
  ok(TestingItem, { kind: 'unit', command: 'pnpm test', result: 'pass' });
  ok(TestingItem, { kind: 'unit', command: 'pnpm test', cwd: 'packages/reactor', result: 'pass' });
  ok(TestingItem, { kind: 'manual', steps: ['open it'], result: 'pass' });
  bad(TestingItem, { kind: 'unit', command: 'pnpm test', result: 'pass', extra: 1 });
  bad(TestingItem, { kind: 'smoke', result: 'pass' });
  for (const cwd of ['../x', '/abs', 'a/../b']) bad(TestingItem, { kind: 'unit', command: 'x', cwd, result: 'pass' });
  bad(TestingItem, { kind: 'manual', steps: [], result: 'pass' });
  bad(TestingItem, { kind: 'manual', steps: Array(6).fill('s'), result: 'pass' });
  bad(TestingItem, { kind: 'unit', command: 'x'.repeat(201), result: 'pass' });
});

test('TestingItemRead and RefsRead keep unknown keys and enum values', () => {
  const t = TestingItemRead.parse({ kind: 'fuzz', result: 'flaky', future: true });
  assert.deepEqual(t, { kind: 'fuzz', result: 'flaky', future: true });
  bad(Refs, { stackedOn: '#1', blockedBy: '#2' });
  assert.deepEqual(RefsRead.parse({ stackedOn: '#1', blockedBy: '#2' }), { stackedOn: '#1', blockedBy: '#2' });
  bad(Refs, { closes: Array(11).fill('#1') });
});

test('Condition: strict union; ConditionRead keeps unknown types but not malformed known ones', () => {
  ok(Condition, { type: 'pr-merged', ref: '#3184' });
  ok(Condition, { type: 'release-includes', ref: 'o/r#1' });
  ok(Condition, { type: 'manual', text: 'deploy first' });
  bad(Condition, { type: 'pr-merged', ref: '#3184', extra: 1 });
  bad(Condition, { type: 'ci-green' });
  assert.deepEqual(ConditionRead.parse({ type: 'ci-green', branch: 'main' }), { type: 'ci-green', branch: 'main' });
  assert.deepEqual(ConditionRead.parse({ type: 'pr-merged', ref: '#1', note: 'x' }), {
    type: 'pr-merged',
    ref: '#1',
    note: 'x',
  });
  bad(ConditionRead, { type: 'pr-merged' });
  bad(ConditionRead, { type: 'manual' });
  bad(ConditionRead, { text: 'x' });
});

test('Violation, StatusEvent and Location', () => {
  ok(Violation, { code: 'CI_RED', message: '1 failing', overridable: true });
  ok(Violation, { code: 'CI_RED', message: '1 failing', overridable: true, details: { jobs: [1] } });
  bad(Violation, { code: 'CI_RED', message: 'x' });
  ok(StatusEvent, {
    id: 'c_w5j1ve',
    by: 'thegoldenmule',
    at: '2026-10-21T16:22:45Z',
    commit: '9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d',
    note: null,
    verified: true,
    url: 'https://github.com/o/r/pull/1#discussion_r1',
  });
  bad(StatusEvent, { id: 'c_w5j1ve', by: 'x', at: 'now', commit: null, note: null, verified: null, url: '' });
  ok(Location, { path: 'a/b.ts', line: 1 });
  bad(Location, { path: 'a/b.ts', line: 0 });
  bad(Location, { path: '/a', line: 1 });
});
