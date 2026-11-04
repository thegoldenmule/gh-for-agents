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
  /** `git diff --name-only -z <from>...<to>`; undefined when git cannot answer (objects missing, not a checkout). */
  diffNames(from: string, to: string): Promise<string[] | undefined>;
  /** `git check-ignore -q -- <path>`: true ignored, false not, undefined when git cannot answer. */
  isIgnored(path: string): Promise<boolean | undefined>;
  /** The last `limit` non-merge commits' subjects and changed paths, newest first; undefined without history. */
  history?(limit: number): Promise<GitCommit[] | undefined>;
  /** `git rev-parse --verify --quiet <ref>:<path>`: the blob id of a repo-relative path at a ref; undefined when absent. */
  blobAt?(ref: string, path: string): Promise<string | undefined>;
  /** `git hash-object -- <file>`: the blob id a working-tree file would have; undefined when git cannot answer. */
  hashFile?(file: string): Promise<string | undefined>;
  /** `git rev-list --left-right --count <a>...<b>`: commits only in `a` (ahead) and only in `b` (behind). */
  aheadBehind?(a: string, b: string): Promise<{ ahead: number; behind: number } | undefined>;
  /** `git symbolic-ref --quiet --short refs/remotes/<remote>/HEAD`, e.g. `origin/main`; undefined when unset. */
  remoteHead?(remote: string): Promise<string | undefined>;
}

export interface GitCommit {
  subject: string;
  files: string[];
}

/** Parse `git log --format=%x1e%s --name-only`: one record per commit, its subject, then its paths. */
export function parseHistory(stdout: string): GitCommit[] {
  return stdout
    .split('\x1e')
    .filter((r) => r.trim() !== '')
    .map((r) => {
      const [subject = '', ...rest] = r.split('\n');
      return { subject: subject.trim(), files: rest.map((f) => f.trim()).filter((f) => f !== '') };
    });
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
  const memo = new Map<string, Promise<{ ok: boolean; code: number | null; out: string; missing: boolean }>>();
  const run = (args: string[]) => {
    const key = args.join('\0');
    let p = memo.get(key);
    if (!p) {
      p = deps.proc({ cmd, args, env, cwd: deps.cwd, signal: deps.signal, timeoutMs: 10_000 }).then((r) => ({
        ok: r.exitCode === 0,
        code: r.exitCode,
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
    diffNames: async (from, to) => {
      const r = await run(['diff', '--name-only', '-z', '--no-color', `${from}...${to}`]);
      return r.ok ? r.out.split('\0').filter((f) => f !== '') : undefined;
    },
    isIgnored: async (path) => {
      const r = await run(['check-ignore', '-q', '--', path]);
      return r.code === 0 ? true : r.code === 1 ? false : undefined;
    },
    history: async (limit) => {
      const r = await run([
        '-c',
        'core.quotePath=false',
        'log',
        `-n${limit}`,
        '--no-merges',
        '--no-color',
        '--format=%x1e%s',
        '--name-only',
      ]);
      return r.ok ? parseHistory(r.out) : undefined;
    },
    blobAt: async (ref, path) => {
      const r = await run(['rev-parse', '--verify', '--quiet', `${ref}:${path}`]);
      return r.ok && r.out ? r.out : undefined;
    },
    hashFile: async (file) => {
      const r = await run(['hash-object', '--', file]);
      return r.ok && r.out ? r.out : undefined;
    },
    aheadBehind: async (a, b) => {
      const r = await run(['rev-list', '--left-right', '--count', `${a}...${b}`]);
      const m = r.ok ? /^(\d+)\s+(\d+)$/.exec(r.out) : null;
      return m ? { ahead: Number(m[1]), behind: Number(m[2]) } : undefined;
    },
    remoteHead: async (remote) => {
      const r = await run(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]);
      return r.ok && r.out ? r.out : undefined;
    },
  };
}
