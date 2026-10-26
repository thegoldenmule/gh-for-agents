// A scripted GitHub for `pr create` tests (03 §4.2): FakeGh rules for each call of 02 §2.6, plus a
// labeller so tests can assert the exact call sequence. Not a test file (no .test.ts suffix).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMutating } from '../../src/gh/guard.ts';
import { FakeGh, type FakeGhCall, type GhReply } from '../helpers/fake-gh.ts';

export const BASE_OID = 'a'.repeat(40);
export const HEAD_OID = 'b'.repeat(40);
export const PARENT_OID = 'c'.repeat(40);

export const CONFIG = {
  version: 1,
  components: {
    app: { paths: ['src/**'] },
    docs: { paths: ['docs/**'] },
    reactor: { paths: ['packages/reactor/**'] },
  },
};

export const INPUT = {
  title: 'feat(app): show a banner when a request is retried',
  description: 'Requests retried after a transient failure now show a dismissable banner.',
  testing: [{ kind: 'unit', command: 'pnpm test', result: 'pass' }],
  risk: 'low',
  components: ['app'],
  revertPolicy: 'revert-safe',
  base: 'main',
  head: 'feat/retry-banner',
};

export const http = (status: number, body: unknown, reason = 'OK'): string =>
  `HTTP/2.0 ${status} ${reason}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify(body)}`;

export const ok = (body: unknown, status = 200, reason = 'OK'): GhReply => ({
  exitCode: 0,
  stdout: http(status, body, reason),
  stderr: '',
});

export const fail = (status: number, body: unknown, reason: string): GhReply => ({
  exitCode: 1,
  stdout: http(status, body, reason),
  stderr: `gh: ${reason} (HTTP ${status})\n`,
});

export interface PrNodeSpec {
  number: number;
  state?: string;
  repo?: string;
  body?: string;
}

const node = (n: PrNodeSpec) => ({
  number: n.number,
  state: n.state ?? 'OPEN',
  url: `https://github.com/octo/demo/pull/${n.number}`,
  headRepository: { nameWithOwner: n.repo ?? 'octo/demo' },
  ...(n.body !== undefined ? { body: n.body } : {}),
});

export interface BranchSpec {
  /** Remote OID, or null when the branch is not on the remote. */
  oid: string | null;
  /** PRs whose head is this branch. */
  prs?: PrNodeSpec[];
}

export interface SceneOptions {
  defaultBranch?: string;
  permission?: string;
  /** Branch name → remote state. Unknown branches default to { oid: HEAD_OID }. */
  branches?: Record<string, BranchSpec>;
  /** Refs (as aliased in the query, e.g. 'r0', 'x1') that do not exist. */
  missingAliases?: string[];
  files?: string[];
  aheadBy?: number;
  /** Replies to POST /pulls, in order (the last repeats). Default: a 201 echoing the request. */
  post?: (GhReply | 'echo')[];
  /** Open PRs returned by the re-check after a failed POST. A function sees the POSTed bodies so far. */
  recheck?: PrNodeSpec[] | ((posted: Record<string, unknown>[]) => PrNodeSpec[]);
  /** Overrides on the read-back. */
  readback?: { title?: string; body?: string };
  /** Serve the config through the contents API (remote). Default true. */
  remoteConfig?: boolean;
  /** The config served remotely. Default CONFIG. */
  config?: unknown;
}

export interface Scene {
  gh: FakeGh;
  /** Bodies sent to POST /pulls, parsed. */
  posted: Record<string, unknown>[];
}

/** The preflight query's branch variables and aliases, read back from argv. */
function fieldOf(argv: readonly string[], key: string): string | undefined {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === '-f' && argv[i + 1]?.startsWith(`${key}=`)) return argv[i + 1]?.slice(key.length + 1);
  }
  return undefined;
}

export function label(call: FakeGhCall): string {
  const a = call.argv;
  if (a[0] === 'api' && a[1] === 'graphql') {
    const q = fieldOf(a, 'query') ?? '';
    return q.includes('viewer{login}') ? 'preflight' : 'recheck';
  }
  const path = a.find((x) => x.startsWith('repos/')) ?? '';
  if (path.endsWith('/contents/.github/ghx.json')) return 'config';
  if (path.includes('/compare/')) return 'compare';
  if (isMutating(a) && path.endsWith('/pulls')) return 'post';
  if (/\/pulls\/\d+$/.test(path)) return 'readback';
  return `other:${a.join(' ')}`;
}

export function sequence(gh: FakeGh): string[] {
  return gh.calls.map(label);
}

export function scene(o: SceneOptions = {}): Scene {
  const gh = new FakeGh();
  const posted: Record<string, unknown>[] = [];
  const branches = o.branches ?? {};
  const branch = (name: string): BranchSpec => branches[name] ?? { oid: name === 'main' ? BASE_OID : HEAD_OID };
  let lastNumber = 100;

  if (o.remoteConfig !== false) {
    gh.on(
      (a) => label({ argv: a, env: {}, at: 0 }) === 'config',
      ok({
        content: Buffer.from(JSON.stringify(o.config ?? CONFIG)).toString('base64'),
        encoding: 'base64',
        url: 'https://api.github.com/repos/octo/demo/contents/.github/ghx.json?ref=main',
      }),
    );
  }

  // The preflight answers from the branch variables in argv, so batch items each get their own reply.
  const preflightReply = (argv: string[]): GhReply => {
    const base = fieldOf(argv, 'base') ?? '';
    const head = fieldOf(argv, 'head') ?? '';
    const query = fieldOf(argv, 'query') ?? '';
    const missing = new Set(o.missingAliases ?? []);
    const repository: Record<string, unknown> = {
      nameWithOwner: 'octo/demo',
      viewerPermission: o.permission ?? 'WRITE',
      defaultBranchRef: { name: o.defaultBranch ?? 'main' },
      baseRef: branch(base).oid === null ? null : { target: { oid: branch(base).oid } },
      headRef: branch(head).oid === null ? null : { target: { oid: branch(head).oid } },
      headPrs: { nodes: (branch(head).prs ?? []).map(node) },
      parentPrs: { nodes: (branch(base).prs ?? []).filter((p) => (p.state ?? 'OPEN') === 'OPEN').map(node) },
    };
    const data: Record<string, unknown> = { viewer: { login: 'octocat' }, repository };
    const errors: unknown[] = [];
    for (const m of query.matchAll(/\b([rx]\d+):/g)) {
      const alias = m[1] as string;
      const gone = missing.has(alias);
      const value = gone
        ? null
        : alias.startsWith('r')
          ? { __typename: 'Issue' }
          : { issueOrPullRequest: { __typename: 'PullRequest' } };
      if (alias.startsWith('r')) repository[alias] = value;
      else data[alias] = value;
      if (gone) {
        errors.push({
          type: 'NOT_FOUND',
          path: alias.startsWith('r') ? ['repository', alias] : [alias, 'issueOrPullRequest'],
          message: 'Could not resolve to an issue or pull request.',
        });
      }
    }
    return {
      exitCode: errors.length > 0 ? 1 : 0,
      stdout: http(200, errors.length > 0 ? { data, errors } : { data }),
      stderr: errors.length > 0 ? 'gh: Could not resolve to an issue or pull request.\n' : '',
    };
  };
  // FakeGh replies are static, so a predicate that remembers argv feeds a lazy reply.
  let lastPreflight: string[] = [];
  gh.on(
    (a) => {
      if (label({ argv: a, env: {}, at: 0 }) !== 'preflight') return false;
      lastPreflight = a;
      return true;
    },
    {
      get exitCode() {
        return preflightReply(lastPreflight).exitCode;
      },
      get stderr() {
        return preflightReply(lastPreflight).stderr;
      },
      get stdout() {
        return preflightReply(lastPreflight).stdout;
      },
    } as GhReply,
  );

  gh.on(
    (a) => label({ argv: a, env: {}, at: 0 }) === 'compare',
    ok({ ahead_by: o.aheadBy ?? 1, files: (o.files ?? ['src/banner.ts']).map((filename) => ({ filename })) }),
  );

  // POST: echo the request as GitHub would, or a scripted failure.
  let lastPost: Record<string, unknown> = {};
  const echo = (): string => {
    lastNumber += 1;
    return http(
      201,
      {
        number: lastNumber,
        html_url: `https://github.com/octo/demo/pull/${lastNumber}`,
        title: lastPost.title,
        body: lastPost.body,
        draft: lastPost.draft,
        head: { ref: lastPost.head, sha: branch(String(lastPost.head)).oid },
        base: { ref: lastPost.base },
      },
      'Created',
    );
  };
  const postReplies = (o.post ?? ['echo']).map((r) =>
    r === 'echo'
      ? ({
          exitCode: 0,
          stderr: '',
          get stdout() {
            return echo();
          },
        } as GhReply)
      : r,
  );
  gh.on((a, stdin) => {
    if (label({ argv: a, env: {}, at: 0 }) !== 'post') return false;
    lastPost = JSON.parse(stdin ?? '{}') as Record<string, unknown>;
    posted.push(lastPost);
    return true;
  }, postReplies);

  gh.on((a) => label({ argv: a, env: {}, at: 0 }) === 'recheck', {
    exitCode: 0,
    stderr: '',
    get stdout() {
      const list = typeof o.recheck === 'function' ? o.recheck(posted) : (o.recheck ?? []);
      return http(200, {
        data: { repository: { pullRequests: { nodes: list.map((n) => node({ body: '', ...n })) } } },
      });
    },
  } as GhReply);

  let readNumber = 0;
  gh.on(
    (a) => {
      if (label({ argv: a, env: {}, at: 0 }) !== 'readback') return false;
      readNumber = Number(/\/pulls\/(\d+)$/.exec(a.find((x) => x.startsWith('repos/')) ?? '')?.[1]);
      return true;
    },
    {
      exitCode: 0,
      stderr: '',
      get stdout() {
        const n = readNumber;
        const sent = posted.at(-1) ?? {};
        return http(200, {
          number: n,
          html_url: `https://github.com/octo/demo/pull/${n}`,
          title: o.readback?.title ?? sent.title,
          body: o.readback?.body ?? sent.body,
          draft: sent.draft,
          head: { ref: sent.head, sha: branch(String(sent.head)).oid },
          base: { ref: sent.base },
        });
      },
    } as GhReply,
  );

  return { gh, posted };
}

/** A real temp checkout root holding .github/ghx.json, for cases where the cwd is the target repo. */
export function localCheckout(config: unknown = CONFIG): string {
  const dir = mkdtempSync(join(tmpdir(), 'ghx-pr-create-'));
  mkdirSync(join(dir, '.github'));
  writeFileSync(join(dir, '.github', 'ghx.json'), JSON.stringify(config));
  return dir;
}
