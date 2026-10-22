// A scripted GitHub for the feedback-write tests (pr comment, pr review, pr resolve; 03 M11): FakeGh
// predicate rules for each call of 02 §7, recorded write bodies, and a labeller for call sequences.
// The PR is the 02 §14 worked example, #3301, authored by the viewer. Not a test file.
import { isMutating } from '../../src/gh/guard.ts';
import { FakeGh, type FakeGhCall, type GhReply } from '../helpers/fake-gh.ts';
import { httpReply, ok } from '../unit/ci/_helpers.ts';
import { HEAD, isPrCommits, isQ1, OLD_HEAD, prCommitsReply, q1Pr, q1Reply } from '../unit/pr/snapshot-fixture.ts';

export { BASE_OID, HEAD, OLD_HEAD } from '../unit/pr/snapshot-fixture.ts';

export const REF = 'powerhouse-inc/powerhouse#3301';
export const PR_URL = 'https://github.com/powerhouse-inc/powerhouse/pull/3301';

export const reply = (status: number, body: unknown, reason = 'OK'): GhReply => ({
  exitCode: status < 400 ? 0 : 1,
  stdout: httpReply(`HTTP/2.0 ${status} ${reason}`, JSON.stringify(body)),
  stderr: status < 400 ? '' : `gh: ${reason} (HTTP ${status})\n`,
});

const queryOf = (argv: readonly string[]) => argv.find((a) => a.startsWith('query=')) ?? '';
const pathOf = (argv: readonly string[]) => argv.find((a) => a.startsWith('repos/')) ?? '';

export function label(call: Pick<FakeGhCall, 'argv' | 'stdin'>): string {
  const a = call.argv;
  if (a[0] === 'api' && a[1] === 'graphql') {
    if (call.stdin?.includes('resolveReviewThread')) return call.stdin.includes('unresolve') ? 'unresolve' : 'resolve';
    if (isQ1(a)) return 'q1';
    if (isPrCommits(a)) return 'commits';
    if (queryOf(a).startsWith('query=query{')) return 'refs';
    return `graphql:${queryOf(a).slice(0, 60)}`;
  }
  const path = pathOf(a);
  const write = isMutating(a);
  if (write && /\/issues\/\d+\/comments$/.test(path)) return 'post-comment';
  if (write && /\/pulls\/\d+$/.test(path)) return 'close';
  if (/\/pulls\/\d+$/.test(path)) return 'pull';
  if (write && /\/pulls\/\d+\/reviews$/.test(path)) return 'post-review';
  if (write && /\/comments\/\d+\/replies$/.test(path)) return 'reply';
  if (path.includes('/contents/.github/ghx.json')) return 'config';
  if (/\/pulls\/\d+\/files/.test(path)) return 'files';
  if (/\/reviews\/\d+\/comments/.test(path)) return 'review-comments';
  return `other:${a.join(' ')}`;
}

export const sequence = (gh: FakeGh): string[] => gh.calls.map(label);

/**
 * A FakeGh rule whose reply is computed once per matching call (FakeGh replies are static objects, so
 * the matcher computes it and the reply's getters read it back).
 */
export function dynamic(gh: FakeGh, kind: string, fn: (call: { argv: string[]; stdin?: string }) => GhReply): void {
  let current: GhReply = { exitCode: 1, stdout: '', stderr: 'unset' };
  gh.on(
    (argv, stdin) => {
      const call = { argv, ...(stdin !== undefined ? { stdin } : {}) };
      if (label(call) !== kind) return false;
      current = fn(call);
      return true;
    },
    {
      get exitCode() {
        return current.exitCode;
      },
      get stdout() {
        return current.stdout;
      },
      get stderr() {
        return current.stderr;
      },
    } as GhReply,
  );
}

export interface WriteSceneOptions {
  /** Overrides on the Q1 pull request (state, author, comments, reviews, reviewThreads, …). */
  pr?: Record<string, unknown>;
  viewer?: string;
  /** The head GET pulls/N reports (pr review's re-check after reading the files). Default HEAD. */
  pullHead?: string;
  /** owner/repo#N → state; refs not listed don't exist. */
  refs?: Record<string, { state: string; mergedAt?: string | null }>;
  /** pulls/N/files rows (default: the worked example's two files, hunks around the finding lines). */
  files?: { filename: string; status: string; patch?: string }[];
  /** Reply to POST pulls/N/reviews (default 200 with id REVIEW_DB_ID). */
  reviewPost?: GhReply;
  /** Reply to GET reviews/{id}/comments (default: one comment per posted inline comment). */
  reviewComments?: GhReply;
  /** The PR's commits for the addressed check (default [OLD_HEAD, HEAD]). */
  commits?: string[];
  /** Reply to resolveReviewThread / unresolveReviewThread (default success). */
  threadMutation?: GhReply;
}

export const REVIEW_DB_ID = 2398765432;
export const FILES = [
  {
    filename: 'packages/reactor/src/client/reactor-client.ts',
    status: 'modified',
    patch: '@@ -1060,20 +1060,22 @@ class ReactorClient {\n context\n@@ -1100,20 +1102,20 @@\n context',
  },
  {
    filename: 'packages/shared/document-model/crypto.ts',
    status: 'modified',
    patch: '@@ -170,12 +170,14 @@\n context',
  },
  { filename: 'assets/logo.png', status: 'modified' },
];

export interface WriteScene {
  gh: FakeGh;
  /** Parsed JSON bodies of every mutating call, by label. */
  sent: Record<string, Record<string, unknown>[]>;
}

export function writeScene(o: WriteSceneOptions = {}): WriteScene {
  const gh = new FakeGh();
  const sent: WriteScene['sent'] = {};
  const record = (kind: string, stdin?: string) => {
    const body = JSON.parse(stdin ?? '{}') as Record<string, unknown>;
    sent[kind] = [...(sent[kind] ?? []), body];
    return body;
  };
  const q1 = q1Reply(q1Pr(o.pr ?? {}));
  if (o.viewer) {
    const data = JSON.parse(q1.stdout.slice(q1.stdout.indexOf('{'))) as { data: { viewer: { login: string } } };
    data.data.viewer.login = o.viewer;
    gh.on(isQ1, ok(data));
  } else {
    gh.on(isQ1, q1);
  }
  dynamic(gh, 'refs', ({ argv }) => {
    const data: Record<string, unknown> = {};
    const errors: unknown[] = [];
    for (const m of queryOf(argv).matchAll(
      /(r\d+):repository\(owner:"([^"]+)",name:"([^"]+)"\)\{pullRequest\(number:(\d+)\)/g,
    )) {
      const [, alias = '', owner, name, n] = m;
      const known = o.refs?.[`${owner}/${name}#${n}`];
      if (known) {
        data[alias] = { pullRequest: { number: Number(n), state: known.state, mergedAt: known.mergedAt ?? null } };
      } else {
        data[alias] = { pullRequest: null };
        errors.push({
          type: 'NOT_FOUND',
          path: [alias, 'pullRequest'],
          message: 'Could not resolve to a PullRequest.',
        });
      }
    }
    return { ...reply(200, errors.length ? { data, errors } : { data }), exitCode: errors.length ? 1 : 0 };
  });
  let nextId = 2400000000;
  dynamic(gh, 'post-comment', ({ stdin }) => {
    record('post-comment', stdin);
    const id = ++nextId;
    return reply(201, { id, html_url: `${PR_URL}#issuecomment-${id}` }, 'Created');
  });
  dynamic(gh, 'close', ({ stdin }) => {
    record('close', stdin);
    return reply(200, { number: 3301, state: 'closed' });
  });
  dynamic(gh, 'files', () => reply(200, o.files ?? FILES));
  dynamic(gh, 'pull', () =>
    reply(200, {
      number: 3301,
      html_url: PR_URL,
      title: 'pr',
      body: null,
      head: { ref: 'feat/x', sha: o.pullHead ?? HEAD },
      base: { ref: 'main' },
    }),
  );
  dynamic(gh, 'post-review', ({ stdin }) => {
    record('post-review', stdin);
    return (
      o.reviewPost ??
      reply(200, { id: REVIEW_DB_ID, html_url: `${PR_URL}#pullrequestreview-${REVIEW_DB_ID}`, state: 'COMMENTED' })
    );
  });
  dynamic(gh, 'review-comments', () => {
    if (o.reviewComments) return o.reviewComments;
    const posted = (sent['post-review']?.at(-1)?.comments ?? []) as { body: string }[];
    return reply(
      200,
      posted.map((c, i) => ({ id: 1834567890 + i, body: c.body, html_url: `${PR_URL}#discussion_r${1834567890 + i}` })),
    );
  });
  dynamic(gh, 'config', () => reply(404, { message: 'Not Found' }, 'Not Found'));
  dynamic(gh, 'commits', () => prCommitsReply(o.commits ?? [OLD_HEAD, HEAD]));
  dynamic(gh, 'reply', ({ stdin }) => {
    record('reply', stdin);
    const id = ++nextId;
    return reply(201, { id, html_url: `${PR_URL}#discussion_r${id}` }, 'Created');
  });
  for (const kind of ['resolve', 'unresolve']) {
    dynamic(gh, kind, ({ stdin }) => {
      record(kind, stdin);
      return (
        o.threadMutation ??
        reply(200, { data: { [`${kind}ReviewThread`]: { thread: { isResolved: kind === 'resolve' } } } })
      );
    });
  }
  return { gh, sent };
}
