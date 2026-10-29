// Statistics for ghx-eval reports (plan 07, determinism 5): quantiles, a seeded cluster bootstrap and the
// Mann-Whitney U test. No Math.random: the bootstrap draws from a local mulberry32, re-seeded for every
// statistic, so a value never depends on what was computed before it.

export const BOOTSTRAP_SEED = 42;
export const BOOTSTRAP_B = 1000;
export const CI_LEVEL = 0.95;

/** How every quantile in a report is computed; report.json records it. */
export const QUANTILE_METHOD = 'linear interpolation between order statistics (Hyndman-Fan type 7)';
export const BOOTSTRAP_METHOD = 'cluster bootstrap: resample sessions with replacement, percentile interval';
export const MANN_WHITNEY_METHOD = 'two-sided, normal approximation with tie and continuity correction';

/** mulberry32: a 32-bit seeded PRNG, uniform on [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ascending copy (numbers compare numerically, never as strings). */
export function sorted(xs: readonly number[]): number[] {
  return Array.from(Float64Array.from(xs).sort());
}

/** Type 7 quantile of an ascending array; null when empty. */
export function quantileSorted(s: ArrayLike<number>, p: number): number | null {
  const n = s.length;
  if (n === 0) return null;
  if (p <= 0) return s[0] as number;
  if (p >= 1) return s[n - 1] as number;
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const a = s[lo] as number;
  if (lo + 1 >= n) return a;
  const b = s[lo + 1] as number;
  return a + (h - lo) * (b - a);
}

export function quantile(xs: readonly number[], p: number): number | null {
  return quantileSorted(sorted(xs), p);
}

export function median(xs: readonly number[]): number | null {
  return quantile(xs, 0.5);
}

export function p90(xs: readonly number[]): number | null {
  return quantile(xs, 0.9);
}

export function mean(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export interface Interval {
  lo: number;
  hi: number;
}

export interface BootstrapResult {
  median: Interval;
  p90: Interval;
  mean: Interval;
}

export interface BootstrapOptions {
  seed?: number;
  B?: number;
  level?: number;
}

/**
 * Cluster bootstrap (determinism 5): resample clusters (sessions) with replacement, pool their values, and
 * take the median, p90 and mean of each resample; the interval is the percentile interval of those B
 * statistics. Clusters are ordered by id before drawing, so input order never matters. Null when empty.
 */
export function clusterBootstrap(
  values: readonly { cluster: string; value: number }[],
  opts: BootstrapOptions = {},
): BootstrapResult | null {
  if (values.length === 0) return null;
  const seed = opts.seed ?? BOOTSTRAP_SEED;
  const B = opts.B ?? BOOTSTRAP_B;
  const level = opts.level ?? CI_LEVEL;
  const byCluster = new Map<string, number[]>();
  for (const { cluster, value } of values) {
    const list = byCluster.get(cluster);
    if (list) list.push(value);
    else byCluster.set(cluster, [value]);
  }
  const clusters = [...byCluster.keys()].sort().map((k) => byCluster.get(k) as number[]);
  const k = clusters.length;
  const rand = mulberry32(seed);
  const meds = new Float64Array(B);
  const p90s = new Float64Array(B);
  const means = new Float64Array(B);
  for (let b = 0; b < B; b++) {
    const pool: number[] = [];
    for (let i = 0; i < k; i++) {
      const c = clusters[Math.floor(rand() * k)] as number[];
      for (const x of c) pool.push(x);
    }
    const s = Float64Array.from(pool).sort();
    meds[b] = quantileSorted(s, 0.5) as number;
    p90s[b] = quantileSorted(s, 0.9) as number;
    let sum = 0;
    for (const x of s) sum += x;
    means[b] = sum / s.length;
  }
  const alpha = (1 - level) / 2;
  const interval = (xs: Float64Array): Interval => {
    xs.sort();
    return { lo: quantileSorted(xs, alpha) as number, hi: quantileSorted(xs, 1 - alpha) as number };
  };
  return { median: interval(meds), p90: interval(p90s), mean: interval(means) };
}

/** Average ranks (1-based), ties share the mean of their positions. */
export function ranks(xs: readonly number[]): number[] {
  const idx = xs.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x || a.i - b.i);
  const out = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && (idx[j + 1] as { x: number }).x === (idx[i] as { x: number }).x) j++;
    const r = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) out[(idx[k] as { i: number }).i] = r;
    i = j + 1;
  }
  return out;
}

/** Standard normal CDF via erfc (W. J. Cody's rational approximation through Numerical Recipes erfcc). */
export function normalCdf(z: number): number {
  return 0.5 * erfc(-z / Math.SQRT2);
}

function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}

export interface MannWhitney {
  /** U of the first sample: the number of (a, b) pairs with a > b, ties counting one half. */
  u: number;
  n1: number;
  n2: number;
  z: number;
  /** Two-sided. */
  p: number;
}

/** Mann-Whitney U, two-sided, normal approximation with tie and continuity correction. Null if a side is empty. */
export function mannWhitneyU(a: readonly number[], b: readonly number[]): MannWhitney | null {
  const n1 = a.length;
  const n2 = b.length;
  if (n1 === 0 || n2 === 0) return null;
  const all = [...a, ...b];
  const r = ranks(all);
  let r1 = 0;
  for (let i = 0; i < n1; i++) r1 += r[i] as number;
  const u = r1 - (n1 * (n1 + 1)) / 2;
  const n = n1 + n2;
  const counts = new Map<number, number>();
  for (const x of all) counts.set(x, (counts.get(x) ?? 0) + 1);
  let tie = 0;
  for (const t of counts.values()) tie += t * t * t - t;
  const mu = (n1 * n2) / 2;
  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tie / (n * (n - 1))));
  if (sigma === 0) return { u, n1, n2, z: 0, p: 1 };
  const d = u - mu;
  const z = (Math.sign(d) * Math.max(0, Math.abs(d) - 0.5)) / sigma;
  const p = Math.min(1, 2 * normalCdf(-Math.abs(z)));
  return { u, n1, n2, z, p };
}

/** Round to `digits` decimals for serialisation; -0 becomes 0. */
export function round(x: number, digits = 6): number {
  const f = 10 ** digits;
  const v = Math.round(x * f) / f;
  return v === 0 ? 0 : v;
}
