// What `ghx doctor` reports about an install: per scope, whether a ghx hook is registered and the
// paths its command runs still exist, which deny rules are present, and whether the CLAUDE.md block
// is there. Read-only and informational: a missing install is a fact, not a failure.
import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { isGhxError } from '../core/errors.ts';
import type { Git } from '../git/index.ts';
import { scanShell } from '../hook/shell.ts';
import { findBlock } from './claude-md.ts';
import { readOrNull, resolveTargets, type Scope } from './files.ts';
import { GHX_DENY_RULES, inspectSettings, parseSettings } from './settings.ts';

type Env = Readonly<Record<string, string | undefined>>;

export const ScopeInstall = z.object({
  settings: z.string(),
  status: z.enum(['missing', 'invalid', 'ok']).describe('Of settings.json'),
  hook: z.object({
    installed: z.boolean(),
    command: z.string().nullable(),
    missingPaths: z.array(z.string()).describe('Programs or files the hook command names that do not exist'),
  }),
  deny: z.object({ present: z.number(), total: z.number(), missing: z.array(z.string()) }),
  hookMode: z.string().nullable(),
  claudeMd: z.object({ path: z.string(), block: z.boolean() }),
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

function inspectScope(settingsPath: string, claudeMdPath: string, env: Env): ScopeInstall {
  const text = readOrNull(settingsPath);
  let status: ScopeInstall['status'] = text === null ? 'missing' : 'ok';
  let found = inspectSettings({});
  try {
    found = inspectSettings(parseSettings(text, settingsPath));
  } catch {
    status = 'invalid';
  }
  const command = found.hookCommands[0] ?? null;
  const md = readOrNull(claudeMdPath);
  let block = false;
  try {
    block = md !== null && findBlock(md, claudeMdPath) !== null;
  } catch {
    block = false;
  }
  return {
    settings: settingsPath,
    status,
    hook: { installed: command !== null, command, missingPaths: command ? missingPaths(command, env) : [] },
    deny: { present: found.denyPresent.length, total: GHX_DENY_RULES.length, missing: found.denyMissing },
    hookMode: found.hookMode,
    claudeMd: { path: claudeMdPath, block },
  };
}

async function scopeOrNull(scope: Scope, env: Env, git: Git): Promise<ScopeInstall | null> {
  try {
    const t = await resolveTargets(scope, env, git);
    return inspectScope(t.settings, t.claudeMd, env);
  } catch (e) {
    if (isGhxError(e)) return null;
    throw e;
  }
}

export async function inspectInstall(env: Env, git: Git): Promise<z.input<typeof InstallReport>> {
  return { user: await scopeOrNull('user', env, git), project: await scopeOrNull('project', env, git) };
}
