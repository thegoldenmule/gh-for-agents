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
  // Config provenance and drift (config/load.ts). Each runs with GIT_NO_LAZY_FETCH=1, so a partial clone
  // answers from what it has instead of fetching from the network.
  /** `git rev-parse --is-shallow-repository HEAD`: HEAD's commit (absent when unborn) and whether the clone is shallow. */
  head?(): Promise<{ commit?: string; shallow: boolean } | undefined>;
  /** `git cat-file --batch-check`: each spec's object id (`<ref>:<path>`, `<ref>`), undefined when missing. */
  objectIds?(specs: readonly string[]): Promise<(string | undefined)[] | undefined>;
  /** `git merge-base <a> <b>`; undefined without a common ancestor or an answer. */
  mergeBase?(a: string, b: string): Promise<string | undefined>;
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
  const offline = { ...env, GIT_NO_LAZY_FETCH: '1' };
  const run = (args: string[], o: { stdin?: string; offline?: boolean } = {}) => {
    const key = [...args, o.offline ? '\u0001offline' : '', o.stdin ?? ''].join('\0');
    let p = memo.get(key);
    if (!p) {
      const req = { cmd, args, env: o.offline ? offline : env, cwd: deps.cwd, signal: deps.signal, timeoutMs: 10_000 };
      p = deps.proc(o.stdin !== undefined ? { ...req, stdin: o.stdin } : req).then((r) => ({
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
    head: async () => {
      const r = await run(['rev-parse', '--is-shallow-repository', 'HEAD'], { offline: true });
      const [shallow, commit] = r.out.split('\n').map((l) => l.trim());
      if (shallow !== 'true' && shallow !== 'false') return undefined;
      return { shallow: shallow === 'true', ...(r.ok && commit && /^[0-9a-f]{40,64}$/.test(commit) ? { commit } : {}) };
    },
    objectIds: async (specs) => {
      if (specs.length === 0) return [];
      const r = await run(['cat-file', '--batch-check=%(objectname)'], {
        stdin: `${specs.join('\n')}\n`,
        offline: true,
      });
      if (!r.ok) return undefined;
      const lines = r.out.split('\n');
      if (lines.length !== specs.length) return undefined;
      return lines.map((l) => (/^[0-9a-f]{40,64}$/.test(l.trim()) ? l.trim() : undefined));
    },
    mergeBase: async (a, b) => {
      const r = await run(['merge-base', a, b], { offline: true });
      return r.ok && r.out ? r.out : undefined;
    },
    hashFile: async (file) => {
      const r = await run(['hash-object', '--', file], { offline: true });
      return r.ok && r.out ? r.out : undefined;
    },
    aheadBehind: async (a, b) => {
      const r = await run(['rev-list', '--left-right', '--count', `${a}...${b}`], { offline: true });
      const m = r.ok ? /^(\d+)\s+(\d+)$/.exec(r.out) : null;
      return m ? { ahead: Number(m[1]), behind: Number(m[2]) } : undefined;
    },
    remoteHead: async (remote) => {
      const r = await run(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`], { offline: true });
      return r.ok && r.out ? r.out : undefined;
    },
  };
}
