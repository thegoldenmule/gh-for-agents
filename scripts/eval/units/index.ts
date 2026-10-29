// buildUnits: every unit of plan 07 "Units" for a set of tables, sorted stably by (session_id, agent_id,
// start position, unit_id). Episodes and waits are atoms; PR cycles and lifecycles roll them up; one session
// unit per session with GitHub work carries GitHub's share.
import { CONSTANTS } from '../metrics/catalog.ts';
import type { EraConfig, Tables } from '../model/session.ts';
import { type Draft, finalize } from './draft.ts';
import { episodeDraft, type RawEpisode, segmentFile } from './episode.ts';
import { assignPrs, buildCycles, buildLifecycles } from './pr.ts';
import { sessionDrafts } from './session.ts';
import { indexTables } from './tables.ts';
import type { Unit } from './types.ts';
import { derivedWait, waitDraft } from './wait.ts';

export type { Context, MetricDef, Unit, UnitKind } from './types.ts';

export interface BuildUnitsOptions {
  /** Override CONSTANTS.EPISODE_SLACK (0, the prototype's segmentation). */
  slack?: number;
  /** Override CONSTANTS.EPISODE_GAP_MS. */
  gapMs?: number;
  /** Era config, as passed to buildTables. */
  era?: EraConfig;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function compareUnits(a: Unit, b: Unit): number {
  return (
    cmp(a.session_id, b.session_id) ||
    (a.agent_id === b.agent_id
      ? 0
      : a.agent_id === null
        ? -1
        : b.agent_id === null
          ? 1
          : cmp(a.agent_id, b.agent_id)) ||
    a.start_pos - b.start_pos ||
    cmp(a.unit_id, b.unit_id)
  );
}

/** Raw segmentation of every file (episodes.py segment()), for diagnostics and the prototype comparison. */
export function segmentTables(
  tables: Tables,
  opts: BuildUnitsOptions = {},
): { file: string; session_id: string; agent_id: string | null; episodes: RawEpisode[] }[] {
  const idx = indexTables(tables);
  const seg = { slack: opts.slack ?? CONSTANTS.EPISODE_SLACK, gapMs: opts.gapMs ?? CONSTANTS.EPISODE_GAP_MS };
  return idx.fileOrder.map((file) => {
    const f = idx.files.get(file);
    return {
      file,
      session_id: f?.session_id ?? '',
      agent_id: f?.agent_id ?? null,
      episodes: f ? segmentFile(f, seg) : [],
    };
  });
}

export function buildUnits(tables: Tables, opts: BuildUnitsOptions = {}): Unit[] {
  const idx = indexTables(tables);
  const seg = { slack: opts.slack ?? CONSTANTS.EPISODE_SLACK, gapMs: opts.gapMs ?? CONSTANTS.EPISODE_GAP_MS };
  const atoms: Draft[] = [];
  for (const file of idx.fileOrder) {
    const f = idx.files.get(file);
    if (!f) continue;
    for (const ep of segmentFile(f, seg))
      atoms.push(ep.kind === 'wait_bg' ? waitDraft(idx, f, ep) : episodeDraft(idx, f, ep));
  }
  assignPrs(idx, atoms);
  const derived = atoms.flatMap((d) => (d.kind === 'episode' ? [derivedWait(d)].filter((x) => x !== null) : []));
  const all = [...atoms, ...derived];
  const cycles = buildCycles(idx, atoms);
  const lifecycles = buildLifecycles(idx, atoms);
  const sessions = sessionDrafts(idx, atoms);
  const fin = { ...(opts.era ? { era: opts.era } : {}) };
  const units = [...all, ...cycles, ...lifecycles].map((d) => finalize(idx, d, fin));
  for (const d of sessions) {
    const s = idx.sessions.get(d.session_id);
    units.push(
      finalize(idx, d, {
        ...fin,
        session: {
          api_calls: s?.n_api_calls ?? 0,
          round_trips: s?.n_api_calls ?? 0,
          tool_calls: s?.n_tool_calls ?? 0,
          cost: s?.cost_usd ?? 0,
          human_turns: s?.n_human_turns ?? 0,
        },
      }),
    );
  }
  return units.sort(compareUnits);
}
