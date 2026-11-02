// What `ghx doctor` reports about an install: per scope, whether a ghx hook is registered and the
// paths its command runs still exist, which deny rules are present, and whether the CLAUDE.md block
// is there. Read-only and informational: a missing install is a fact, not a failure.
// Deny rules are expected only at project scope (04 "enforcement scope"): user scope reports the ones
// present and which of them an earlier ghx install added, which a user-scope re-install removes.
import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { isGhxError } from '../core/errors.ts';
import type { Git } from '../git/index.ts';
import { scanShell } from '../hook/shell.ts';
import { RUNTIME, type Runtime } from '../util/runtime.ts';
import { VERSION } from '../version.ts';
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
    node: z
      .string()
      .nullable()
      .describe('The node the hook command runs, when it is an absolute path (an npm or checkout install)'),
    binary: z
      .string()
      .nullable()
      .describe('The standalone ghx executable the hook command runs, when it runs one by absolute path'),
    version: z
      .string()
      .nullable()
      .describe(
        "The ghx version the hook runs: the package.json beside its bin/ghx.js, or the binary's ghx version (null when unknown)",
      ),
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

export function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

/** What inspecting an install needs beyond the files: this ghx, and a way to ask another binary its version. */
export interface InspectDeps {
  runtime?: Runtime;
  /** `<exe> version`'s ghx version, or null (doctor runs it through ctx.proc, bounded). */
  versionOf?: (exe: string) => Promise<string | null>;
}

interface HookTarget {
  node: string | null;
  binary: string | null;
  version: string | null;
}

/**
 * What a hook command runs. Two shapes: `'<node>' '<dir>/bin/ghx.js' hook claude-pretooluse` (npm or a
 * checkout: version from <dir>/package.json) and `'<ghx>' hook claude-pretooluse` (the standalone binary:
 * this ghx's version when it is this executable, else whatever `<ghx> version` says).
 */
async function hookTarget(command: string | null, deps: InspectDeps): Promise<HookTarget> {
  const argv = command ? (scanShell(command).invocations[0]?.argv ?? []) : [];
  const [first, second] = argv;
  if (first && second === 'hook') {
    if (!isAbsolute(first)) return { node: null, binary: null, version: null };
    const rt = deps.runtime ?? RUNTIME;
    let version: string | null = null;
    if (rt.compiled && samePath(first, rt.execPath)) version = VERSION;
    else if (existsSync(first) && deps.versionOf) version = await deps.versionOf(first);
    return { node: null, binary: first, version };
  }
  const [node, bin] = [first, second];
  let version: string | null = null;
  if (bin && isAbsolute(bin)) {
    try {
      const pkg: unknown = JSON.parse(readOrNull(join(dirname(dirname(bin)), 'package.json')) ?? 'null');
      const v = typeof pkg === 'object' && pkg !== null ? (pkg as { version?: unknown }).version : undefined;
      if (typeof v === 'string') version = v;
    } catch {
      // unreadable: no version to compare
    }
  }
  return { node: node && isAbsolute(node) ? node : null, binary: null, version };
}

type Warning = { code: string; message: string };

/**
 * Doctor's warnings about a hook that still runs (no missing paths) but runs another ghx than this one:
 * another version, another node (npm hook, npm ghx), or another kind of install (an npm hook seen from
 * the standalone binary, or the reverse).
 */
export function hookWarnings(
  scope: Scope,
  hook: SettingsInstall['hook'],
  rt: Runtime = RUNTIME,
  version: string = VERSION,
): Warning[] {
  if (!hook.installed || (hook.missingPaths ?? []).length > 0) return [];
  const flag = scope === 'project' ? ' --scope project' : '';
  const out: Warning[] = [];
  const hookVersion = hook.version ?? null;
  if (hookVersion !== null && hookVersion !== version) {
    out.push({
      code: 'INSTALL_HOOK_VERSION_MISMATCH',
      message: `The ${scope} ghx hook runs ghx ${hookVersion}, but this is ghx ${version}. Re-run ghx install${flag} with this ghx so the hook runs it.`,
    });
  }
  const node = hook.node ?? null;
  const binary = hook.binary ?? null;
  if ((rt.compiled && node !== null) || (!rt.compiled && binary !== null)) {
    const runs = binary !== null ? `the standalone ghx binary ${binary}` : `ghx on Node.js (${node})`;
    const self = rt.compiled ? `the standalone binary ${rt.execPath}` : `ghx on Node.js (${rt.execPath})`;
    out.push({
      code: 'INSTALL_HOOK_OTHER_INSTALL',
      message: `The ${scope} ghx hook runs ${runs}, a different ghx install than this one (${self}). Re-run ghx install${flag} with the ghx you want the hook to run, and remove the other one if you no longer use it.`,
    });
  } else if (!rt.compiled && node !== null && !samePath(node, rt.execPath)) {
    out.push({
      code: 'INSTALL_HOOK_NODE_MISMATCH',
      message: `The ${scope} ghx hook runs ${node}, but this ghx runs on ${rt.execPath}. Re-run ghx install${flag} so the hook uses this node.`,
    });
  }
  return out;
}

/** `user`: the targets whose settings this is, at user scope, where deny rules are not expected. */
async function inspectSettingsFile(
  settingsPath: string,
  env: Env,
  deps: InspectDeps,
  user?: Targets,
): Promise<SettingsInstall> {
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
    hook: {
      installed: command !== null,
      command,
      missingPaths: command ? missingPaths(command, env) : [],
      ...(await hookTarget(command, deps)),
    },
    deny: user
      ? { expected: false, present: found.denyPresent, ghxAdded }
      : { expected: true, present: found.denyPresent, missing: found.denyMissing },
    hookMode: found.hookMode,
  };
}

async function inspectScope(scope: Scope, t: Targets, env: Env, deps: InspectDeps): Promise<ScopeInstall> {
  const md = readOrNull(t.claudeMd);
  let block = false;
  let problem: string | undefined;
  try {
    block = md !== null && findBlock(toPlain(md), t.claudeMd) !== null;
  } catch (e) {
    problem = e instanceof Error ? e.message : String(e);
  }
  return {
    ...(await inspectSettingsFile(t.settings, env, deps, scope === 'user' ? t : undefined)),
    claudeMd: { path: t.claudeMd, block, ...(problem ? { problem } : {}) },
    ...(t.sharedSettings ? { shared: await inspectSettingsFile(t.sharedSettings, env, deps) } : {}),
  };
}

async function scopeOrNull(scope: Scope, env: Env, git: Git, deps: InspectDeps): Promise<ScopeInstall | null> {
  try {
    const t = await resolveTargets(scope, env, git);
    return await inspectScope(scope, t, env, deps);
  } catch (e) {
    if (isGhxError(e)) return null;
    throw e;
  }
}

export async function inspectInstall(
  env: Env,
  git: Git,
  deps: InspectDeps = {},
): Promise<z.input<typeof InstallReport>> {
  return {
    user: await scopeOrNull('user', env, git, deps),
    project: await scopeOrNull('project', env, git, deps),
  };
}
