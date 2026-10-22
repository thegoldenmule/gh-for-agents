// Builds the Context a handler receives (01 §3.1): lazy repo, mode-guarded gh, artifacts, warnings.
import { type LoadedConfig, loadConfig } from '../config/load.ts';
import { createGh, type Gh } from '../gh/index.ts';
import { type ResolvedRepo, resolveRepo } from '../gh/repo.ts';
import { type RepoRef, repoArg } from '../gh/types.ts';
import { createGit, type Git } from '../git/index.ts';
import type { ProcessRunner } from '../proc/runner.ts';
import type { ArtifactStore } from './artifacts.ts';
import type { Clock } from './clock.ts';
import type { AnyCommandSpec, Context, Warning } from './command.ts';
import { GhxError, isGhxError } from './errors.ts';
import type { Logger } from './log.ts';
import type { Random } from './random.ts';

export interface ContextDeps {
  spec: AnyCommandSpec;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  clock: Clock;
  random: Random;
  proc: ProcessRunner;
  /** Test override; otherwise a real git probe over `proc`. */
  git?: Git;
  /** Test override; otherwise createGh over `proc`. */
  gh?: Gh;
  artifacts: ArtifactStore;
  signal: AbortSignal;
  deadline: number | undefined;
  dryRun: boolean;
  verbose: boolean;
  log: Logger;
  /** --repo */
  flagRepo?: string | undefined;
}

export interface BuiltContext {
  ctx: Context;
  warnings: Warning[];
  previews: unknown[];
}

export function createContext(d: ContextDeps): BuiltContext {
  const warnings: Warning[] = [];
  const previews: unknown[] = [];
  const need = d.spec.needs?.repo ?? 'inferred';
  const git = d.git ?? createGit({ proc: d.proc, cwd: d.cwd, env: d.env, signal: d.signal });
  const gh =
    d.gh ??
    createGh({
      proc: d.proc,
      clock: d.clock,
      signal: d.signal,
      mode: d.spec.kind,
      dryRun: d.dryRun,
      env: d.env,
      deadline: d.deadline,
      log: d.log,
      verbose: d.verbose,
      random: d.random,
      ...(d.env.GHX_GH_PATH ? { ghPath: d.env.GHX_GH_PATH } : {}),
    });
  const memo = new Map<string, Promise<ResolvedRepo | undefined>>();
  const resolve = (ref: RepoRef | undefined): Promise<ResolvedRepo | undefined> => {
    if (need === 'none') {
      return Promise.reject(
        new GhxError('INTERNAL', `ghx ${d.spec.name.join(' ')} declares needs.repo 'none' but asked for a repo.`),
      );
    }
    const key = ref ? repoArg(ref) : '';
    let p = memo.get(key);
    if (!p) {
      p = resolveRepo({ flag: d.flagRepo, ref, env: d.env, git, need }).then((r) => {
        if (r) d.artifacts.setRepo(r.repo);
        return r;
      });
      memo.set(key, p);
    }
    return p;
  };
  const configNeed = d.spec.needs?.config ?? 'none';
  const configs = new Map<string, Promise<LoadedConfig>>();
  const config = (ref: RepoRef | undefined): Promise<LoadedConfig> => {
    if (configNeed === 'none') {
      return Promise.reject(
        new GhxError('INTERNAL', `ghx ${d.spec.name.join(' ')} declares needs.config 'none' but asked for config.`),
      );
    }
    const key = ref ? repoArg(ref) : '';
    let p = configs.get(key);
    if (!p) {
      p = (async () => {
        let target: ResolvedRepo | undefined;
        if (need !== 'none') {
          try {
            target = await resolve(ref);
          } catch (e) {
            if (configNeed === 'required' || !(isGhxError(e, 'REPO_NOT_FOUND') || isGhxError(e, 'REPO_AMBIGUOUS')))
              throw e;
          }
        }
        return loadConfig({ target, git, gh, need: configNeed });
      })();
      configs.set(key, p);
    }
    return p;
  };
  const ctx: Context = {
    cwd: d.cwd,
    env: d.env,
    clock: d.clock,
    random: d.random,
    signal: d.signal,
    deadline: d.deadline,
    gh,
    git,
    artifacts: d.artifacts,
    dryRun: d.dryRun,
    log: d.log,
    async repo(o = {}) {
      const r = await resolve(o.ref);
      if (!r) throw new GhxError('REPO_NOT_FOUND', 'Could not determine a repo.');
      return r;
    },
    tryRepo: (o = {}) => resolve(o.ref),
    config: (o = {}) => config(o.ref),
    warn(w) {
      warnings.push(w);
    },
    preview(v) {
      previews.push(v);
    },
  };
  return { ctx, warnings, previews };
}
