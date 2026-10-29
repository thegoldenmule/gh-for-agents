// Wait units (findings §3, §4.3). A background wait is keyed by its task id: the launch, its glue (output-file
// reads, TaskOutput, TaskStop) and the API calls its notifications woke. A foreground wait (a contiguous
// episode whose GitHub calls poll with sleep, a loop or --watch) becomes a wait unit too, flagged 'derived'
// with the episode as its child, so waits can be compared by mechanism without double-counting episodes.
import { isGitHubCall } from '../metrics/catalog.ts';
import type { ToolCallRow } from '../model/session.ts';
import { byPos, type Draft, spanOf, tsRange } from './draft.ts';
import { episodeIntent, type RawEpisode } from './episode.ts';
import type { FileIndex, TableIndex } from './tables.ts';

/** Mechanism of a background wait: bg-ghx-ci-wait, bg-ghx, bg-gh-loop or monitor. */
export function backgroundMechanism(launch: ToolCallRow): string {
  if (launch.name === 'Monitor') return 'monitor';
  if (launch.cli === 'ghx') return launch.subcommand === 'ghx ci wait' ? 'bg-ghx-ci-wait' : 'bg-ghx';
  return 'bg-gh-loop';
}

/** Mechanism of a foreground wait episode, or null when it does not wait: fg-watch, fg-sleep-loop, fg-ghx, fg-gh. */
export function foregroundMechanism(gh: readonly ToolCallRow[]): string | null {
  const waiting = gh.filter((t) => t.intents.includes('wait'));
  if (waiting.length === 0) return null;
  if (gh.some((t) => t.glue?.watch === true)) return 'fg-watch';
  if (gh.some((t) => t.glue?.sleep === true || t.glue?.loop === true)) return 'fg-sleep-loop';
  return waiting.every((t) => t.cli === 'ghx') ? 'fg-ghx' : 'fg-gh';
}

export function waitDraft(idx: TableIndex, f: FileIndex, ep: RawEpisode): Draft {
  const launch = ep.gh[0] as ToolCallRow;
  const calls = [...ep.gh, ...ep.glue].sort(byPos(idx));
  const { span, wake } = spanOf(idx, calls, false);
  const flags = new Set<string>([`closed:${ep.closed_by.split(':')[0] ?? ''}`]);
  if (ep.closed_by === 'censored') flags.add('open');
  if (ep.compact_inside) flags.add('compact-inside');
  const { start } = tsRange([launch.call_ts]);
  const { end } = tsRange([ep.end_ts, launch.notif_ts, ...ep.glue.map((t) => t.result_ts ?? t.call_ts)]);
  return {
    kind: 'wait',
    unit_id: `wait:${launch.tool_use_id}`,
    session_id: f.session_id,
    agent_id: f.agent_id,
    context: f.agent_id === null ? 'main' : 'subagent',
    category: backgroundMechanism(launch),
    intent: episodeIntent(ep.gh),
    pr: null,
    flags,
    calls,
    span,
    wake,
    start_ts: start,
    end_ts: end,
    children: [],
  };
}

/** The wait view of a foreground polling episode, or null. Shares the episode's rows; flagged 'derived'. */
export function derivedWait(episode: Draft): Draft | null {
  const gh = episode.calls.filter(isGitHubCall);
  const mech = foregroundMechanism(gh);
  if (mech === null) return null;
  const first = gh[0] as ToolCallRow;
  return {
    ...episode,
    kind: 'wait',
    unit_id: `wait:${first.tool_use_id}`,
    category: mech,
    flags: new Set([...episode.flags, 'derived']),
    children: [episode.unit_id],
  };
}
