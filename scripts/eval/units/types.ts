// The unit contract (plan 07 "Units"): what scripts/eval/units/ produces and scripts/eval/report/ consumes.
// Every unit is a set of tool calls in one session, with a stable id derived from its content and a flat
// record of metric values keyed by MetricDef.id (scripts/eval/metrics/catalog.ts).
import type { Bucket } from '../model/session.ts';

export type UnitKind = 'episode' | 'wait' | 'pr_cycle' | 'pr_lifecycle' | 'session';

/** Main thread or subagent. Never pooled in a comparison (cache lifetimes differ: 1h vs 5m). */
export type Context = 'main' | 'subagent';

export type UnitBucket = Bucket;

export interface Unit {
  /** Stable, derived from content (kind + first tool_use_id, or kind + session + PR + head SHA). */
  unit_id: string;
  kind: UnitKind;
  session_id: string;
  /** null = main thread. Lifecycles and session units span agents and carry null. */
  agent_id: string | null;
  context: Context;
  project: string;
  /** Dominant model of the unit's API calls (most calls; ties by name). '' when the unit has none. */
  model: string;
  bucket: UnitBucket;
  /**
   * Episodes: the intent (classify/intent.ts). Waits: the mechanism (bg-ghx-ci-wait, bg-gh-loop, monitor,
   * fg-sleep-loop). PR cycles and lifecycles: 'pr'. Session units: 'session'.
   */
  category: string;
  /**
   * Episodes and waits: the highest-priority non-meta intent of their GitHub calls ('meta' when only meta).
   * A per-intent table takes kind 'episode' plus kind 'wait' without the 'derived' flag. Null otherwise.
   */
  intent: string | null;
  /** owner/repo#n when known, else #n when only the number is known. */
  pr: string | null;
  start_ts: string;
  end_ts: string;
  /** In file order (files in path order). */
  tool_use_ids: string[];
  /** e.g. 'multi-pr', 'sha-fallback', 'charged-to-last-pr', 'continuation', 'open' (no close seen). */
  flags: string[];
  /** Keyed by MetricDef.id; null when the metric does not apply or cannot be measured for this unit. */
  metrics: Record<string, number | null>;
  /** Unit ids this unit is built from (cycles and lifecycles → episodes and waits). Empty for atoms. */
  children: string[];
  /** Ordinal of the unit's first tool call: files in path order, then file order. Used for stable sorting. */
  start_pos: number;
}

export interface MetricDef {
  id: string;
  /** What one value counts: 'calls', 'tokens', 'usd', 'seconds', 'ratio', ... */
  unit: string;
  description: string;
  formula: string;
  robustness: 'robust' | 'proxy';
  applies_to: UnitKind[];
}
