// The four dedupe rules of findings §1.2. Each takes records in file order and never looks at timestamps
// except where the rule itself is "earliest" (notifications), and then only to pick among exact copies.
import type { ParsedNotification } from './notifications.ts';
import type { AssistantRecord, Block, Usage } from './records.ts';

/** One API response: every transcript record that shares its `message.id`. */
export interface AssistantGroup {
  messageId: string;
  /** Record indexes (file order) of the first and last record of the response. */
  first: number;
  last: number;
  nRecords: number;
  model: string | null;
  /** The last record's usage: each record repeats it, and the last is the most complete. */
  usage: Usage | null;
  /** The last non-null stop_reason. */
  stopReason: string | null;
  /** Every content block in file order; a tool_use repeated across records is kept once. */
  blocks: Block[];
  firstTs: string | null;
  lastTs: string | null;
  /** The first record, for per-call metadata (requestId, effort, version, cwd). */
  head: AssistantRecord;
}

export const SYNTHETIC_MODEL = '<synthetic>';

/**
 * Rule 1: one record per content block, the same message.id and requestId, usage repeated on each.
 * Group by message.id and take the last record's usage; summing records overcounts tokens 1.7–1.9×.
 * `<synthetic>` records are API errors, not calls: excluded and counted.
 */
export function groupAssistantRecords(items: readonly { index: number; record: AssistantRecord }[]): {
  calls: AssistantGroup[];
  synthetic: number;
} {
  const calls: AssistantGroup[] = [];
  const byId = new Map<string, AssistantGroup>();
  let synthetic = 0;
  for (const { index, record } of items) {
    const m = record.message;
    if (m.model === SYNTHETIC_MODEL) {
      synthetic++;
      continue;
    }
    const id = m.id ?? record.uuid ?? `#${index}`;
    let g = byId.get(id);
    if (!g) {
      g = {
        messageId: id,
        first: index,
        last: index,
        nRecords: 0,
        model: m.model ?? null,
        usage: null,
        stopReason: null,
        blocks: [],
        firstTs: record.timestamp ?? null,
        lastTs: null,
        head: record,
      };
      byId.set(id, g);
      calls.push(g);
    }
    g.nRecords++;
    g.last = index;
    if (m.usage) g.usage = m.usage;
    if (m.stop_reason) g.stopReason = m.stop_reason;
    if (record.timestamp) g.lastTs = record.timestamp;
    if (!g.model && m.model) g.model = m.model;
    for (const b of m.content ?? []) {
      if (b.type === 'tool_use' && b.id && g.blocks.some((x) => x.type === 'tool_use' && x.id === b.id)) continue;
      g.blocks.push(b);
    }
  }
  return { calls, synthetic };
}

export interface CallHolder {
  file: string;
  /** A fork (meta.isFork) or a skill fork: its history may be a copy of its parent's. */
  fork: boolean;
  /** 0 for the main thread, else meta.spawnDepth. A fork of a fork copies from the shallower one. */
  depth: number;
  messageIds: readonly string[];
}

/**
 * Rule 2: a fork copies its parent's records (same message.id; from a subagent, the same uuids too).
 * Each message.id belongs to one file: non-fork files first, then the shallower file, then by path.
 * Returns the owning file for every message id seen.
 */
export function ownersByMessageId(holders: readonly CallHolder[]): Map<string, string> {
  const ordered = [...holders].sort(
    (a, b) => Number(a.fork) - Number(b.fork) || a.depth - b.depth || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
  );
  const owner = new Map<string, string>();
  for (const h of ordered) {
    for (const id of h.messageIds) if (!owner.has(id)) owner.set(id, h.file);
  }
  return owner;
}

export type NotificationSource = 'queue' | 'attachment' | 'user';

export interface NotificationSighting {
  notification: ParsedNotification;
  ts: string | null;
  /** Position across the session's files (files by path, records in file order). */
  order: number;
  file: string;
  source: NotificationSource;
}

/**
 * Rule 3: the same notification appears as a queue-operation, an attachment.queued_command and a user
 * record (and again in a fork's copied history). Key by task id plus the notification body, so distinct
 * Monitor events and repeat agent notifications for one task stay separate; keep the earliest copy
 * (timestamp, then position). The result is in position order.
 */
export function dedupeNotifications(sightings: readonly NotificationSighting[]): NotificationSighting[] {
  const best = new Map<string, NotificationSighting>();
  for (const s of sightings) {
    const key = `${s.notification.taskId}\u0000${s.notification.body.trimEnd()}`;
    const prev = best.get(key);
    if (!prev || earlier(s, prev)) best.set(key, s);
  }
  return [...best.values()].sort((a, b) => a.order - b.order);
}

function earlier(a: NotificationSighting, b: NotificationSighting): boolean {
  if (a.ts !== null && b.ts !== null && a.ts !== b.ts) return Date.parse(a.ts) < Date.parse(b.ts);
  if (a.ts !== null && b.ts === null) return true;
  if (a.ts === null && b.ts !== null) return false;
  return a.order < b.order;
}

/**
 * Rule 4: `ai-title`, `cost-state`, `mode` and other metadata are re-appended without timestamps.
 * Take the last one in file order.
 */
export function lastOfType<T extends { type: string }, K extends T['type']>(
  records: readonly T[],
  type: K,
): Extract<T, { type: K }> | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i] as T;
    if (r.type === type) return r as Extract<T, { type: K }>;
  }
  return undefined;
}
