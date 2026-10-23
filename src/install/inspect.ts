// What `ghx doctor` reports about an install: per scope, whether a ghx hook is registered and the
// paths its command runs still exist, which deny rules are present, and whether the CLAUDE.md block
// is there. Read-only and informational: a missing install is a fact, not a failure.
// Deny rules are expected only at project scope (04 "enforcement scope"): user scope reports the ones
// present and which of them an earlier ghx install added, which a user-scope re-install removes.
import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { isGhxError } from '../core/errors.ts';
import type { Git } from '../git/index.ts';
import { scanShell } from '../hook/shell.ts';
import { findBlock } from './claude-md.ts';
import { readOrNull, resolveTargets, type Scope, type Targets } from './files.ts';
import { ownedSettings, readManifest } from './owned.ts';
import { inspectSettings, parseSettings } from './settings.ts';
import { toPlain } from './text.ts';

type Env = Readonly<Record<string, string | undefined>>;

const SettingsInstall = z.object({
  settings: z.string(),
  status: z.enum(['missing', 'invalid', 'ok']).describe('Of the settings file'),
  problem: z.string().optional().describe('Why the settings file is invalid (status invalid only)'),
  hook: z.object({
    installed: z.boolean(),
    command: z.string().nullable(),
    missingPaths: z.array(z.string()).describe('Programs or files the hook command names that do not exist'),
  }),
  deny: z.discriminatedUnion('expected', [
    z.object({
      expected: z.literal(true).describe('Project scope: ghx install adds the gh write deny rules'),
      present: z.array(z.string()),
      missing: z.array(z.string()),
    }),
    z.object({
      expected: z.literal(false).describe('User scope: ghx install adds no deny rules'),
      present: z.array(z.string()).describe('ghx-shaped deny rules in the file anyway'),
      ghxAdded: z
        .array(z.string())
        .describe('Of those, the ones an earlier ghx install added; a user-scope re-install removes them'),
    }),
  ]),
  hookMode: z.string().nullable(),
});
type SettingsInstall = z.input<typeof SettingsInstall>;

export const ScopeInstall = SettingsInstall.extend({
  claudeMd: z.object({
    path: z.string(),
    block: z.boolean(),
    problem: z.string().optional().describe('Why the ghx marker lines are broken, when they are'),
  }),
  shared: SettingsInstall.nullable()
    .optional()
    .describe('Project scope: .claude/settings.json, which ghx never writes, read in case of a hand install'),
});
export type ScopeInstall = z.input<typeof ScopeInstall>;

export const InstallReport = z
  .object({ user: ScopeInstall.nullable(), project: ScopeInstall.nullable() })
  .describe('ghx install state per scope (informational; null when the scope has no location)');

function onPath(cmd: string, env: Env): boolean {
  return (env.PATH ?? '').split(delimiter).some((d) => {
    if (!d) return false;
    try {
      accessSync(join(d, cmd), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** The words of a hook command that name programs or files, which no longer resolve. */
function missingPaths(command: string, env: Env): string[] {
  const argv = scanShell(command).invocations[0]?.argv ?? [];
  const out: string[] = [];
  argv.forEach((w, i) => {
    if (isAbsolute(w) ? !existsSync(w) : i === 0 && !onPath(w, env)) out.push(w);
  });
  return out;
}

/** `user`: the targets whose settings this is, at user scope, where deny rules are not expected. */
function inspectSettingsFile(settingsPath: string, env: Env, user?: Targets): SettingsInstall {
  const text = readOrNull(settingsPath);
  let status: SettingsInstall['status'] = text === null ? 'missing' : 'ok';
  let found = inspectSettings({});
  let problem: string | undefined;
  let ghxAdded: string[] = [];
  try {
    const parsed = parseSettings(text, settingsPath);
    found = inspectSettings(parsed);
    if (user) {
      const owned = new Set(ownedSettings(user, readManifest(user), parsed).deny);
      ghxAdded = found.denyPresent.filter((r) => owned.has(r));
    }
  } catch (e) {
    status = 'invalid';
    problem = e instanceof Error ? e.message : String(e);
  }
  const command = found.hookCommands[0] ?? null;
  return {
    settings: settingsPath,
    status,
    ...(problem ? { problem } : {}),
    hook: { installed: command !== null, command, missingPaths: command ? missingPaths(command, env) : [] },
    deny: user
      ? { expected: false, present: found.denyPresent, ghxAdded }
      : { expected: true, present: found.denyPresent, missing: found.denyMissing },
    hookMode: found.hookMode,
  };
}

function inspectScope(scope: Scope, t: Targets, env: Env): ScopeInstall {
  const md = readOrNull(t.claudeMd);
  let block = false;
  let problem: string | undefined;
  try {
    block = md !== null && findBlock(toPlain(md), t.claudeMd) !== null;
  } catch (e) {
    problem = e instanceof Error ? e.message : String(e);
  }
  return {
    ...inspectSettingsFile(t.settings, env, scope === 'user' ? t : undefined),
    claudeMd: { path: t.claudeMd, block, ...(problem ? { problem } : {}) },
    ...(t.sharedSettings ? { shared: inspectSettingsFile(t.sharedSettings, env) } : {}),
  };
}

async function scopeOrNull(scope: Scope, env: Env, git: Git): Promise<ScopeInstall | null> {
  try {
    const t = await resolveTargets(scope, env, git);
    return inspectScope(scope, t, env);
  } catch (e) {
    if (isGhxError(e)) return null;
    throw e;
  }
}

export async function inspectInstall(env: Env, git: Git): Promise<z.input<typeof InstallReport>> {
  return { user: await scopeOrNull('user', env, git), project: await scopeOrNull('project', env, git) };
}
