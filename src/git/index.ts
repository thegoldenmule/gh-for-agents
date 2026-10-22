// Local git probe (01 §4.5) via the ProcessRunner: toplevel, remotes (with gh-resolved), branch.
// No network. All results are memoized per process.
import type { ProcessRunner } from '../proc/runner.ts';

export interface GitRemote {
  name: string;
  url: string;
  /** remote.<name>.gh-resolved: 'base' marks gh's default repo (gh repo set-default). */
  ghResolved?: string;
}

export interface Git {
  /** False when git is not installed. */
  available(): Promise<boolean>;
  /** `git rev-parse --show-toplevel`, or undefined outside a work tree. */
  toplevel(): Promise<string | undefined>;
  remotes(): Promise<GitRemote[]>;
  currentBranch(): Promise<string | undefined>;
  /** `git rev-parse --verify <ref>^{commit}`. */
  revParse(ref: string): Promise<string | undefined>;
}

export interface GitDeps {
  proc: ProcessRunner;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  signal: AbortSignal;
  gitPath?: string;
}

/** Parse `git config --get-regexp '^remote\..*\.(url|gh-resolved)$'`. Order of first appearance is kept. */
export function parseRemoteConfig(stdout: string): GitRemote[] {
  const byName = new Map<string, GitRemote>();
  for (const line of stdout.split('\n')) {
    const m = /^remote\.(.+)\.(url|gh-resolved) (.*)$/.exec(line.trim());
    if (!m) continue;
    const name = m[1] ?? '';
    const r = byName.get(name) ?? { name, url: '' };
    if (m[2] === 'url') r.url = m[3] ?? '';
    else r.ghResolved = m[3] ?? '';
    byName.set(name, r);
  }
  return [...byName.values()].filter((r) => r.url !== '');
}

export function createGit(deps: GitDeps): Git {
  const cmd = deps.gitPath ?? 'git';
  const env = { ...deps.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
  const memo = new Map<string, Promise<{ ok: boolean; out: string; missing: boolean }>>();
  const run = (args: string[]) => {
    const key = args.join('\0');
    let p = memo.get(key);
    if (!p) {
      p = deps.proc({ cmd, args, env, cwd: deps.cwd, signal: deps.signal, timeoutMs: 10_000 }).then((r) => ({
        ok: r.exitCode === 0,
        out: r.stdout.trim(),
        missing: r.spawnError?.code === 'ENOENT',
      }));
      memo.set(key, p);
    }
    return p;
  };
  return {
    available: async () => !(await run(['--version'])).missing,
    toplevel: async () => {
      const r = await run(['rev-parse', '--show-toplevel']);
      return r.ok && r.out ? r.out : undefined;
    },
    remotes: async () => {
      const r = await run(['config', '--get-regexp', '^remote\\..*\\.(url|gh-resolved)$']);
      return r.ok ? parseRemoteConfig(r.out) : [];
    },
    currentBranch: async () => {
      const r = await run(['symbolic-ref', '--quiet', '--short', 'HEAD']);
      return r.ok && r.out ? r.out : undefined;
    },
    revParse: async (ref) => {
      const r = await run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      return r.ok && r.out ? r.out : undefined;
    },
  };
}
