// Versioned price table (findings §2). Changing a price or a rule here changes report numbers, so bump
// PRICE_TABLE_VERSION with it; report.json carries both.
//
// One deliberate difference from the prototype (docs/research/ghx-impact/metrics/pricing.py): when
// `usage.iterations` is present, the input side is priced per `message` iteration. On calls with more than
// one message iteration (an advisor call in between), the top-level `cache_creation` 1h/5m split covers only
// the first iteration while `cache_creation_input_tokens` is the sum, so pricing the top level loses the
// later iterations' cache writes. Per-iteration sums match the top-level totals on every call in the
// 2026-10-29 corpus.
import type { Iteration, Usage } from './records.ts';

export const PRICE_TABLE_VERSION = '2026-10-29.1';

/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
}

/** Cache writes cost a multiple of the input price, by lifetime. */
export const CACHE_WRITE_MULTIPLIER = { '5m': 1.25, '1h': 2 } as const;

export const PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
};

/** `claude-opus-5-5[1m]` and `claude-haiku-4-5-20251001` price as their base model. */
export function priceKey(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
}

export function priceOf(model: string | null | undefined): ModelPrice | undefined {
  return model ? PRICES[priceKey(model)] : undefined;
}

/** The input side of one usage block (top-level or one iteration). */
export interface InputTokens {
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

const n = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Split one usage block's input. Without a `cache_creation` breakdown every write is 5m (the prototype's
 * rule); a breakdown that sums short of `cache_creation_input_tokens` puts the rest in 5m.
 */
export function inputTokensOf(u: Usage | Iteration): InputTokens {
  const total = n(u.cache_creation_input_tokens);
  const cc = u.cache_creation;
  let w1h = 0;
  let w5m = total;
  if (cc && (cc.ephemeral_1h_input_tokens != null || cc.ephemeral_5m_input_tokens != null)) {
    w1h = n(cc.ephemeral_1h_input_tokens);
    w5m = n(cc.ephemeral_5m_input_tokens);
    if (w1h + w5m < total) w5m += total - w1h - w5m;
  }
  return { input: n(u.input_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite5m: w5m, cacheWrite1h: w1h };
}

/** The executor's input side: the `message` iterations when present, else the top level. */
export function executorInput(u: Usage): InputTokens {
  const its = (u.iterations ?? []).filter((i) => i.type === 'message');
  if (its.length === 0) return inputTokensOf(u);
  const sum: InputTokens = { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  for (const it of its) {
    const t = inputTokensOf(it);
    sum.input += t.input;
    sum.cacheRead += t.cacheRead;
    sum.cacheWrite5m += t.cacheWrite5m;
    sum.cacheWrite1h += t.cacheWrite1h;
  }
  return sum;
}

export interface CallCost {
  /** Executor + advisor. */
  total: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  advisor: number;
  /** A model (executor or advisor) with no price: its share is 0 and the call is flagged. */
  unpriced: boolean;
}

export function inputCost(p: ModelPrice, t: InputTokens): { input: number; cacheRead: number; cacheWrite: number } {
  return {
    input: (t.input * p.input) / 1e6,
    cacheRead: (t.cacheRead * p.cacheRead) / 1e6,
    cacheWrite:
      (t.cacheWrite5m * p.input * CACHE_WRITE_MULTIPLIER['5m'] +
        t.cacheWrite1h * p.input * CACHE_WRITE_MULTIPLIER['1h']) /
      1e6,
  };
}

/** One advisor iteration, priced at its own model. */
export function advisorCost(it: Iteration): number | undefined {
  const p = priceOf(it.model);
  if (!p) return undefined;
  const c = inputCost(p, inputTokensOf(it));
  return c.input + c.cacheRead + c.cacheWrite + (n(it.output_tokens) * p.output) / 1e6;
}

/**
 * Cost of one API call. `outputTokens` is the call's output after subagent recovery (usage.ts), which may
 * differ from `usage.output_tokens`.
 */
export function callCost(model: string | null, usage: Usage, outputTokens: number): CallCost {
  const p = priceOf(model);
  let unpriced = !p;
  const ic = p ? inputCost(p, executorInput(usage)) : { input: 0, cacheRead: 0, cacheWrite: 0 };
  const output = p ? (outputTokens * p.output) / 1e6 : 0;
  let advisor = 0;
  for (const it of usage.iterations ?? []) {
    if (it.type !== 'advisor_message') continue;
    const c = advisorCost(it);
    if (c === undefined) unpriced = true;
    else advisor += c;
  }
  return {
    total: ic.input + ic.cacheRead + ic.cacheWrite + output + advisor,
    input: ic.input,
    cacheRead: ic.cacheRead,
    cacheWrite: ic.cacheWrite,
    output,
    advisor,
    unpriced,
  };
}

/** The table and rules as report.json records them. */
export function priceTable(): {
  version: string;
  cacheWriteMultiplier: typeof CACHE_WRITE_MULTIPLIER;
  usdPerMTok: Record<string, ModelPrice>;
} {
  const usdPerMTok: Record<string, ModelPrice> = {};
  for (const k of Object.keys(PRICES).sort()) usdPerMTok[k] = PRICES[k] as ModelPrice;
  return { version: PRICE_TABLE_VERSION, cacheWriteMultiplier: CACHE_WRITE_MULTIPLIER, usdPerMTok };
}
