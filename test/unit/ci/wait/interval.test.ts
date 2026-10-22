import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EtaEstimate } from '../../../../src/ci/wait/eta.ts';
import { baseIntervalSec, INTERVAL, pollInterval, rateMultiplier } from '../../../../src/ci/wait/interval.ts';
import { type Random, seededRandom } from '../../../../src/core/random.ts';
import type { RateBudget } from '../../../../src/gh/ratelimit.ts';
import { T0 } from './_data.ts';

/** Always the midpoint: no jitter. */
const mid: Random = { next: () => 0.5 };

const est = (seconds: number, soonestSec: number | null = seconds, overrun = false): EtaEstimate => ({
  eta: { seconds, p90Seconds: seconds, basis: 'baseline' },
  soonestSec,
  overrun,
  perCheck: [],
});

const budget = (remaining: number, limit = 5000, resetAt = T0 + 600_000): RateBudget => ({
  resource: 'core',
  limit,
  remaining,
  used: limit - remaining,
  resetAt,
  observedAt: T0,
});

test('the interval table (02 §11.6)', () => {
  const rows: [string, Parameters<typeof baseIntervalSec>, number, string][] = [
    ['registering polls every 10 s', ['registering', null], 10, 'registering'],
    ['registering ignores an ETA', ['registering', est(600)], 10, 'registering'],
    ['running: eta/6', ['running', est(240, 200)], 40, 'eta'],
    ['running: eta/6 clamped up to 15 s', ['running', est(66, 66)], 15, 'eta'],
    ['running: eta/6 clamped down to 60 s', ['running', est(3600, 3000)], 60, 'eta'],
    ['partial follows the running rules', ['partial', est(240, 200)], 40, 'eta'],
    ['10 s within 60 s of an expected completion', ['running', est(900, 60)], 10, 'near-completion'],
    ['61 s out is not "within 60 s"', ['running', est(900, 61)], 60, 'eta'],
    ['30 s after the ETA is overrun', ['running', est(0, null, true)], 30, 'overrun'],
    ['no baseline: 30 s', ['running', null], 30, 'no-eta'],
  ];
  for (const [label, args, sec, reason] of rows) {
    assert.deepEqual(baseIntervalSec(...args), { sec, reason }, label);
  }
});

test('pollInterval without jitter, attended, healthy budget, is the table value', () => {
  const r = pollInterval({
    phase: 'running',
    estimate: est(240, 200),
    attended: true,
    budget: budget(4000),
    now: T0,
    random: mid,
  });
  assert.deepEqual(r, { ms: 40_000, reason: 'eta', rateLimited: false, pausedUntil: null });
});

test('an unattended session never polls faster than every 30 s', () => {
  const r = seededRandom(7);
  for (let i = 0; i < 1000; i++) {
    const phase = (['registering', 'partial', 'running'] as const)[i % 3] ?? 'running';
    const d = pollInterval({ phase, estimate: est(90 + (i % 400), i % 120), attended: false, now: T0, random: r });
    assert.ok(d.ms >= INTERVAL.unattendedFloorSec * 1000, `draw ${i}: ${d.ms}`);
  }
  const reg = pollInterval({ phase: 'registering', estimate: null, attended: false, now: T0, random: mid });
  assert.equal(reg.ms, 30_000);
  // Above the floor, unattended changes nothing.
  const slow = pollInterval({ phase: 'running', estimate: est(3600, 3000), attended: false, now: T0, random: mid });
  assert.equal(slow.ms, 60_000);
});

test('jitter stays within ±10% over 1 000 seeded draws, and is deterministic per seed', () => {
  const r = seededRandom(42);
  let lo = Number.POSITIVE_INFINITY;
  let hi = 0;
  for (let i = 0; i < 1000; i++) {
    const { ms } = pollInterval({ phase: 'running', estimate: est(240, 200), attended: true, now: T0, random: r });
    assert.ok(ms >= 36_000 && ms <= 44_000, `draw ${i}: ${ms}`);
    lo = Math.min(lo, ms);
    hi = Math.max(hi, ms);
  }
  assert.ok(lo < 37_000 && hi > 43_000, 'the draws actually spread across the band');
  const a = seededRandom(3);
  const b = seededRandom(3);
  for (let i = 0; i < 10; i++) {
    const x = pollInterval({ phase: 'registering', estimate: null, attended: true, now: T0, random: a });
    const y = pollInterval({ phase: 'registering', estimate: null, attended: true, now: T0, random: b });
    assert.equal(x.ms, y.ms);
  }
});

test('under 10% of the rate budget the interval is ×4 and flags rate-limit', () => {
  assert.equal(rateMultiplier(undefined), 1);
  assert.equal(rateMultiplier(budget(500)), 1, 'exactly 10% is not under 10%');
  assert.equal(rateMultiplier(budget(499)), 4);
  assert.equal(rateMultiplier(budget(0, 0)), 1, 'a zero limit is not a budget');
  const r = pollInterval({
    phase: 'running',
    estimate: est(240, 200),
    attended: true,
    budget: budget(100),
    now: T0,
    random: mid,
  });
  assert.deepEqual(r, { ms: 160_000, reason: 'eta', rateLimited: true, pausedUntil: null });
});

test('an exhausted budget pauses until resetAt', () => {
  const resetAt = T0 + 15 * 60_000;
  const r = pollInterval({
    phase: 'registering',
    estimate: null,
    attended: true,
    budget: budget(0, 5000, resetAt),
    now: T0,
    random: seededRandom(1),
  });
  assert.equal(r.pausedUntil, resetAt);
  assert.equal(r.rateLimited, true);
  assert.ok(r.ms >= resetAt - T0);
  // A reset already passed falls back to the (×4) table value.
  const past = pollInterval({
    phase: 'registering',
    estimate: null,
    attended: true,
    budget: budget(0, 5000, T0 - 1),
    now: T0,
    random: mid,
  });
  assert.equal(past.ms, 40_000);
});
