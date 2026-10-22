import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type BaselineStats,
  baselineStats,
  computeEta,
  type DurationSample,
  jobStats,
  needsPullRequestSamples,
  quantile,
  samplesFromJobs,
} from '../../../../src/ci/wait/eta.ts';
import { Eta } from '../../../../src/schemas/ci.ts';
import { at, check, job, MIN, T0 } from './_data.ts';

const d = (...secs: number[]): DurationSample[] => secs.map((durationSec) => ({ durationSec, queueSec: null }));

test('median and p90 with 1, 2 and 10 samples', () => {
  assert.deepEqual([quantile([300], 0.5), quantile([300], 0.9)], [300, 300]);
  assert.deepEqual([quantile([200, 100], 0.5), quantile([100, 200], 0.9)], [150, 190]);
  const ten = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((x) => x * 60);
  assert.equal(quantile(ten, 0.5), 330);
  assert.equal(quantile(ten, 0.9), 546);
  assert.throws(() => quantile([], 0.5), RangeError);
  const s = jobStats(d(...ten), 'push');
  assert.deepEqual(s, { samples: 10, medianSec: 330, p90Sec: 546, queueMedianSec: 0, source: 'push' });
  assert.equal(jobStats([], 'push'), null);
});

test('samples come from successful completed jobs: duration from started_at, queue from created_at', () => {
  const samples = samplesFromJobs([
    job(1, 'unit', {
      conclusion: 'success',
      status: 'completed',
      created_at: at(0),
      started_at: at(1),
      completed_at: at(6),
    }),
    job(2, 'unit', {
      conclusion: 'success',
      status: 'completed',
      created_at: null,
      started_at: at(0),
      completed_at: at(4),
    }),
    job(3, 'unit', { conclusion: 'failure', status: 'completed', started_at: at(0), completed_at: at(1) }),
    job(4, 'lint', { conclusion: 'success', status: 'in_progress', started_at: at(0), completed_at: null }),
  ]);
  assert.deepEqual(samples, {
    unit: [
      { durationSec: 300, queueSec: 60 },
      { durationSec: 240, queueSec: null },
    ],
  });
});

test('push-run job names that do not match fall back to pull_request samples, per job', () => {
  const push = { build: d(100, 200), unit: d(300) };
  const pr = { build: d(999), e2e: d(600, 800) };
  const stats = baselineStats(['build', 'e2e', 'docs'], push, pr);
  assert.equal(stats.build?.source, 'push');
  assert.equal(stats.build?.medianSec, 150);
  assert.equal(stats.e2e?.source, 'pull_request');
  assert.equal(stats.e2e?.medianSec, 700);
  assert.equal(stats.docs, undefined);
  assert.equal(needsPullRequestSamples(['build', 'unit'], push), false);
  assert.equal(needsPullRequestSamples(['build', 'e2e'], push), true);
});

const stats: BaselineStats = {
  build: { samples: 3, medianSec: 600, p90Sec: 900, queueMedianSec: 30, source: 'push' },
  unit: { samples: 3, medianSec: 300, p90Sec: 360, queueMedianSec: 60, source: 'push' },
};
const now = (m: number) => T0 + m * MIN;

test('ETA is the max over pending checks of median − elapsed, with p90 alongside', () => {
  const e = computeEta([check('build', { startedAt: at(0) }), check('unit', { startedAt: at(0) })], stats, now(2));
  Eta.parse(e.eta);
  assert.deepEqual(e.eta, { seconds: 480, p90Seconds: 780, basis: 'baseline' });
  assert.equal(e.soonestSec, 180);
  assert.equal(e.overrun, false);
});

test('queued checks add the median queue time still to come', () => {
  const fresh = computeEta([check('unit', { status: 'queued', startedAt: at(2) })], stats, now(2));
  assert.deepEqual(fresh.eta, { seconds: 360, p90Seconds: 420, basis: 'baseline' });
  const waited = computeEta([check('unit', { status: 'queued', startedAt: at(0) })], stats, now(2));
  assert.equal(waited.eta?.seconds, 300, 'queued past the median queue time: only the run remains');
});

test('ETA is clipped at 0 when overrun', () => {
  const e = computeEta([check('build', { startedAt: at(0) })], stats, now(12));
  assert.deepEqual(e.eta, { seconds: 0, p90Seconds: 180, basis: 'baseline' });
  assert.equal(e.overrun, true);
  assert.equal(e.soonestSec, null);
  const later = computeEta([check('build', { startedAt: at(0) })], stats, now(20));
  assert.deepEqual(later.eta, { seconds: 0, p90Seconds: 0, basis: 'baseline' });
});

test('checks without a baseline are skipped; none at all gives a null ETA', () => {
  const e = computeEta([check('unit', { startedAt: at(0) }), check('docs')], stats, now(1));
  assert.deepEqual(e.eta, { seconds: 240, p90Seconds: 300, basis: 'partial-baseline' });
  assert.deepEqual(computeEta([check('docs')], stats, now(1)), {
    eta: null,
    soonestSec: null,
    overrun: false,
    perCheck: [],
  });
});
