// `npx @thegoldenmule/ghx install` (04 "distribution"): the npx cache is not a place a hook can point
// at (npm prunes it, and running the hook through npx costs 0.5 s a call and fails offline). So when
// install runs from there, it installs this same version globally with npm and hands the install to
// that copy, whose hook command and bin link then point at the global install.
import { existsSync, realpathSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import type { Context } from '../core/command.ts';
import { ERROR_CODES, type ErrorCode, GhxError } from '../core/errors.ts';
import type { ProcResult } from '../proc/runner.ts';
import { PACKAGE_NAME, VERSION } from '../version.ts';
import { hookCommand } from './files.ts';
import type { InstallOutput } from './report.ts';

type Env = Readonly<Record<string, string | undefined>>;

/** Set on the handed-off install, so it never hands off again. */
export const HANDOFF_ENV = 'GHX_NPX_HANDOFF';
/** Test seam: the package spec `npm i -g` installs (pnpm pack:test passes the packed tarball). */
export const SPEC_ENV = 'GHX_TEST_GLOBAL_SPEC';

/** Whether this ghx runs from the npx cache, or under `npx`/`npm exec`, rather than from an install. */
export function runsFromNpx(root: string, env: Env): boolean {
  if (env[HANDOFF_ENV]) return false;
  return (
    `${root}${sep}`.includes(`${sep}_npx${sep}`) || env.npm_command === 'exec' || env.npm_lifecycle_event === 'npx'
  );
}

/** How to run npm: the npm that ran npx (npm_execpath) on this node when there is one, else npm on PATH. */
export function npmCommand(env: Env): { cmd: string; args: string[] } {
  const cli = env.npm_execpath;
  if (cli && /^npm-cli\.(c|m)?js$/.test(basename(cli))) return { cmd: process.execPath, args: [cli] };
  return { cmd: 'npm', args: [] };
}

export interface HandoffInput {
  scope: 'user' | 'project';
  deny?: boolean | undefined;
  hook: boolean;
  snippet: boolean;
  binDir?: string | undefined;
  hookMode?: 'ask' | 'deny' | undefined;
  global: boolean;
}

/** The install flags to hand to the global copy (absolute --bin-dir; never --dry-run or --no-global). */
export function handoffArgs(input: HandoffInput, cwd: string): string[] {
  const a = ['install', '--scope', input.scope];
  if (input.deny === true) a.push('--deny');
  if (input.deny === false) a.push('--no-deny');
  if (!input.hook) a.push('--no-hook');
  if (!input.snippet) a.push('--no-snippet');
  if (input.binDir) a.push('--bin-dir', resolve(cwd, input.binDir));
  if (input.hookMode) a.push('--hook-mode', input.hookMode);
  return a;
}

const tail = (s: string, n = 2000): string => (s.length > n ? s.slice(-n) : s);
const same = (a: string, b: string): boolean => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
};

function npmMissing(): GhxError {
  return new GhxError('ENV_NPM_MISSING', 'npm was not found, and ghx install needs it to install ghx globally.', {
    hint: `Install Node.js with npm, or install ghx yourself (npm i -g ${PACKAGE_NAME}) and run ghx install.`,
  });
}

function npmFailed(argv: string[], r: ProcResult, prefix: string | null): GhxError {
  const command = argv.join(' ');
  if (r.spawnError?.code === 'ENOENT') return npmMissing();
  const stderr = tail(r.stderr || r.stdout);
  if (/\b(EACCES|EPERM)\b/.test(stderr)) {
    return new GhxError(
      'INSTALL_NOT_WRITABLE',
      `${command} was refused: npm cannot write to ${prefix ?? 'its global prefix'}.`,
      {
        hint: `Use a Node.js you own (nvm or fnm), whose global prefix is yours, or run npm i -g ${PACKAGE_NAME} yourself and then ghx install. ghx changed nothing.`,
        details: { command, prefix, code: 'EACCES', stderr },
      },
    );
  }
  return new GhxError('INSTALL_GLOBAL_FAILED', `${command} failed (exit ${r.exitCode ?? r.signal}).`, {
    details: { command, exitCode: r.exitCode, stderr },
  });
}

/**
 * Run from npx: install this version globally and run its `install` with the same flags, returning its
 * output (plus `handoff`). Under --dry-run, only `npm prefix -g` runs and the plan is returned. Returns
 * null when "npx" is in fact the global install already, so the caller installs as usual.
 */
export async function handoff(input: HandoffInput, ctx: Context, root: string): Promise<InstallOutput | null> {
  const spec = ctx.env[SPEC_ENV] || `${PACKAGE_NAME}@${VERSION}`;
  const installArgv = ['npm', 'i', '-g', spec];
  if (!input.global) {
    throw new GhxError(
      'VALIDATION',
      `--no-global: ghx is running from the npx cache (${root}), and a hook pointing there would break when npm prunes the cache.`,
      {
        hint: `Install ghx where the hook can keep running it: run ghx install without --no-global (it runs ${installArgv.join(' ')} first), or install it yourself and run ghx install from there.`,
        details: {
          issues: [{ path: 'global', code: 'npx', message: '--no-global cannot install from the npx cache' }],
        },
      },
    );
  }
  const npm = npmCommand(ctx.env);
  const run = (args: string[], timeoutMs: number) =>
    ctx.proc({ cmd: npm.cmd, args: [...npm.args, ...args], env: ctx.env, cwd: ctx.cwd, signal: ctx.signal, timeoutMs });

  const p = await run(['prefix', '-g'], 30_000);
  if (p.exitCode !== 0) throw npmFailed(['npm', 'prefix', '-g'], p, null);
  const prefix = p.stdout.trim();
  const pkgDir = join(prefix, 'lib', 'node_modules', ...PACKAGE_NAME.split('/'));
  if (same(root, pkgDir)) return null;
  const bin = join(prefix, 'bin', 'ghx');
  const args = handoffArgs(input, ctx.cwd);
  const plan = { from: root, install: installArgv, prefix, bin, args };

  if (ctx.dryRun) {
    return {
      scope: input.scope,
      dryRun: true,
      changed: [],
      files: [],
      hookCommand: input.hook ? hookCommand(process.execPath, join(pkgDir, 'bin', 'ghx.js')) : null,
      denyRules: [],
      binLink: null,
      wouldRun: [],
      handoff: plan,
      next: [
        `Nothing was written. Without --dry-run, ghx runs ${installArgv.join(' ')}, then ${bin} ${args.join(' ')}.`,
        `To see that install's diffs: ${installArgv.join(' ')}, then ghx install --dry-run.`,
      ],
    };
  }

  const i = await run(installArgv.slice(1), 300_000);
  if (i.exitCode !== 0) throw npmFailed(installArgv, i, prefix);
  if (!existsSync(bin)) {
    throw new GhxError('INSTALL_GLOBAL_FAILED', `${installArgv.join(' ')} succeeded, but ${bin} does not exist.`, {
      hint: 'Check npm prefix -g and the install, then run ghx install from the global copy.',
      details: { command: installArgv.join(' '), prefix, bin },
    });
  }

  const childEnv = { ...ctx.env, npm_command: undefined, npm_lifecycle_event: undefined, [HANDOFF_ENV]: '1' };
  const c = await ctx.proc({
    cmd: process.execPath,
    args: [realpathSync(bin), ...args],
    env: childEnv,
    cwd: ctx.cwd,
    signal: ctx.signal,
    timeoutMs: 120_000,
  });
  let doc: Record<string, unknown> | undefined;
  try {
    doc = JSON.parse(c.stdout) as Record<string, unknown>;
  } catch {
    doc = undefined;
  }
  const err = doc?.error as { code?: string; message?: string; hint?: string | null; details?: unknown } | undefined;
  if (err && typeof err.code === 'string' && Object.hasOwn(ERROR_CODES, err.code)) {
    throw new GhxError(err.code as ErrorCode, `The global ghx install failed: ${err.message ?? err.code}`, {
      ...(err.hint ? { hint: err.hint } : {}),
      details: { ...((err.details as Record<string, unknown> | null) ?? {}), handoff: plan },
    });
  }
  if (c.exitCode !== 0 || !doc || err) {
    throw new GhxError('INSTALL_GLOBAL_FAILED', `${bin} ${args.join(' ')} failed (exit ${c.exitCode ?? c.signal}).`, {
      details: { handoff: plan, stdout: tail(c.stdout), stderr: tail(c.stderr) },
    });
  }
  const { warnings, ...out } = doc as InstallOutput & { warnings?: { code: string; message: string }[] };
  for (const w of warnings ?? []) ctx.warn(w);
  return {
    ...out,
    handoff: plan,
    next: [`ghx ${VERSION} is installed globally (${bin}); the hook runs that copy.`, ...(out.next ?? [])],
  };
}
