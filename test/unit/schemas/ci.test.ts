import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { z } from 'zod';
import * as ci from '../../../src/schemas/ci.ts';
import {
  CI_CAPS,
  CiSummary,
  CompactDiagnosis,
  DiagnosisJob,
  FailingCheck,
  FailingJob,
  SameOnMain,
  TargetSummary,
  WaitEvent,
  WaitSummary,
} from '../../../src/schemas/ci.ts';
import { EXIT } from '../../contract/exit-table.ts';
import { assertExportable } from './_exportable.ts';

const SHA = '9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d';
const ok = (s: z.ZodType, v: unknown) => {
  const r = s.safeParse(v);
  assert.ok(r.success, r.success ? '' : JSON.stringify(r.error.issues));
};
const bad = (s: z.ZodType, v: unknown) => assert.ok(!s.safeParse(v).success, `expected fail: ${JSON.stringify(v)}`);
const names = (n: number) => Array.from({ length: n }, (_, i) => `test ${i}`);

const check = {
  name: 'test (ubuntu-latest)',
  workflow: 'CI',
  kind: 'actions',
  bucket: 'fail',
  status: 'completed',
  conclusion: 'failure',
  required: true,
  runId: 37948190914,
  jobId: 111978835495,
  attempt: 1,
  url: 'https://github.com/powerhouse-inc/powerhouse/actions/runs/37948190914/job/111978835495',
  startedAt: '2026-10-21T16:23:30Z',
  completedAt: '2026-10-21T16:41:02Z',
};
const sameOnMain = {
  verdict: 'different',
  mainBranch: 'main',
  mainRunId: 1,
  mainSha: 'c0ffee1d2e3f405162738495a6b7c8d9e0f1a2b3',
  mainRunAt: '2026-10-21T15:58:19Z',
  prTests: ['a > b'],
  mainTests: [],
  newTests: ['a > b'],
};
const flake = { candidate: false, score: 'none', signals: [] };
const counts = { pass: 10, fail: 1, pending: 0, skipped: 2, cancelled: 0, neutral: 0, ignored: 1 };
const summary = {
  headSha: SHA,
  forHeadSha: true,
  state: 'red',
  phase: 'settled',
  counts,
  failing: [{ ...check, sameOnMain, flake }],
  pending: [],
  ignored: ['notify-discord'],
  expectedMissing: [],
  eta: null,
  next: ['ghx ci why #3301'],
};
const job = {
  workflow: 'CI',
  job: 'test (ubuntu-latest)',
  jobId: 111978835495,
  runId: 37948190914,
  attempt: 1,
  url: check.url,
  conclusion: 'failure',
  required: true,
  step: { number: 5, name: 'Run tests' },
  tests: ['a > b'],
  errors: ['AssertionError: expected 3 to equal 4'],
  exitLine: 'Process completed with exit code 1.',
  excerpt: 'FAIL a > b',
  logPath: '/tmp/ghx/logs/job-111978835495.log',
  logBytes: 12345,
  sameOnMain,
  flake,
};
const compact = {
  job: 'test',
  workflow: 'CI',
  jobId: 1,
  step: 'Run tests',
  tests: ['a > b'],
  firstError: 'AssertionError',
  logPath: null,
  sameOnMain: 'different',
  flake: 'none',
};

test('every exported schema exports to JSON Schema (no transforms)', () => {
  assert.ok(assertExportable(ci) >= 25);
});

test('CiSummary: a red summary parses; forHeadSha is the literal true', () => {
  ok(CiSummary, summary);
  bad(CiSummary, { ...summary, forHeadSha: false });
  const { forHeadSha: _, ...without } = summary;
  bad(CiSummary, without);
  bad(CiSummary, { ...summary, headSha: '9f2c4e1' });
  bad(CiSummary, { ...summary, state: 'success' });
  ok(CiSummary, { ...summary, eta: { seconds: 120, p90Seconds: 300, basis: '10 runs on main' } });
  bad(CiSummary, { ...summary, counts: { ...counts, pass: -1 } });
});

test('Check: url is a URL; ids are integers; StatusContext shape', () => {
  ok(FailingCheck, { ...check, sameOnMain: null, flake: null });
  bad(FailingCheck, { ...check, url: 'not a url', sameOnMain: null, flake: null });
  ok(ci.Check, { ...check, kind: 'status', workflow: null, runId: null, jobId: null, attempt: null });
  bad(ci.Check, { ...check, url: null });
});

test('caps: 30 tests, 20 errors, 300-char lines, 2,000-char excerpt (03 §5.1)', () => {
  ok(FailingJob, job);
  ok(FailingJob, { ...job, tests: names(CI_CAPS.tests), errors: names(CI_CAPS.errors) });
  bad(FailingJob, { ...job, tests: names(31) });
  bad(FailingJob, { ...job, errors: names(21) });
  ok(FailingJob, { ...job, tests: ['x'.repeat(300)] });
  bad(FailingJob, { ...job, tests: ['x'.repeat(301)] });
  ok(FailingJob, { ...job, excerpt: 'x'.repeat(2000) });
  bad(FailingJob, { ...job, excerpt: 'x'.repeat(2001) });
  ok(SameOnMain, { ...sameOnMain, prTests: names(30) });
  bad(SameOnMain, { ...sameOnMain, mainTests: names(31) });
});

test('diagnosis event caps: 10 tests, 5 errors, 1,500 chars', () => {
  ok(DiagnosisJob, { ...job, tests: names(10), errors: names(5), excerpt: 'x'.repeat(1500) });
  bad(DiagnosisJob, { ...job, tests: names(11) });
  bad(DiagnosisJob, { ...job, errors: names(6) });
  bad(DiagnosisJob, { ...job, excerpt: 'x'.repeat(1501) });
});

test('CompactDiagnosis: at most 5 tests', () => {
  ok(CompactDiagnosis, { ...compact, tests: names(5) });
  bad(CompactDiagnosis, { ...compact, tests: names(6) });
  bad(CompactDiagnosis, { ...compact, flake: 'maybe' });
});

test('WaitEvent: every variant has a literal type outside the reserved set', () => {
  ok(WaitEvent, { type: 'diagnosis', target: '#3301', headSha: SHA, job });
  ok(WaitEvent, { type: 'check', target: '#3301', headSha: SHA, ...pick(check), from: 'absent', to: 'pending' });
  ok(WaitEvent, { type: 'head-changed', target: '#3301', from: SHA, to: SHA, action: 'restart' });
  bad(WaitEvent, { type: 'summary', target: '#3301' });
  for (const o of WaitEvent.options) {
    const t = o.shape.type.value;
    assert.ok(!['summary', 'error', 'heartbeat', 'warning'].includes(t), t);
  }
});

function pick(c: typeof check) {
  const { name, workflow, conclusion, required, runId, jobId, url } = c;
  return { name, workflow, conclusion, required, runId, jobId, url };
}

test('TargetSummary and WaitSummary: stalled "missing" (03 Q1); ≤5 compact jobs', () => {
  const target = {
    target: '#3301',
    outcome: 'stalled',
    reason: 'required check never registered',
    headSha: SHA,
    restarts: 0,
    elapsedSec: 900,
    ci: { state: 'pending', phase: 'partial', counts, failing: [], expectedMissing: ['build'] },
    diagnosis: { jobs: [compact], partial: false },
    stalled: [{ name: 'build', state: 'missing', forSec: 600, thresholdSec: 600, basis: 'ci.stall.missingMinutes' }],
    rerunCandidates: [],
    merge: null,
    next: ['ghx ci wait #3301'],
  };
  ok(TargetSummary, target);
  bad(TargetSummary, { ...target, diagnosis: { jobs: Array(6).fill(compact), partial: true } });
  bad(TargetSummary, { ...target, outcome: 'timeout' });
  ok(WaitSummary, {
    outcome: 'stalled',
    exitCode: EXIT.CI_STALLED,
    results: [target],
    diagnosisPath: null,
    eventsPath: '/x',
    resumed: false,
  });
});
