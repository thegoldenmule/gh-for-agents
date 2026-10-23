// Builders for the policy table tests: a mergeable, green, own PR with no feedback, plus small makers for
// the parts each row varies.
import { ConfigSchema, type GhxConfigInput } from '../../../src/config/schema.ts';
import type { Finding, Precondition, Review } from '../../../src/feedback/schemas.ts';
import { evaluateMerge, type MergePolicyInput, type PolicySnapshot } from '../../../src/policy/merge.ts';
import type { CiSummary, FailingCheck, SameOnMain } from '../../../src/schemas/ci.ts';

export const HEAD = '9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d';
export const MAIN_SHA = 'c0ffee1d2e3f405162738495a6b7c8d9e0f1a2b3';
export const NOW = Date.parse('2026-10-22T09:15:00Z');
const ME = { login: 'thegoldenmule', isViewer: true, isBot: false, association: 'MEMBER' as const };

export function snapshot(over: Partial<PolicySnapshot> = {}): PolicySnapshot {
  return {
    repo: { host: 'github.com', owner: 'powerhouse-inc', name: 'powerhouse' },
    ref: 'powerhouse-inc/powerhouse#3301',
    number: 3301,
    title: 'fix(reactor): bind documentId when signing actions on the write path',
    body: 'The primary write path signed actions without binding documentId.',
    author: ME,
    state: 'OPEN',
    draft: false,
    base: { ref: 'main', sha: MAIN_SHA, isDefault: true },
    head: { ref: 'fix/reactor-bind-document-id', sha: HEAD, repo: 'powerhouse-inc/powerhouse', crossRepository: false },
    merge: {
      mergeable: 'MERGEABLE',
      settled: true,
      mergeStateStatus: 'CLEAN',
      reviewDecision: null,
      mergedAt: null,
      mergeCommit: null,
      retries: 0,
    },
    viewer: { login: 'thegoldenmule', permission: 'ADMIN' },
    repoSettings: {
      mergeCommitAllowed: true,
      squashMergeAllowed: true,
      rebaseMergeAllowed: true,
      deleteBranchOnMerge: false,
    },
    meta: { status: 'absent', warnings: [] },
    stack: { parent: null, declaredParent: null, children: [], baseChanges: [] },
    ...over,
  };
}

export const merge = (over: Partial<PolicySnapshot['merge']>) => ({ ...snapshot().merge, ...over });

export function ci(over: Partial<CiSummary> = {}): CiSummary {
  return {
    headSha: HEAD,
    forHeadSha: true,
    state: 'green',
    phase: 'settled',
    counts: { pass: 3, fail: 0, pending: 0, skipped: 0, cancelled: 0, neutral: 0, ignored: 0 },
    failing: [],
    pending: [],
    ignored: [],
    expectedMissing: [],
    eta: null,
    next: [],
    ...over,
  };
}

export function sameOnMain(verdict: SameOnMain['verdict']): SameOnMain {
  return {
    verdict,
    mainBranch: 'main',
    mainRunId: 37950011223,
    mainSha: MAIN_SHA,
    mainRunAt: '2026-10-21T15:58:19Z',
    prTests: ['reactor-api > converges'],
    mainTests: verdict === 'same-tests' ? ['reactor-api > converges'] : [],
    newTests: [],
  };
}

export function failing(name: string, verdict: SameOnMain['verdict'] | null): FailingCheck {
  return {
    name,
    workflow: 'CI',
    kind: 'actions',
    bucket: 'fail',
    status: 'completed',
    conclusion: 'failure',
    required: false,
    runId: 37948190914,
    jobId: 111978835495,
    attempt: 1,
    url: 'https://github.com/powerhouse-inc/powerhouse/actions/runs/37948190914/job/111978835495',
    startedAt: '2026-10-21T16:23:30Z',
    completedAt: '2026-10-21T16:41:02Z',
    sameOnMain: verdict === null ? null : sameOnMain(verdict),
    flake: null,
  };
}

export const red = (...f: FailingCheck[]) =>
  ci({ state: 'red', failing: f, counts: { ...ci().counts, fail: f.length } });

export function finding(
  id: string,
  severity: string,
  status: Finding['status'] = 'open',
  verified: boolean | null = null,
): Finding {
  return {
    id,
    reviewId: 'r_7tq2wd',
    severity,
    path: 'packages/reactor/src/client/reactor-client.ts',
    line: 1071,
    endLine: null,
    alsoAt: [],
    title: 't',
    body: 'b',
    truncated: false,
    inline: true,
    commit: HEAD,
    outdated: false,
    status,
    statusEvent:
      status === 'open'
        ? null
        : {
            id: 'c_w5j1ve',
            by: 'thegoldenmule',
            at: '2026-10-21T16:22:45Z',
            commit: HEAD,
            note: null,
            verified,
            url: 'u',
          },
    url: 'u',
  };
}

export function review(login: string, githubState: Review['githubState'], at: string, isBot = false): Review {
  return {
    id: `rv:${at.length}${login.length}`,
    structured: false,
    author: { login, isViewer: false, isBot, association: 'MEMBER' },
    verdict: null,
    githubState,
    verdictDowngraded: false,
    submittedAt: at,
    commit: HEAD,
    outdated: false,
    summary: '',
    truncated: false,
    findingIds: [],
    url: `https://github.com/powerhouse-inc/powerhouse/pull/3301#pullrequestreview-${at.length}`,
  };
}

export function precondition(id: string, status: Precondition['status']): Precondition {
  return {
    id,
    condition: { type: 'pr-merged', ref: '#3184' },
    status,
    evidence: status === 'met' ? '#3184 merged' : '#3184 is open',
    declaredBy: 'thegoldenmule',
    declaredAt: '2026-10-21T15:00:00Z',
    url: 'u',
    override: null,
  };
}

export function feedback(
  o: { findings?: Finding[]; reviews?: Review[]; preconditions?: Precondition[]; threads?: number } = {},
): MergePolicyInput['feedback'] {
  const findings = o.findings ?? [];
  return {
    feedback: {
      reviews: o.reviews ?? [],
      findings,
      comments: [],
      bots: [],
      counts: {
        reviews: o.reviews?.length ?? 0,
        findingsTotal: findings.length,
        findingsOpen: findings.filter((f) => f.status === 'open').length,
        comments: 0,
        bots: 0,
        unresolvedHumanThreads: o.threads ?? 0,
        omitted: 0,
      },
    },
    preconditions: o.preconditions ?? [],
  };
}

export function config(over: Partial<GhxConfigInput> = {}): MergePolicyInput['config'] {
  return ConfigSchema.parse({ version: 1, components: { reactor: {} }, ...over });
}

export type EvalOver = Partial<Omit<MergePolicyInput, 'snapshot'>> & { snapshot?: Partial<PolicySnapshot> };

export function evaluate(over: EvalOver = {}) {
  const { snapshot: s, ...rest } = over;
  return evaluateMerge({ snapshot: snapshot(s), ci: ci(), feedback: feedback(), config: config(), now: NOW, ...rest });
}
