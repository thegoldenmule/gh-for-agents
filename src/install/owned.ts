// What `ghx install` added, so a re-install or `ghx uninstall` touches only that and never the user's
// own identical entries (04 "enforcement scope"). Install records it in a small manifest beside its
// backups in the user config dir (Targets.stateDir), never in the settings file or the repo.
// An install from before the manifest left only `<file>.bak-ghx-*` siblings: the newest one without a
// ghx hook is the file as it was before ghx, and ghx added what is there now that it lacks.
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { backupsOf, readOrNull, type Targets } from './files.ts';
import { type Added, CONTAINERS, containerOf, inspectSettings, parseSettings } from './settings.ts';

type Json = Record<string, unknown>;

export interface Owned extends Added {
  /** ghx created the file. null: unknown (a legacy install without evidence). */
  created: boolean | null;
}

/**
 * A byte-for-byte restore point: the sha256 of the file before ghx first changed it (null: it did not
 * exist) and of what ghx last wrote. While the file still hashes to `written`, nobody else has touched
 * it, so uninstall puts the original bytes back (found among the backups by hash) instead of editing.
 */
export interface Restore {
  original: string | null;
  written: string;
}

export interface Manifest {
  version: 1;
  settings: ({ path: string; restore: Restore | null } & Owned) | null;
  claudeMd: { path: string; created: boolean; restore: Restore | null } | null;
  /** The `<dir>/ghx` link a --bin-dir install made, so uninstall removes it without the flag. */
  binLink?: BinLinkRecord | null;
}

export interface BinLinkRecord {
  path: string;
  target: string;
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * The restore point after an install run. With an earlier record, it carries on only while the file is
 * still what ghx wrote; without one, it starts here, but only from a file with nothing of ghx's in it.
 */
export function nextRestore(
  prior: { restore: Restore | null } | null,
  before: string | null,
  after: string | null,
  ghxFree: boolean,
): Restore | null {
  if (after === null) return null;
  if (prior) {
    const r = prior.restore;
    return r && before !== null && sha256(before) === r.written
      ? { original: r.original, written: sha256(after) }
      : null;
  }
  return ghxFree ? { original: before === null ? null : sha256(before), written: sha256(after) } : null;
}

/**
 * The file's original content if the restore point still holds: `{content: null}` means delete it.
 * Undefined when it doesn't hold (edited since, or the backup is gone), so uninstall edits instead.
 */
export function restored(
  r: Restore | null | undefined,
  current: string | null,
  backupDir: string,
): { content: string | null } | undefined {
  if (!r || current === null || sha256(current) !== r.written) return undefined;
  if (r.original === null) return { content: null };
  if (r.original === r.written) return { content: current };
  let names: string[] = [];
  try {
    names = readdirSync(backupDir).sort().reverse();
  } catch {
    return undefined;
  }
  for (const f of names) {
    const text = readOrNull(join(backupDir, f));
    if (text !== null && sha256(text) === r.original) return { content: text };
  }
  return undefined;
}

export const NOTHING: Owned = { deny: [], containers: [], hookMode: null, created: null };

export function manifestPath(t: Targets): string {
  return join(t.stateDir, 'manifest.json');
}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/** The manifest for these targets, or null when there is none (or it is unreadable, or for other paths). */
export function readManifest(t: Targets): Manifest | null {
  let v: unknown;
  try {
    v = JSON.parse(readOrNull(manifestPath(t)) ?? 'null');
  } catch {
    return null;
  }
  if (!isObj(v) || v.version !== 1) return null;
  const s = v.settings;
  const m = v.claudeMd;
  const mode = isObj(s) && isObj(s.hookMode) ? s.hookMode : null;
  const restore = (v: unknown): Restore | null =>
    isObj(v) && typeof v.written === 'string' && (typeof v.original === 'string' || v.original === null)
      ? { original: v.original, written: v.written }
      : null;
  const link = v.binLink;
  return {
    version: 1,
    binLink:
      isObj(link) && typeof link.path === 'string' && typeof link.target === 'string'
        ? { path: link.path, target: link.target }
        : null,
    settings:
      isObj(s) && s.path === t.settings
        ? {
            path: t.settings,
            deny: strings(s.deny),
            containers: strings(s.containers),
            hookMode:
              mode && typeof mode.set === 'string'
                ? { set: mode.set, prev: typeof mode.prev === 'string' ? mode.prev : null }
                : null,
            created: typeof s.created === 'boolean' ? s.created : null,
            restore: restore(s.restore),
          }
        : null,
    claudeMd:
      isObj(m) && m.path === t.claudeMd
        ? { path: t.claudeMd, created: m.created === true, restore: restore(m.restore) }
        : null,
  };
}

export function serializeManifest(m: Manifest): string {
  return `${JSON.stringify(m, null, 2)}\n`;
}

/** The settings as they were before ghx, from a legacy sibling backup; undefined when none qualifies. */
function legacyBefore(path: string): Json | undefined {
  for (const b of backupsOf(path).sort().reverse()) {
    try {
      const s = parseSettings(readOrNull(b), b);
      if (inspectSettings(s).hookCommands.length === 0) return s;
    } catch {
      // an unparseable backup is no evidence
    }
  }
  return undefined;
}

const modeOf = (s: Json): string | null =>
  isObj(s.env) && typeof s.env.GHX_HOOK_MODE === 'string' ? s.env.GHX_HOOK_MODE : null;

/**
 * What a legacy install added, judged from its backups. Nothing is claimed without a ghx hook. With no
 * pre-ghx copy and no backups at all, ghx created the file (it backs up any file it changes), so it owns
 * everything ghx-shaped; with backups but no pre-ghx one, it claims the ghx deny rules and mode only.
 */
export function legacyOwned(path: string, current: Json): Owned {
  const now = inspectSettings(current);
  if (now.hookCommands.length === 0) return NOTHING;
  const mode = modeOf(current);
  const before = legacyBefore(path);
  if (before === undefined) {
    const created = backupsOf(path).length === 0;
    return {
      deny: now.denyPresent,
      containers: created ? CONTAINERS.filter((c) => containerOf(current, c) !== undefined) : [],
      hookMode: mode === null ? null : { set: mode, prev: null },
      created: created ? true : null,
    };
  }
  const had = new Set(inspectSettings(before).denyPresent);
  const was = modeOf(before);
  return {
    deny: now.denyPresent.filter((r) => !had.has(r)),
    containers: CONTAINERS.filter((c) => containerOf(before, c) === undefined && containerOf(current, c) !== undefined),
    hookMode: mode !== null && mode !== was ? { set: mode, prev: was } : null,
    created: false,
  };
}

/** What ghx owns in the settings file: the manifest's record, else the legacy evidence. */
export function ownedSettings(t: Targets, m: Manifest | null, current: Json): Owned {
  return m?.settings ?? legacyOwned(t.settings, current);
}
