// Synthetic GraphQL replies for the PR snapshot tests (03 M6.3, R03, R09) and the policy tests.
// Shapes follow Q1/Q2 (02 §4.3); values follow the 02 §14 worked example.
import { ConfigSchema } from '../../../src/config/schema.ts';
import type { PrSnapshotConfig } from '../../../src/pr/snapshot/index.ts';
import { ok, repoOf } from '../ci/_helpers.ts';

export const REPO = repoOf('powerhouse-inc/powerhouse');
export const HEAD = '9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d';
export const OLD_HEAD = '4b1e7d20c9a35f8e61d24b07c3a9e5f1d8b62c47';
export const BASE_OID = 'c0ffee1d2e3f405162738495a6b7c8d9e0f1a2b3';

export function snapshotConfig(): PrSnapshotConfig {
  const c = ConfigSchema.parse({ version: 1, components: { reactor: {} } });
  return { ci: c.ci, trust: c.trust, bots: c.bots };
}

const page = (nodes: unknown[] = []) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });

export function checkRun(name: string, conclusion: string | null, o: { id?: number; status?: string } = {}) {
  return {
    __typename: 'CheckRun',
    databaseId: o.id ?? 111978835495,
    name,
    status: o.status ?? (conclusion === null ? 'IN_PROGRESS' : 'COMPLETED'),
    conclusion,
    startedAt: '2026-10-21T16:23:30Z',
    completedAt: conclusion === null ? null : '2026-10-21T16:41:02Z',
    detailsUrl: `https://github.com/powerhouse-inc/powerhouse/actions/runs/37948190914/job/${o.id ?? 111978835495}`,
    isRequired: false,
    checkSuite: {
      app: { slug: 'github-actions' },
      workflowRun: {
        databaseId: 37948190914,
        event: 'pull_request',
        file: { path: '.github/workflows/ci.yml' },
        workflow: { databaseId: 9001, name: 'CI' },
      },
    },
  };
}

export interface PrOverrides {
  [k: string]: unknown;
}

export function q1Pr(over: PrOverrides = {}, o: { rollupOid?: string; contexts?: unknown[] } = {}) {
  const head = (over.headRefOid as string | undefined) ?? HEAD;
  return {
    number: 3301,
    url: 'https://github.com/powerhouse-inc/powerhouse/pull/3301',
    title: 'fix(reactor): bind documentId when signing actions on the write path',
    body: 'The primary write path signed actions without binding documentId.',
    state: 'OPEN',
    isDraft: false,
    createdAt: '2026-10-21T14:02:11Z',
    updatedAt: '2026-10-21T16:30:40Z',
    author: { __typename: 'User', login: 'thegoldenmule' },
    authorAssociation: 'MEMBER',
    baseRefName: 'main',
    baseRefOid: BASE_OID,
    headRefName: 'fix/reactor-bind-document-id',
    headRefOid: head,
    isCrossRepository: false,
    headRepository: { nameWithOwner: 'powerhouse-inc/powerhouse' },
    changedFiles: 8,
    additions: 142,
    deletions: 37,
    commitCount: { totalCount: 2 },
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: null,
    mergedAt: null,
    mergeCommit: null,
    commits: {
      nodes: [
        {
          commit: {
            oid: o.rollupOid ?? head,
            statusCheckRollup: {
              contexts: page(o.contexts ?? [checkRun('Test Reactor (shard 1/3)', 'SUCCESS')]),
            },
          },
        },
      ],
    },
    comments: page(),
    reviews: page(),
    reviewThreads: page(),
    timelineItems: page(),
    ...over,
  };
}

export function q1Reply(pr: unknown = q1Pr(), repo: Record<string, unknown> = {}) {
  return ok({
    data: {
      viewer: { login: 'thegoldenmule' },
      repository: {
        mergeCommitAllowed: true,
        squashMergeAllowed: true,
        rebaseMergeAllowed: false,
        deleteBranchOnMerge: false,
        viewerPermission: 'ADMIN',
        defaultBranchRef: { name: 'main' },
        pullRequest: pr,
        ...repo,
      },
    },
  });
}

export function mergeableReply(mergeable: string, o: { head?: string; state?: string; mergeState?: string } = {}) {
  return ok({
    data: {
      repository: {
        pullRequest: {
          state: o.state ?? 'OPEN',
          headRefOid: o.head ?? HEAD,
          mergeable,
          mergeStateStatus: o.mergeState ?? (mergeable === 'MERGEABLE' ? 'CLEAN' : 'UNKNOWN'),
        },
      },
    },
  });
}

export function q2Reply(repository: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return ok({ data: { repository: { __typename: 'Repository', ...repository }, ...extra } });
}

export function prCommitsReply(oids: string[], o: { head?: string; total?: number } = {}) {
  return ok({
    data: {
      repository: {
        pullRequest: {
          headRefOid: o.head ?? HEAD,
          commits: {
            totalCount: o.total ?? oids.length,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: oids.map((oid) => ({ commit: { oid } })),
          },
        },
      },
    },
  });
}

const queryOf = (argv: readonly string[]) => argv.find((a) => a.startsWith('query=')) ?? '';
export const isQ1 = (argv: string[]) => queryOf(argv).includes('viewer{login}');
export const isMergeable = (argv: string[]) => queryOf(argv).includes('{state headRefOid mergeable mergeStateStatus}');
export const isQ2 = (argv: string[]) => queryOf(argv).includes('{repository(owner:$owner,name:$name){__typename');
export const isPrCommits = (argv: string[]) => queryOf(argv).includes('commits(first:100,after:$after){totalCount');

// ── The merge queue (GitHub rulesets' "Require merge queue") ────────────────
export const PR_NODE_ID = 'PR_kwDOAbCdEf5gHiJk';
export const QUEUE_URL = 'https://github.com/powerhouse-inc/powerhouse/queue/main';
export const ENQUEUED_AT = '2026-10-22T09:15:01Z';

export interface QueueEntryFixture {
  state: string;
  position: number;
  enqueuedAt?: string | null;
}

const entryJson = (e: QueueEntryFixture | null | undefined) => (e ? { enqueuedAt: ENQUEUED_AT, ...e } : null);

/** The Q1 fields of a PR whose base branch has a merge queue (REBASE unless `method` says otherwise). */
export function queueFields(o: { method?: string | null; entry?: QueueEntryFixture | null } = {}) {
  return {
    id: PR_NODE_ID,
    isMergeQueueEnabled: true,
    isInMergeQueue: !!o.entry,
    mergeQueueEntry: entryJson(o.entry),
    mergeQueue: { url: QUEUE_URL, configuration: { mergeMethod: o.method === undefined ? 'REBASE' : o.method } },
  };
}

/** The enqueuePullRequest mutation: GraphQL over stdin (`--input -`), unlike every read. */
export const isEnqueue = (argv: string[], stdin?: string) =>
  argv.includes('graphql') && argv.includes('--input') && (stdin === undefined || stdin.includes('enqueuePullRequest'));
export const isQueueRead = (argv: string[]) => queryOf(argv).includes('REMOVED_FROM_MERGE_QUEUE_EVENT');

export function enqueueReply(entry: QueueEntryFixture | null = { state: 'QUEUED', position: 1 }) {
  return ok({ data: { enqueuePullRequest: { mergeQueueEntry: entryJson(entry) } } });
}

/** A GraphQL refusal as `gh api graphql --include` reports it: HTTP 200, errors in the body, exit 1. */
export function graphqlRefusal(message: string, type = 'UNPROCESSABLE') {
  return {
    ...ok({ data: { enqueuePullRequest: null }, errors: [{ type, path: ['enqueuePullRequest'], message }] }),
    exitCode: 1,
    stderr: `gh: ${message}\n`,
  };
}

/** The queue read (src/pr/merge/queue.ts QUEUE_QUERY): the PR as the merge queue wait sees it. */
export function queueReadReply(
  o: {
    state?: string;
    head?: string;
    entry?: QueueEntryFixture | null;
    mergeCommit?: string | null;
    mergedAt?: string | null;
    removed?: { createdAt: string; reason?: string | null; actor?: { login: string } | null } | null;
  } = {},
) {
  return ok({
    data: {
      repository: {
        pullRequest: {
          state: o.state ?? 'OPEN',
          headRefOid: o.head ?? HEAD,
          mergedAt: o.mergedAt ?? null,
          mergeCommit: o.mergeCommit ? { oid: o.mergeCommit } : null,
          isInMergeQueue: !!o.entry,
          mergeQueueEntry: entryJson(o.entry),
          timelineItems: {
            nodes: o.removed ? [{ __typename: 'RemovedFromMergeQueueEvent', ...o.removed }] : [],
          },
        },
      },
    },
  });
}
