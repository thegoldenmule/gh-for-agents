// What an earlier `ghx install` added to a settings file, so a re-install or uninstall touches only
// that and never the user's own identical entries (04 "enforcement scope"). For an install that left
// no record, the evidence is its `<file>.bak-ghx-*` siblings: the newest one without a ghx hook is the
// file as it was before ghx, and ghx added the deny rules present now that it lacks.
import { backupsOf, readOrNull } from './files.ts';
import { CONTAINERS, containerOf, GHX_DENY_RULES, inspectSettings, parseSettings } from './settings.ts';

type Json = Record<string, unknown>;

export interface Owned {
  /** Deny rules ghx added, exact strings. */
  deny: string[];
  /** Containers ghx created (CONTAINERS paths), which may be dropped once ghx's entries leave them empty. */
  containers: string[];
}

/** The settings as they were before ghx, from a legacy sibling backup; undefined when none qualifies. */
function legacyBefore(path: string): Json | undefined {
  const names = backupsOf(path).sort().reverse();
  for (const b of names) {
    try {
      const s = parseSettings(readOrNull(b), b);
      if (inspectSettings(s).hookCommands.length === 0) return s;
    } catch {
      // an unparseable backup is no evidence
    }
  }
  return undefined;
}

/**
 * What ghx added, judged from legacy backups. With no pre-ghx copy, a ghx hook plus no backups at all
 * means ghx created the file (it backs up any file it changes), so it owns everything ghx-shaped; with
 * backups but no pre-ghx one, it claims the deny rules only when a ghx hook is there, and no containers.
 */
export function legacyOwned(path: string, current: Json): Owned {
  const now = inspectSettings(current);
  const hooked = now.hookCommands.length > 0;
  const before = legacyBefore(path);
  if (before === undefined) {
    const created = hooked && backupsOf(path).length === 0;
    return {
      deny: hooked ? now.denyPresent : [],
      containers: created ? CONTAINERS.filter((c) => containerOf(current, c) !== undefined) : [],
    };
  }
  const had = new Set(inspectSettings(before).denyPresent);
  return {
    deny: GHX_DENY_RULES.filter((r) => now.denyPresent.includes(r) && !had.has(r)),
    containers: CONTAINERS.filter((c) => containerOf(before, c) === undefined && containerOf(current, c) !== undefined),
  };
}
