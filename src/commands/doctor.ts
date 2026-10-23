// ghx doctor (01 §8): gh on PATH and its version, feature probes, auth on the target host, git and
// the cwd repo, and the config. Every probe is caught: doctor reports, it does not crash.
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { ConfigSource } from '../config/load.ts';
import { defineCommand } from '../core/command.ts';
import { GhxError, isGhxError } from '../core/errors.ts';
import { ExitCode } from '../core/exit.ts';
import { GhFailure } from '../gh/index.ts';
import { type ResolvedRepo, resolveCwdRepo } from '../gh/repo.ts';
import { DEFAULT_HOST, repoSlug } from '../gh/types.ts';
import { MIN_GH_VERSION, versionAtLeast } from '../gh/version.ts';
import { InstallReport, inspectInstall } from '../install/inspect.ts';

const Check = z.object({ name: z.string(), ok: z.boolean(), message: z.string(), hint: z.string().nullable() });

const Output = z.object({
  ok: z.boolean(),
  gh: z.object({
    path: z.string().nullable(),
    version: z.string().nullable(),
    minVersion: z.string(),
    ok: z.boolean(),
  }),
  auth: z.object({ host: z.string(), login: z.string().nullable(), ok: z.boolean(), scopes: z.array(z.string()) }),
  git: z.object({
    ok: z.boolean(),
    toplevel: z.string().nullable(),
    repo: z.string().nullable(),
    repoSource: z.string().nullable(),
  }),
  config: z.object({
    status: z.enum(['valid', 'missing', 'invalid', 'skipped']),
    source: z.record(z.string(), z.unknown()).nullable(),
    issues: z.array(z.unknown()).optional(),
  }),
  checks: z.array(Check),
  install: InstallReport,
});
type Output = z.output<typeof Output>;

const AuthStatus = z.object({
  hosts: z.record(
    z.string(),
    z.array(
      z
        .object({
          state: z.string(),
          active: z.boolean(),
          host: z.string(),
          login: z.string().optional(),
          scopes: z.string().optional(),
          error: z.string().optional(),
        })
        .loose(),
    ),
  ),
});

function findOnPath(cmd: string, path: string | undefined): string | null {
  if (isAbsolute(cmd)) return cmd;
  for (const dir of (path ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, cmd);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  return null;
}

function sourceJson(s: ConfigSource): Record<string, unknown> {
  if (s.kind === 'local') return { kind: 'local', path: s.path };
  if (s.kind === 'remote') return { kind: 'remote', repo: repoSlug(s.repo), ref: s.ref, path: s.path };
  return { kind: 'default' };
}

export default defineCommand({
  name: ['doctor'],
  summary: 'Check the setup: gh version and features, auth, git, the target repo and its config.',
  kind: 'read',
  needs: { repo: 'optional', config: 'optional' },
  input: z.strictObject({}),
  output: Output,
  examples: [{ argv: 'ghx doctor' }, { argv: 'ghx doctor --repo owner/name' }],
  exitCode: (o) => {
    if (!o.gh.ok || !o.auth.ok || !o.git.ok) return ExitCode.ENV;
    if (o.config.status === 'invalid' || o.config.status === 'missing') return ExitCode.CONFIG;
    // An unresolvable repo (e.g. two remotes and no gh default) is fixed by passing --repo.
    if (o.checks.some((c) => c.name === 'repo' && !c.ok)) return ExitCode.USAGE;
    return o.ok ? ExitCode.OK : ExitCode.INTERNAL;
  },
  async run(_input, ctx) {
    const checks: z.input<typeof Check>[] = [];
    const add = (name: string, ok: boolean, message: string, hint: string | null = null) =>
      checks.push({ name, ok, message, hint });

    for (const k of Object.keys(ctx.env)
      .filter((key) => key.startsWith('GHX_TEST_'))
      .sort()) {
      ctx.warn({
        code: 'TEST_HOOKS_SET',
        message: `${k} is set; test seams are active. Unset it outside the test suite.`,
      });
    }

    // gh: on PATH, version, feature probes.
    const ghCmd = ctx.env.GHX_GH_PATH || 'gh';
    const gh: Output['gh'] = {
      path: findOnPath(ghCmd, ctx.env.PATH),
      version: null,
      minVersion: MIN_GH_VERSION,
      ok: false,
    };
    let ghPresent = false;
    try {
      const v = await ctx.gh.version();
      ghPresent = true;
      gh.version = v.raw;
      const fresh = versionAtLeast(v, MIN_GH_VERSION);
      add(
        'gh-version',
        fresh,
        `gh ${v.raw}${fresh ? '' : ` is older than ${MIN_GH_VERSION}`}`,
        fresh ? null : 'Upgrade GitHub CLI (brew upgrade gh).',
      );
    } catch (e) {
      const missing = isGhxError(e, 'ENV_GH_MISSING');
      gh.path = null;
      add(
        'gh-version',
        false,
        missing ? `${ghCmd} not found on PATH.` : `gh --version failed: ${(e as Error).message}`,
        'Install GitHub CLI: https://cli.github.com',
      );
    }

    // Auth on the target host (feature probe 1: auth status --json).
    const resolved: ResolvedRepo | undefined = await ctx.tryRepo().catch((e: unknown) => {
      add('repo', false, (e as Error).message, isGhxError(e) ? (e.hint ?? null) : null);
      return undefined;
    });
    if (!resolved) {
      // needs.repo is optional, so tryRepo() returns nothing on an ambiguous cwd; doctor must say so.
      const cwd = await resolveCwdRepo(ctx.git, ctx.env);
      if (cwd.ambiguous) {
        const list = cwd.ambiguous.map((a) => `${a.remote} → ${repoSlug(a.repo)}`).join(', ');
        add(
          'repo',
          false,
          `several GitHub remotes and none is the gh default: ${list}`,
          'Pass --repo owner/name, or run: gh repo set-default',
        );
      }
    }
    const host = resolved?.repo.host ?? ctx.env.GH_HOST ?? DEFAULT_HOST;
    const auth: Output['auth'] = { host, login: null, ok: false, scopes: [] };
    let jsonProbe = false;
    if (ghPresent) {
      try {
        const status = await ctx.gh.json(
          { args: ['auth', 'status', '--json', 'hosts'], retry: 'none', timeoutMs: 15_000 },
          AuthStatus,
        );
        jsonProbe = true;
        const accounts = status.hosts[host] ?? [];
        const active = accounts.find((a) => a.active) ?? accounts[0];
        if (!active) {
          add(
            'auth',
            false,
            `gh is not authenticated for ${host}.`,
            `Run 'gh auth login${host === DEFAULT_HOST ? '' : ` --hostname ${host}`}' (a human must do this).`,
          );
        } else {
          auth.login = active.login ?? null;
          auth.scopes = (active.scopes ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          const good = active.state === 'success';
          // Fine-grained and app tokens report no scopes; only a classic token's missing `repo` scope is a finding.
          const repoScope = auth.scopes.length === 0 || auth.scopes.includes('repo');
          auth.ok = good && repoScope;
          add(
            'auth',
            auth.ok,
            good
              ? `${auth.login ?? 'unknown'} on ${host}${repoScope ? '' : ' (token lacks the repo scope)'}`
              : `gh auth for ${host} is in state '${active.state}'${active.error ? `: ${active.error}` : ''}`,
            auth.ok ? null : good ? `Run 'gh auth refresh -s repo'.` : `Run 'gh auth login' (a human must do this).`,
          );
        }
      } catch (e) {
        add(
          'auth',
          false,
          `gh auth status --json failed: ${(e as Error).message}`,
          `gh ${MIN_GH_VERSION}+ is required for this probe; upgrade gh.`,
        );
      }
      add(
        'feature: auth status --json',
        jsonProbe,
        jsonProbe ? 'available' : 'unavailable',
        jsonProbe ? null : `Upgrade gh to ${MIN_GH_VERSION}+.`,
      );

      // Feature probe 2: pr checks --json.
      try {
        const help = await ctx.gh.exec({ args: ['pr', 'checks', '--help'], retry: 'none', timeoutMs: 15_000 });
        const has = /--json\b/.test(help.stdout);
        add('feature: pr checks --json', has, has ? 'available' : 'unavailable', has ? null : 'Upgrade gh to 2.50.0+.');
      } catch (e) {
        add('feature: pr checks --json', false, `gh pr checks --help failed: ${(e as Error).message}`, 'Upgrade gh.');
      }
    }
    gh.ok =
      ghPresent && checks.filter((c) => c.name === 'gh-version' || c.name.startsWith('feature:')).every((c) => c.ok);

    // git and the cwd repo (informational).
    const git: Output['git'] = { ok: false, toplevel: null, repo: null, repoSource: null };
    git.ok = await ctx.git.available();
    git.toplevel = (await ctx.git.toplevel()) ?? null;
    if (resolved) {
      git.repo = repoSlug(resolved.repo);
      git.repoSource = resolved.source;
    }
    add(
      'git',
      git.ok,
      git.ok
        ? git.toplevel
          ? `checkout at ${git.toplevel}`
          : 'git present; cwd is not a checkout'
        : 'git not found on PATH.',
      git.ok ? null : 'Install git.',
    );

    // Config of the target repo.
    let config: Output['config'] = { status: 'skipped', source: null };
    if (resolved || git.toplevel) {
      try {
        const loaded = await ctx.config();
        config =
          loaded.source.kind === 'default'
            ? { status: 'missing', source: null }
            : { status: 'valid', source: sourceJson(loaded.source) };
        add(
          'config',
          config.status === 'valid',
          config.status === 'valid' ? `valid (${loaded.source.kind})` : 'no .github/ghx.json',
          config.status === 'valid' ? null : "Run 'ghx init'.",
        );
      } catch (e) {
        if (e instanceof GhxError && e.code.startsWith('CONFIG_')) {
          const issues = Array.isArray(e.details?.issues) ? (e.details?.issues as unknown[]) : [];
          config = {
            status: 'invalid',
            source: (e.details?.source as Record<string, unknown> | undefined) ?? null,
            issues,
          };
          add('config', false, e.message, e.hint ?? null);
        } else if (e instanceof GhFailure) {
          add('config', false, `could not fetch the config: ${e.message}`, e.hint ?? null);
        } else {
          throw e;
        }
      }
    }

    // ghx install state (informational: never part of ok or the exit code).
    const install = await inspectInstall(ctx.env, ctx.git);
    for (const [scope, s] of Object.entries(install)) {
      if (s?.hook.installed && s.hook.missingPaths.length > 0) {
        ctx.warn({
          code: 'INSTALL_HOOK_STALE',
          message: `The ${scope} ghx hook runs ${s.hook.missingPaths.join(', ')}, which no longer exists; it fails open. Re-run ghx install${scope === 'project' ? ' --scope project' : ''}.`,
        });
      }
    }

    return { ok: checks.every((c) => c.ok), gh, auth, git, config, checks, install };
  },
});
