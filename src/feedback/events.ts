// Status as an append-only fold of `resolve` events (02 §9.4), ordered by createdAt then databaseId.
// The last *valid* event per target wins; with none, a finding is open and a precondition has no override.
// Invalid (skipped, EVENT_INVALID): an unknown status, a status for the wrong kind of target, a missing note
// on wontfix/deferred/met/withdrawn, or `addressed` without a commit. Verification is a separate axis: a
// winning `addressed` whose commit left the PR stays the statusEvent (`verified:false`) but reads as open.

import type { ResolveTargetRead } from '../meta/schemas.ts';
import type { Warning } from '../schemas/common.ts';
import {
  FindingStatus,
  type FindingStatus as FindingStatusT,
  PreconditionStatus,
  type PreconditionStatus as PreconditionStatusT,
  type StatusEvent,
} from '../schemas/pr.ts';

export interface ResolveEvent {
  /** The resolve comment's block id. */
  id: string;
  by: string;
  at: string;
  databaseId: number;
  url: string;
  targets: readonly ResolveTargetRead[];
}

export type TargetKind = 'finding' | 'precondition';

export interface FindingState {
  status: FindingStatusT;
  event: StatusEvent | null;
}
export interface PreconditionOverrideState {
  status: PreconditionStatusT;
  event: StatusEvent;
}

export interface EventFold {
  findings: Map<string, FindingState>;
  preconditions: Map<string, PreconditionOverrideState>;
  /** Commits of winning `addressed` events that the facts don't cover yet. */
  unverifiedCommits: string[];
  warnings: Warning[];
}

const NOTE_REQUIRED = new Set(['wontfix', 'deferred', 'met', 'withdrawn']);
const PRECONDITION_SETTABLE = new Set(['met', 'withdrawn', 'unmet']);

export function compareEvents(a: { at: string; databaseId: number }, b: { at: string; databaseId: number }): number {
  const t = Date.parse(a.at) - Date.parse(b.at);
  return t !== 0 ? t : a.databaseId - b.databaseId;
}

function invalidReason(t: ResolveTargetRead, kind: TargetKind): string | null {
  if (kind === 'finding' && !FindingStatus.safeParse(t.status).success) {
    return `"${t.status}" is not a finding status`;
  }
  if (kind === 'precondition' && !PRECONDITION_SETTABLE.has(t.status)) {
    return `"${t.status}" is not a precondition status (met, withdrawn or unmet)`;
  }
  if (NOTE_REQUIRED.has(t.status) && !t.note?.trim()) return `${t.status} needs a note`;
  if (t.status === 'addressed' && !t.commit) return 'addressed needs a commit';
  return null;
}

/**
 * Fold `events` over the known targets. `commits` maps a SHA to whether it is reachable from the head and
 * not from the base (null: could not tell). A SHA missing from the map is reported in `unverifiedCommits`.
 */
export function foldEvents(
  events: readonly ResolveEvent[],
  targets: ReadonlyMap<string, TargetKind>,
  commits: ReadonlyMap<string, boolean | null> = new Map(),
): EventFold {
  const warnings: Warning[] = [];
  const latest = new Map<string, { event: ResolveEvent; target: ResolveTargetRead }>();
  for (const event of [...events].sort(compareEvents)) {
    for (const target of event.targets) {
      const kind = targets.get(target.id);
      if (!kind) {
        warnings.push({ code: 'EVENT_TARGET_UNKNOWN', message: `Event ${event.id} targets unknown id ${target.id}.` });
        continue;
      }
      if (!FindingStatus.safeParse(target.status).success && !PreconditionStatus.safeParse(target.status).success) {
        continue; // already warned UNKNOWN_ENUM by the block reader
      }
      const reason = invalidReason(target, kind);
      if (reason) {
        warnings.push({ code: 'EVENT_INVALID', message: `Ignored event ${event.id} for ${target.id}: ${reason}.` });
        continue;
      }
      latest.set(target.id, { event, target });
    }
  }

  const out: EventFold = { findings: new Map(), preconditions: new Map(), unverifiedCommits: [], warnings };
  for (const [id, { event, target }] of latest) {
    const statusEvent: StatusEvent = {
      id: event.id,
      by: event.by,
      at: event.at,
      commit: target.commit ?? null,
      note: target.note ?? null,
      verified: null,
      url: event.url,
    };
    if (targets.get(id) === 'precondition') {
      out.preconditions.set(id, { status: target.status as PreconditionStatusT, event: statusEvent });
      continue;
    }
    let status = target.status as FindingStatusT;
    if (status === 'addressed' && target.commit) {
      const reachable = commits.get(target.commit);
      if (reachable === undefined) out.unverifiedCommits.push(target.commit);
      if (reachable === true) statusEvent.verified = true;
      else if (reachable === false) {
        statusEvent.verified = false;
        status = 'open';
        warnings.push({
          code: 'EVENT_COMMIT_UNREACHABLE',
          message: `${id} was marked addressed in ${target.commit.slice(0, 7)}, which is no longer in the PR (force-push?); it is open again.`,
        });
      } else {
        warnings.push({
          code: 'EVENT_COMMIT_UNVERIFIED',
          message: `Could not verify that ${target.commit.slice(0, 7)} (addressing ${id}) is in the PR.`,
        });
      }
    }
    out.findings.set(id, { status, event: statusEvent });
  }
  return out;
}
