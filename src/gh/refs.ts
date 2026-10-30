// Parsing of repo and target references (01 §4.5): 123, #123, o/r#123, host/o/r#123, and PR / run /
// job URLs. Repos: owner/name, host/owner/name, https and ssh remote URLs.
import { GhxError } from '../core/errors.ts';
import { DEFAULT_HOST, type RepoRef } from './types.ts';

const SEG = /^[A-Za-z0-9_.-]+$/;

function ref(host: string, owner: string, name: string): RepoRef | undefined {
  const n = name.replace(/\.git$/, '');
  if (!SEG.test(owner) || !SEG.test(n) || n === '.' || n === '..') return undefined;
  return { host: host.toLowerCase(), owner, name: n };
}

/** owner/name, host/owner/name, https://host/o/r(.git), git@host:o/r(.git), ssh://git@host[:port]/o/r(.git). */
export function tryParseRepo(s: string, defaultHost = DEFAULT_HOST): RepoRef | undefined {
  const t = s.trim();
  let m = /^(?:https?|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)\/?$/.exec(t);
  if (m) return ref(m[1] ?? '', m[2] ?? '', m[3] ?? '');
  m = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)\/?$/.exec(t);
  if (m) return ref(m[1] ?? '', m[2] ?? '', m[3] ?? '');
  m = /^(?:[^@/\s]+@)([^:/\s]+):([^/]+)\/([^/]+?)\/?$/.exec(t);
  if (m) return ref(m[1] ?? '', m[2] ?? '', m[3] ?? '');
  const parts = t.split('/');
  if (parts.length === 2) return ref(defaultHost, parts[0] ?? '', parts[1] ?? '');
  if (parts.length === 3 && (parts[0] ?? '').includes('.')) return ref(parts[0] ?? '', parts[1] ?? '', parts[2] ?? '');
  return undefined;
}

export function parseRepo(s: string, defaultHost = DEFAULT_HOST): RepoRef {
  const r = tryParseRepo(s, defaultHost);
  if (!r) {
    throw new GhxError('VALIDATION', `'${s}' is not a repository.`, {
      hint: 'Use owner/name, host/owner/name or a repository URL.',
      details: { issues: [{ path: '--repo', code: 'invalid_repo', message: `'${s}' is not owner/name` }] },
    });
  }
  return r;
}

export type TargetKind = 'pr' | 'run' | 'job';

export interface TargetRef {
  kind: TargetKind;
  /** PR number, run id, or job id. */
  number: number;
  repo?: RepoRef;
  /** For a job URL, the run it belongs to. */
  runId?: number;
}

function positive(s: string | undefined): number | undefined {
  if (s === undefined || !/^\d+$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Parse a target selector. Returns undefined when `s` is not one (callers raise USAGE_BAD_SELECTOR). */
export function tryParseTargetRef(s: string, defaultHost = DEFAULT_HOST): TargetRef | undefined {
  const t = s.trim();
  const bare = positive(t.replace(/^#/, ''));
  if (bare !== undefined) return { kind: 'pr', number: bare };

  const url = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/(.+?)\/?(?:[?#].*)?$/.exec(t);
  if (url) {
    const repo = ref(url[1] ?? '', url[2] ?? '', url[3] ?? '');
    if (!repo) return undefined;
    const rest = url[4] ?? '';
    let m = /^pull\/(\d+)(?:\/.*)?$/.exec(rest);
    if (m) {
      const n = positive(m[1]);
      return n === undefined ? undefined : { kind: 'pr', number: n, repo };
    }
    m = /^actions\/runs\/(\d+)\/job\/(\d+)(?:\/.*)?$/.exec(rest);
    if (m) {
      const runId = positive(m[1]);
      const job = positive(m[2]);
      return runId === undefined || job === undefined ? undefined : { kind: 'job', number: job, repo, runId };
    }
    m = /^actions\/runs\/(\d+)(?:\/attempts\/\d+)?\/?$/.exec(rest);
    if (m) {
      const n = positive(m[1]);
      return n === undefined ? undefined : { kind: 'run', number: n, repo };
    }
    return undefined;
  }

  const hash = /^(.+)#(\d+)$/.exec(t);
  if (hash) {
    const repo = tryParseRepo(hash[1] ?? '', defaultHost);
    const n = positive(hash[2]);
    return repo && n !== undefined ? { kind: 'pr', number: n, repo } : undefined;
  }
  return undefined;
}

export function parseTargetRef(s: string, defaultHost = DEFAULT_HOST): TargetRef {
  const r = tryParseTargetRef(s, defaultHost);
  if (!r) {
    // A branch (branch:main, or a bare feat/x) is not a PR: say where each lives.
    const branch = /^branch:(.+)$/.exec(s)?.[1] ?? (/^[\w.-]+(?:\/[\w.-]+)*$/.test(s) ? s : undefined);
    throw new GhxError('USAGE_BAD_SELECTOR', `'${s}' is not a PR selector.`, {
      hint:
        branch === undefined
          ? 'Use 3198, #3198, owner/repo#3198 or a PR URL.'
          : `Use 3198, #3198, owner/repo#3198 or a PR URL. For branch ${branch}: ghx pr list --head ${branch} names its PR; ghx ci why branch:${branch} reads its CI.`,
    });
  }
  return r;
}

/** owner/repo#N, the `ref` every PR output carries (02 §1.2). */
export function formatPrRef(repo: RepoRef, n: number): string {
  return `${repo.owner}/${repo.name}#${n}`;
}
