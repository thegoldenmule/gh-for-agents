// Rate-limit budget tracking for pollers (01 §4.4). api() and graphql() always pass --include, so
// every response's x-ratelimit-* headers feed the tracker. Responses without them (job-log blobs,
// 03 §3.3) leave the budget untouched.
import type { Clock } from '../core/clock.ts';

export type RateResource = 'core' | 'graphql' | 'search' | (string & {});

export interface RateBudget {
  resource: RateResource;
  limit: number;
  remaining: number;
  used: number;
  /** Epoch ms. */
  resetAt: number;
  /** Epoch ms. */
  observedAt: number;
}

export class RateTracker {
  readonly #budgets = new Map<string, RateBudget>();

  /** Record the budget from lower-cased response headers. Returns the budget, if the headers carried one. */
  observe(headers: Record<string, string>, now: number): RateBudget | undefined {
    const remaining = headers['x-ratelimit-remaining'];
    const limit = headers['x-ratelimit-limit'];
    const reset = headers['x-ratelimit-reset'];
    if (remaining === undefined || limit === undefined || reset === undefined) return undefined;
    const b: RateBudget = {
      resource: headers['x-ratelimit-resource'] ?? 'core',
      limit: Number(limit),
      remaining: Number(remaining),
      used: Number(headers['x-ratelimit-used'] ?? Number(limit) - Number(remaining)),
      resetAt: Number(reset) * 1_000,
      observedAt: now,
    };
    if (![b.limit, b.remaining, b.used, b.resetAt].every(Number.isFinite)) return undefined;
    this.#budgets.set(b.resource, b);
    return b;
  }

  set(b: RateBudget): void {
    this.#budgets.set(b.resource, b);
  }

  get(resource: RateResource = 'core'): RateBudget | undefined {
    return this.#budgets.get(resource);
  }
}

/**
 * Interval that makes the remaining requests last until resetAt with 20% headroom; never below
 * baseMs. An exhausted budget waits until the reset.
 */
export function suggestInterval(
  baseMs: number,
  b: RateBudget | undefined,
  clock: Clock,
  retryAfterMs?: number,
): number {
  let ms = baseMs;
  if (b) {
    const untilReset = Math.max(0, b.resetAt - clock.now());
    if (b.remaining <= 0) ms = Math.max(ms, untilReset);
    else ms = Math.max(ms, untilReset / (b.remaining * 0.8));
  }
  if (retryAfterMs !== undefined) ms = Math.max(ms, retryAfterMs);
  return Math.ceil(ms);
}

/** Parse GET /rate_limit (which does not count against the limit). */
export function parseRateLimitResponse(body: unknown, now: number): Partial<Record<RateResource, RateBudget>> {
  const out: Partial<Record<RateResource, RateBudget>> = {};
  const resources = (body as { resources?: Record<string, unknown> } | null)?.resources ?? {};
  for (const [name, v] of Object.entries(resources)) {
    const r = v as { limit?: number; remaining?: number; used?: number; reset?: number };
    if (typeof r.limit !== 'number' || typeof r.remaining !== 'number' || typeof r.reset !== 'number') continue;
    out[name] = {
      resource: name,
      limit: r.limit,
      remaining: r.remaining,
      used: r.used ?? r.limit - r.remaining,
      resetAt: r.reset * 1_000,
      observedAt: now,
    };
  }
  return out;
}
