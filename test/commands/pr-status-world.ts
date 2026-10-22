// The 02 §14 worked example (#3301 after settle) as FakeGh rules, for the pr status and pr feedback tests:
// config, Q1 (body, three feedback sources, a settled rollup with one red check), Q2, the PR commits, the
// failing job and its log, and the main run whose same-named job fails the same test. Tests override single
// replies with fake.on() after install(); later rules win.
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeClock } from '../helpers/fake-clock.ts';
import { FakeGh, type GhReply } from '../helpers/fake-gh.ts';
import { runInProcess, scratchDir } from '../helpers/harness.ts';
import { readJson } from '../unit/feedback/_fixture.ts';
import {
  checkRun,
  HEAD,
  isMergeable,
  isPrCommits,
  isQ1,
  isQ2,
  mergeableReply,
  OLD_HEAD,
  prCommitsReply,
  q1Pr,
  q1Reply,
  q2Reply,
} from '../unit/pr/snapshot-fixture.ts';
import { jobRow, logReply, notFoundJson, okJson, type WJob } from './ci-why-world.ts';

export const SLUG = 'powerhouse-inc/powerhouse';
export const REF = `${SLUG}#3301`;
/** 02 §14.5's fetchedAt: long after the checks settled, so the read is quiet (no expected-set REST calls). */
export const NOW = Date.UTC(2026, 9, 22, 9, 15, 0);
export const FAILING_JOB = 111978835495;
export const PR_RUN = 37948190914;
export const MAIN_RUN = 37950011223;
export const MAIN_JOB = 111970000001;
export const MAIN_SHA = 'c0ffee1d2e3f405162738495a6b7c8d9e0f1a2b3';
export const SHARED_TEST = 'reactor-api > should converge after reshuffle rebroadcast between two connect reactors';

export const CONFIG = {
  version: 1,
  components: Object.fromEntries(
    ['reactor', 'reactor-api', 'shared', 'connect', 'switchboard', 'codegen', 'vetra', 'docs', 'ci'].map((c) => [
      c,
      {},
    ]),
  ),
  ci: { ignore: ['notify-discord', 'CI duration watch'] },
  merge: { method: 'merge' },
};

/** A vitest job log whose one failure is SHARED_TEST (the `×` detail form, as in 02 §14.4's excerpt). */
export function sharedLog(test = SHARED_TEST): string {
  const ts = '2026-10-21T16:40:58.0000000Z';
  return [
    `${ts} ##[group]Run tests`,
    `${ts} pnpm vitest run`,
    `${ts} ##[endgroup]`,
    `${ts}  RUN  v3.2.4 /home/runner/work/powerhouse/powerhouse`,
    `${ts}    × ${test} 20056ms`,
    `${ts}      AssertionError: expected 3 to equal 4`,
    `${ts}  Test Files  1 failed | 41 passed (42)`,
    `${ts} ##[error]Process completed with exit code 1.`,
    '',
  ].join('\n');
}

const page = (nodes: unknown[]) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });

export const BODY = readFileSync(
  join(import.meta.dirname, '..', 'fixtures', 'render', 'worked-example-3301.body.md'),
  'utf8',
);

/** 21 passing checks, the failing shard, one skipped and the two ignored noise checks. */
export function contexts(): unknown[] {
  return [
    ...Array.from({ length: 21 }, (_, i) => checkRun(`Check ${i + 1}`, 'SUCCESS', { id: 111978835000 + i })),
    checkRun('Test Reactor (shard 1/3)', 'FAILURE', { id: FAILING_JOB }),
    checkRun('Docs preview', 'SKIPPED', { id: 111978835100 }),
    checkRun('notify-discord', 'SUCCESS', { id: 111978835101 }),
    checkRun('CI duration watch', 'SUCCESS', { id: 111978835102 }),
  ];
}

export function workedPr(over: Record<string, unknown> = {}, o: { contexts?: unknown[] } = {}) {
  const input = readJson('worked-example-3301.input.json') as {
    issueComments: unknown[];
    reviews: unknown[];
    reviewThreads: { comments: { nodes: unknown[] } }[];
  };
  return q1Pr(
    {
      body: BODY,
      mergeStateStatus: 'UNSTABLE',
      comments: page(input.issueComments),
      reviews: page(input.reviews),
      reviewThreads: page(input.reviewThreads.map((t, i) => ({ ...t, id: `T${i}`, comments: page(t.comments.nodes) }))),
      ...over,
    },
    { contexts: o.contexts ?? contexts() },
  );
}

const pathOf = (argv: readonly string[]): string | undefined => argv.find((a) => a.startsWith('repos/'))?.split('?')[0];
export const at = (p: string) => (argv: string[]) => pathOf(argv) === `repos/${SLUG}${p}`;

function contents(config: unknown): GhReply {
  return okJson({
    type: 'file',
    encoding: 'base64',
    content: Buffer.from(JSON.stringify(config)).toString('base64'),
    url: `https://api.github.com/repos/${SLUG}/contents/.github/ghx.json?ref=main`,
  });
}

const world = { slug: SLUG, headSha: HEAD };
const prJob: WJob = {
  id: FAILING_JOB,
  runId: PR_RUN,
  name: 'Test Reactor (shard 1/3)',
  conclusion: 'failure',
  workflowId: 9001,
};
const mainJob: WJob = { ...prJob, id: MAIN_JOB, runId: MAIN_RUN, headSha: MAIN_SHA };

export interface InstallOptions {
  config?: unknown | null;
  pr?: unknown;
}

/** Install the worked example; `config: null` answers the config read with 404. */
export function install(fake: FakeGh = new FakeGh(), o: InstallOptions = {}): FakeGh {
  const config = o.config === undefined ? CONFIG : o.config;
  fake.on(at('/contents/.github/ghx.json'), config === null ? notFoundJson() : contents(config));
  fake.on(isQ1, q1Reply(o.pr ?? workedPr()));
  fake.on(isMergeable, mergeableReply('MERGEABLE', { mergeState: 'UNSTABLE' }));
  fake.on(isQ2, q2Reply({ children: { nodes: [] } }));
  fake.on(isPrCommits, prCommitsReply([OLD_HEAD, HEAD]));
  fake.on(at(`/actions/jobs/${FAILING_JOB}`), okJson(jobRow(world, prJob)));
  fake.on(at(`/actions/jobs/${FAILING_JOB}/logs`), logReply({ text: sharedLog() }));
  fake.on(
    at('/actions/workflows/9001/runs'),
    okJson({
      total_count: 1,
      workflow_runs: [
        {
          id: MAIN_RUN,
          head_sha: MAIN_SHA,
          head_branch: 'main',
          event: 'push',
          status: 'completed',
          conclusion: 'failure',
          workflow_id: 9001,
          path: '.github/workflows/ci.yml',
          run_attempt: 1,
          created_at: '2026-10-21T15:58:10Z',
          run_started_at: '2026-10-21T15:58:19Z',
        },
      ],
    }),
  );
  fake.on(at(`/actions/runs/${MAIN_RUN}/jobs`), okJson({ total_count: 1, jobs: [jobRow(world, mainJob)] }));
  fake.on(at(`/actions/jobs/${MAIN_JOB}/logs`), logReply({ text: sharedLog() }));
  return fake;
}

/** Run `ghx <argv>` against `fake` at NOW (or `clock`), with its own artifact dir. */
export async function run(argv: string[], fake: FakeGh, o: { clock?: FakeClock } = {}) {
  const artifacts = mkdtempSync(join(scratchDir(), 'pr-status-'));
  const r = await runInProcess(argv, {
    gh: fake,
    clock: o.clock ?? new FakeClock(NOW),
    env: { GHX_ARTIFACT_DIR: artifacts },
  });
  return { ...r, artifacts };
}
