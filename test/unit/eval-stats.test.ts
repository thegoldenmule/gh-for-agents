import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clusterBootstrap,
  mannWhitneyU,
  mean,
  median,
  mulberry32,
  normalCdf,
  p90,
  quantile,
  ranks,
  round,
} from '../../scripts/eval/metrics/stats.ts';

const close = (a: number, b: number, eps = 1e-6, msg?: string) =>
  assert.ok(Math.abs(a - b) <= eps, msg ?? `${a} ≉ ${b} (±${eps})`);

test('quantiles are type 7 (linear interpolation) and numeric, not lexicographic', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([10, 9, 100]), 10);
  // numpy.percentile([1..10], 90) = 9.1
  close(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) as number, 9.1);
  // numpy.percentile([1, 2, 2, 3, 5], 90) = 4.2
  close(quantile([1, 2, 2, 3, 5], 0.9) as number, 4.2);
  assert.equal(quantile([7], 0.9), 7);
  assert.equal(median([]), null);
  assert.equal(quantile([4, 2], 0), 2);
  assert.equal(quantile([4, 2], 1), 4);
});

test('mean', () => {
  assert.equal(mean([1, 2, 3, 6]), 3);
  assert.equal(mean([]), null);
});

test('mulberry32 is seeded and reproducible, uniform on [0, 1)', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const xs = Array.from({ length: 1000 }, () => a());
  assert.deepEqual(
    xs,
    Array.from({ length: 1000 }, () => b()),
  );
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  close(mean(xs) as number, 0.5, 0.03);
  assert.notDeepEqual(xs.slice(0, 5), Array.from({ length: 5 }, mulberry32(43)));
  // Known first outputs of mulberry32(42) (the reference C/JS implementation).
  const r = mulberry32(42);
  close(r(), 0.6011037519201636, 1e-15);
  close(r(), 0.44829055899754167, 1e-15);
});

test('clusterBootstrap: deterministic, independent of input order, contains the point estimate', () => {
  const values = Array.from({ length: 40 }, (_, i) => ({ cluster: `s${i % 8}`, value: (i * 7) % 23 }));
  const a = clusterBootstrap(values);
  const b = clusterBootstrap([...values].reverse());
  assert.ok(a);
  assert.deepEqual(a, b);
  const m = median(values.map((v) => v.value)) as number;
  assert.ok(a.median.lo <= m && m <= a.median.hi, `${m} in [${a.median.lo}, ${a.median.hi}]`);
  assert.ok(a.median.lo < a.median.hi);
  assert.ok(a.p90.lo <= a.p90.hi && a.mean.lo <= a.mean.hi);
  // A different seed gives a different (but still valid) interval.
  assert.notDeepEqual(clusterBootstrap(values, { seed: 7 }), a);
  assert.equal(clusterBootstrap([]), null);
});

test('clusterBootstrap resamples sessions: one session gives a zero-width interval', () => {
  const one = clusterBootstrap([1, 5, 9, 2, 8].map((value) => ({ cluster: 'only', value })));
  assert.ok(one);
  assert.deepEqual(one.median, { lo: 5, hi: 5 });
  assert.deepEqual(one.mean, { lo: 5, hi: 5 });
  // Same values, one per session: the interval opens up.
  const many = clusterBootstrap([1, 5, 9, 2, 8].map((value, i) => ({ cluster: `s${i}`, value })));
  assert.ok(many && many.median.lo < many.median.hi);
});

test('clusterBootstrap with constant values collapses to the constant', () => {
  const r = clusterBootstrap(Array.from({ length: 10 }, (_, i) => ({ cluster: `s${i}`, value: 3 })));
  assert.deepEqual(r, { median: { lo: 3, hi: 3 }, p90: { lo: 3, hi: 3 }, mean: { lo: 3, hi: 3 } });
});

test('ranks average ties', () => {
  assert.deepEqual(ranks([10, 20, 20, 5]), [2, 3.5, 3.5, 1]);
  assert.deepEqual(ranks([]), []);
});

test('normalCdf', () => {
  close(normalCdf(0), 0.5, 1e-7);
  close(normalCdf(1.959963985), 0.975, 1e-6);
  close(normalCdf(-2.5067182457620487), 0.0060928901776724, 1e-7);
});

test('mannWhitneyU: fully separated samples, worked by hand', () => {
  // U = 0; mu = 12.5; sigma = sqrt(25 * 11 / 12); z = (0 - 12.5 + 0.5) / sigma = -2.50672; p = 2 Φ(z).
  const r = mannWhitneyU([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]);
  assert.ok(r);
  assert.equal(r.u, 0);
  close(r.z, -2.5067182457620487, 1e-9);
  close(r.p, 0.012185780355344815, 1e-6);
  const rev = mannWhitneyU([6, 7, 8, 9, 10], [1, 2, 3, 4, 5]);
  assert.ok(rev);
  assert.equal(rev.u, 25);
  close(rev.p, r.p, 1e-12);
});

test('mannWhitneyU: U_a + U_b = n1·n2, identical samples give p = 1, ties corrected', () => {
  const a = [1, 3, 3, 5, 8, 8, 9];
  const b = [2, 3, 4, 8, 10];
  const ab = mannWhitneyU(a, b);
  const ba = mannWhitneyU(b, a);
  assert.ok(ab && ba);
  assert.equal(ab.u + ba.u, a.length * b.length);
  close(ab.p, ba.p, 1e-12);
  const same = mannWhitneyU([1, 2, 3], [1, 2, 3]);
  assert.ok(same);
  assert.equal(same.u, 4.5);
  assert.equal(same.p, 1);
  // All values tied: no variance, p = 1.
  assert.deepEqual(mannWhitneyU([2, 2], [2, 2, 2]), { u: 3, n1: 2, n2: 3, z: 0, p: 1 });
  assert.equal(mannWhitneyU([], [1]), null);
  // Hand-worked tie case: a = [1, 2, 2], b = [2, 3]. Ranks: 1→1, 2→3 (×3), 3→5. R1 = 7, U = 1.
  // mu = 3; tie term = 3³ - 3 = 24; sigma² = (6 / 12)(6 - 24 / 20) = 2.4; z = (1 - 3 + 0.5) / √2.4.
  const t = mannWhitneyU([1, 2, 2], [2, 3]);
  assert.ok(t);
  assert.equal(t.u, 1);
  close(t.z, -1.5 / Math.sqrt(2.4), 1e-12);
});

test('round: fixed decimals, no negative zero', () => {
  assert.equal(round(0.1 + 0.2), 0.3);
  assert.equal(round(-0.0000001), 0);
  assert.ok(Object.is(round(-0.0000001), 0));
  assert.equal(round(2.5, 0), 3);
  assert.equal(round(1.23456789, 3), 1.235);
});
