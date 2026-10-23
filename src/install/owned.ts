// What `ghx install` added, so a re-install or `ghx uninstall` touches only that and never the user's
// own identical entries (04 "enforcement scope"). Install records it in a small manifest beside its
// backups in the user config dir (Targets.stateDir), never in the settings file or the repo.
// An install from before the manifest left only `<file>.bak-ghx-*` siblings: the newest one without a
// ghx hook is the file as it was before ghx, and ghx added what is there now that it lacks.
import { join } from 'node:path';
import { backupsOf, readOrNull, type Targets } from './files.ts';
import { type Added, CONTAINERS, containerOf, inspectSettings, parseSettings } from './settings.ts';

type Json = Record<string, unknown>;

export interface Owned extends Added {
  /** ghx created the file. null: unknown (a legacy install without evidence). */
  created: boolean | null;
}

export interface Manifest {
  version: 1;
  settings: ({ path: string } & Owned) | null;
  claudeMd: { path: string; created: boolean } | null;
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
  return {
    version: 1,
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
          }
        : null,
    claudeMd: isObj(m) && m.path === t.claudeMd ? { path: t.claudeMd, created: m.created === true } : null,
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
