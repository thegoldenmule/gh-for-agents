// buildUnits: every unit of plan 07 "Units" for a set of tables, sorted stably by (session_id, agent_id,
// start position, unit_id). Episodes and waits are atoms; PR cycles and lifecycles roll them up; one session
// unit per session carries GitHub's share.
import type { Tables } from '../model/session.ts';
import type { Unit } from './types.ts';

export type { Context, MetricDef, Unit, UnitKind } from './types.ts';

export interface BuildUnitsOptions {
  /** Override CONSTANTS.EPISODE_SLACK (0 reproduces the prototype's segmentation). */
  slack?: number;
  /** Override CONSTANTS.EPISODE_GAP_MS. */
  gapMs?: number;
}

export function buildUnits(_tables: Tables, _opts: BuildUnitsOptions = {}): Unit[] {
  return [];
}
