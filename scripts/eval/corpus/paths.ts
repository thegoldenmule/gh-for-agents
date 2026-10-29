// Default locations and flag parsing for ghx-eval (plan 07, M0). Everything is overridable by flag; these only
// read the environment, and only nowFrom reads the clock.
//   GHX_EVAL_HOME      eval home, default ~/.ghx-eval
//   <home>/corpus      the store: files/, state.json, divergent/, manifests/ (see ingest.ts)
//   CLAUDE_CONFIG_DIR  Claude Code's config dir, default ~/.claude; transcripts live in <it>/projects
import { homedir } from 'node:os';
import { join } from 'node:path';

export function evalHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.GHX_EVAL_HOME || join(homedir(), '.ghx-eval');
}

export function defaultStore(env: NodeJS.ProcessEnv = process.env): string {
  return join(evalHome(env), 'corpus');
}

export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
}

/** The compressed 2026-10-29 snapshot (findings §0). Read only, never modified. */
export function defaultArchive(env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultStore(env), 'claude-projects-2026-10-29.tar.gz');
}

/** Store layout under a store root. */
export function storeLayout(store: string): { files: string; state: string; divergent: string; manifests: string } {
  return {
    files: join(store, 'files'),
    state: join(store, 'state.json'),
    divergent: join(store, 'divergent'),
    manifests: join(store, 'manifests'),
  };
}

/** The `--now` flag: an ISO-8601 instant, or the wall clock when absent. Only commands call this. */
export function nowFrom(arg: string | undefined): Date {
  if (arg === undefined) return new Date();
  const d = new Date(arg);
  if (Number.isNaN(d.getTime())) throw new Error(`--now: not an ISO-8601 time: ${arg}`);
  return d;
}

/** The `--window-hours` flag. */
export function windowFrom(arg: string | undefined, fallback: number): number {
  if (arg === undefined) return fallback;
  const n = Number(arg);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--window-hours: not a non-negative number: ${arg}`);
  return n;
}
