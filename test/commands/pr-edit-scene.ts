// A scripted GitHub for `pr edit` tests (02 §3 gh calls): the pr-create scene (config, preflight, compare)
// plus PR #12 as server state that the snapshot, PATCH, draft mutations and read-back share. Not a test
// file (no .test.ts suffix).
import { DEFAULT_FOOTER } from '../../src/config/sections/render.ts';
import { isMutating } from '../../src/gh/guard.ts';
import { renderPrBody, toPrBlock } from '../../src/render/pr-body.ts';
import type { FakeGh, FakeGhCall, GhReply } from '../helpers/fake-gh.ts';
import { HEAD_OID, http, INPUT, type SceneOptions, scene } from './pr-create-scene.ts';

export const PR_NUMBER = 12;
export const PR_NODE_ID = 'PR_kwDOdemo12';
export const BLOCK_ID = 'p_abc234';
export const UPDATED_AT = '2026-10-22T10:00:00Z';
export const RENDER = { mode: 'trailer', footer: DEFAULT_FOOTER } as const;

/** The block content of the PR as pr create made it. */
export const { base: _base, head: _head, ...CONTENT } = INPUT;
export type Content = typeof CONTENT & Record<string, unknown>;

/** The body ghx renders for `content` at `rev`, as pr create (rev 1) or an earlier pr edit wrote it. */
export function bodyOf(content: Record<string, unknown> = CONTENT, rev = 1, id = BLOCK_ID): string {
  return renderPrBody(toPrBlock(content as never, { id, rev }), RENDER);
}

export interface PrState {
  state: string;
  isDraft: boolean;
  title: string;
  body: string;
  updatedAt: string;
  baseRefName: string;
  headRefName: string;
  /** The PR author; the preflight viewer is octocat. */
  author: { login: string } | null;
}

export interface EditSceneOptions extends SceneOptions {
  pr?: Partial<PrState>;
  /** Overrides on the second snapshot (the re-read just before the PATCH). */
  reread?: Partial<PrState>;
  /** Open PRs whose base is this PR's head. */
  children?: number[];
  /** Replies to the PATCH, in order. Default: apply it to the state and echo the PR. */
  patch?: GhReply[];
  /** Overrides on the read-back. */
  stored?: Partial<{ title: string; body: string; base: string; draft: boolean }>;
}

export interface EditScene {
  gh: FakeGh;
  /** Bodies sent to the PATCH, parsed. */
  patched: Record<string, unknown>[];
  /** The draft mutations sent, in order. */
  drafts: ('ready' | 'to-draft')[];
  state: PrState;
}

function fieldOf(argv: readonly string[], key: string): string {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === '-f' && argv[i + 1]?.startsWith(`${key}=`)) return argv[i + 1]?.slice(key.length + 1) ?? '';
  }
  return '';
}

export function editLabel(call: Pick<FakeGhCall, 'argv' | 'stdin'>): string {
  const a = call.argv;
  if (a[0] === 'api' && a[1] === 'graphql') {
    const q = fieldOf(a, 'query') || String((JSON.parse(call.stdin ?? '{}') as { query?: string }).query ?? '');
    if (q.includes('markPullRequestReadyForReview')) return 'ready';
    if (q.includes('convertPullRequestToDraft')) return 'to-draft';
    if (q.includes('pullRequest(number:')) return 'snapshot';
    if (q.includes('viewer{login}')) return 'preflight';
    if (q.includes('baseRefName:$head')) return 'children';
    return `graphql:${q.slice(0, 40)}`;
  }
  const path = a.find((x) => x.startsWith('repos/')) ?? '';
  if (path.endsWith('/contents/.github/ghx.json')) return 'config';
  if (path.includes('/compare/')) return 'compare';
  if (/\/pulls\/\d+$/.test(path)) return isMutating(a) ? 'patch' : 'readback';
  return `other:${a.join(' ')}`;
}

export function editSequence(gh: FakeGh): string[] {
  return gh.calls.map(editLabel);
}

const pullJson = (s: PrState) => ({
  number: PR_NUMBER,
  html_url: `https://github.com/octo/demo/pull/${PR_NUMBER}`,
  title: s.title,
  body: s.body,
  draft: s.isDraft,
  head: { ref: s.headRefName, sha: HEAD_OID },
  base: { ref: s.baseRefName },
});

export function editScene(o: EditSceneOptions = {}): EditScene {
  const { gh } = scene(o);
  const state: PrState = {
    state: 'OPEN',
    isDraft: false,
    title: CONTENT.title,
    body: bodyOf(),
    updatedAt: UPDATED_AT,
    baseRefName: 'main',
    headRefName: INPUT.head,
    author: { login: 'octocat' },
    ...o.pr,
  };
  const patched: Record<string, unknown>[] = [];
  const drafts: ('ready' | 'to-draft')[] = [];
  const is = (label: string) => (argv: string[], stdin?: string) =>
    editLabel({ argv, ...(stdin !== undefined ? { stdin } : {}) }) === label;
  let snapshots = 0;
  let edits = 0;
  const touch = () => {
    edits += 1;
    state.updatedAt = `2026-10-22T10:0${edits}:00Z`;
  };

  gh.on(is('snapshot'), {
    exitCode: 0,
    stderr: '',
    get stdout() {
      snapshots += 1;
      const s = snapshots >= 2 ? { ...state, ...o.reread } : state;
      return http(200, {
        data: {
          repository: {
            pullRequest: {
              id: PR_NODE_ID,
              number: PR_NUMBER,
              url: `https://github.com/octo/demo/pull/${PR_NUMBER}`,
              headRefOid: HEAD_OID,
              ...s,
            },
          },
        },
      });
    },
  } as GhReply);

  gh.on(is('children'), {
    exitCode: 0,
    stderr: '',
    stdout: http(200, {
      data: { repository: { pullRequests: { nodes: (o.children ?? []).map((number) => ({ number })) } } },
    }),
  });

  const applyPatch: GhReply = {
    exitCode: 0,
    stderr: '',
    get stdout() {
      const p = patched.at(-1) ?? {};
      if (typeof p.title === 'string') state.title = p.title;
      if (typeof p.body === 'string') state.body = p.body;
      if (typeof p.base === 'string') state.baseRefName = p.base;
      touch();
      return http(200, pullJson(state));
    },
  } as GhReply;
  gh.on((argv, stdin) => {
    if (!is('patch')(argv, stdin)) return false;
    patched.push(JSON.parse(stdin ?? '{}') as Record<string, unknown>);
    return true;
  }, o.patch ?? [applyPatch]);

  for (const kind of ['ready', 'to-draft'] as const) {
    gh.on(
      (argv, stdin) => {
        if (!is(kind)(argv, stdin)) return false;
        drafts.push(kind);
        state.isDraft = kind === 'to-draft';
        touch();
        return true;
      },
      {
        exitCode: 0,
        stderr: '',
        get stdout() {
          const field = kind === 'ready' ? 'markPullRequestReadyForReview' : 'convertPullRequestToDraft';
          return http(200, { data: { [field]: { pullRequest: { isDraft: state.isDraft } } } });
        },
      } as GhReply,
    );
  }

  gh.on(is('readback'), {
    exitCode: 0,
    stderr: '',
    get stdout() {
      const j = pullJson(state);
      const s = o.stored ?? {};
      return http(200, {
        ...j,
        title: s.title ?? j.title,
        body: s.body ?? j.body,
        draft: s.draft ?? j.draft,
        base: { ref: s.base ?? j.base.ref },
      });
    },
  } as GhReply);

  return { gh, patched, drafts, state };
}
