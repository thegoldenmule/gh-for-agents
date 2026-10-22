// The merge policy engine (03 §5.1 "Policy engine"): one row per 02 §8.2 rule, each with a fail and a pass
// case, then the cross-cutting rules (exit class, shared red, fail closed, warnings, scope, overrides).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ERROR_CODES } from '../../../src/core/errors.ts';
import { CI_GATE_CODES, MERGE_CHECKS } from '../../../src/policy/checks.ts';
import { mergeBlockedError, mergeStateOf } from '../../../src/policy/merge.ts';
import { parseOverrides } from '../../../src/policy/overrides.ts';
import * as policySchemas from '../../../src/policy/schemas.ts';
import { MergePlan, MergeState } from '../../../src/policy/schemas.ts';
import { EXIT } from '../../contract/exit-table.ts';
import { assertExportable } from '../schemas/_exportable.ts';
import {
  ci,
  config,
  type EvalOver,
  evaluate,
  failing,
  feedback,
  finding,
  merge,
  NOW,
  precondition,
  red,
  review,
  snapshot,
} from './_helpers.ts';

interface Row {
  code: string;
  fail: EvalOver;
  pass: EvalOver;
}

const ROWS: Row[] = [
  { code: 'PR_NOT_OPEN', fail: { snapshot: { state: 'CLOSED' } }, pass: {} },
  { code: 'PR_DRAFT', fail: { snapshot: { draft: true } }, pass: {} },
  { code: 'HEAD_MOVED', fail: { request: { expectHead: '4b1e7d2' } }, pass: { request: { expectHead: '9f2c4e1' } } },
  {
    code: 'AUTHOR_NOT_VIEWER',
    fail: { snapshot: { author: { login: 'other-dev', isViewer: false, isBot: false, association: 'MEMBER' } } },
    pass: {
      snapshot: { author: { login: 'other-dev', isViewer: false, isBot: false, association: 'MEMBER' } },
      config: config({ merge: { requireOwnPr: false } }),
    },
  },
  {
    code: 'METHOD_NOT_ALLOWED',
    fail: { request: { method: 'squash' } },
    pass: { request: { method: 'squash' }, config: config({ merge: { allowedMethods: ['merge', 'squash'] } }) },
  },
  {
    code: 'MERGEABLE_UNKNOWN',
    fail: { snapshot: { merge: merge({ mergeable: 'UNKNOWN', settled: false }) } },
    pass: {},
  },
  {
    code: 'MERGE_CONFLICT',
    fail: { snapshot: { merge: merge({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }) } },
    pass: {},
  },
  { code: 'BEHIND_BASE', fail: { snapshot: { merge: merge({ mergeStateStatus: 'BEHIND' }) } }, pass: {} },
  {
    code: 'BLOCKED_BY_PROTECTION',
    fail: { snapshot: { merge: merge({ mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }) } },
    pass: {
      snapshot: { merge: merge({ mergeStateStatus: 'BLOCKED' }) },
      ci: ci({
        state: 'pending',
        phase: 'running',
        pending: [{ name: 'test', workflow: 'CI', status: 'in_progress', required: true }],
      }),
    },
  },
  {
    code: 'CI_PENDING',
    fail: {
      ci: ci({
        state: 'pending',
        phase: 'running',
        pending: [{ name: 'test', workflow: 'CI', status: 'queued', required: false }],
      }),
    },
    pass: {
      // A baseline check aged out of `missing` (expectedState … agedOut) no longer blocks.
      ci: ci({ expectedMissing: [] }),
    },
  },
  {
    code: 'CI_NO_CHECKS',
    fail: { ci: ci({ state: 'no-checks', phase: 'registering' }) },
    pass: { ci: ci({ state: 'no-checks', phase: 'registering' }), ciFacts: { workflowsTotal: 0 } },
  },
  { code: 'CI_RED', fail: { ci: red(failing('test', 'different')) }, pass: { ci: red(failing('test', 'same-tests')) } },
  {
    code: 'KEY_STEP_SKIPPED',
    fail: { ciFacts: { keyStepsSkipped: [{ job: 'test', step: 'Run tests' }] } },
    pass: { ciFacts: { keyStepsSkipped: [] } },
  },
  {
    code: 'CHANGES_REQUESTED',
    fail: { feedback: feedback({ reviews: [review('maria-dev', 'CHANGES_REQUESTED', '2026-10-21T15:00:00Z')] }) },
    pass: {
      feedback: feedback({
        reviews: [
          review('maria-dev', 'CHANGES_REQUESTED', '2026-10-21T15:00:00Z'),
          review('maria-dev', 'APPROVED', '2026-10-21T16:00:00Z'),
        ],
      }),
    },
  },
  {
    code: 'FINDINGS_OPEN',
    fail: { feedback: feedback({ findings: [finding('f_h4x8pz', 'high')] }) },
    pass: { feedback: feedback({ findings: [finding('f_h4x8pz', 'high', 'addressed', true)] }) },
  },
  {
    code: 'FEEDBACK_TRUNCATED',
    fail: { snapshot: { feedbackTruncated: true } },
    pass: { snapshot: { feedbackTruncated: false } },
  },
  {
    code: 'PRECONDITION_UNMET',
    fail: { feedback: feedback({ preconditions: [precondition('c_p7q8r9', 'unmet')] }) },
    pass: { feedback: feedback({ preconditions: [precondition('c_p7q8r9', 'met')] }) },
  },
];

test('every 02 §8.2 row has a table case, in table order', () => {
  assert.deepEqual(
    ROWS.map((r) => r.code),
    MERGE_CHECKS.map((c) => c.code),
  );
});

for (const row of ROWS) {
  const spec = MERGE_CHECKS.find((c) => c.code === row.code);
  test(`${row.code}: fails as a ${spec?.class} blocker (overridable: ${spec?.overridable}); passes when the rule holds`, () => {
    const bad = evaluate(row.fail);
    assert.equal(bad.plan.checks.find((c) => c.code === row.code)?.status, 'fail', 'fail case');
    const blocker = bad.plan.blockers.find((b) => b.code === row.code);
    assert.ok(blocker, `${row.code} is a blocker`);
    assert.equal(blocker.overridable, spec?.overridable);
    assert.equal(bad.ready, false);
    if (bad.plan.blockers.length === 1) assert.equal(bad.exitClass, spec?.class);

    const good = evaluate(row.pass);
    const status = good.plan.checks.find((c) => c.code === row.code)?.status;
    assert.ok(status === 'pass' || status === 'skipped' || status === 'waived', `pass case gave ${status}`);
    assert.ok(!good.plan.blockers.some((b) => b.code === row.code));
  });
}

test('the base case is mergeable and the plan validates; the request pins the head', () => {
  const e = evaluate();
  assert.equal(e.ready, true);
  assert.equal(e.exitClass, null);
  MergePlan.parse(e.plan);
  assert.deepEqual(e.plan.request, {
    method: 'PUT',
    path: 'repos/powerhouse-inc/powerhouse/pulls/3301/merge',
    body: { sha: snapshot().head.sha, merge_method: 'merge' },
  });
  assert.equal(assertExportable(policySchemas), 5);
});

test('exit class: all state-class blockers give 9; any policy-class blocker gives 6', () => {
  const state = evaluate({ snapshot: { draft: true }, ci: ci({ state: 'no-checks', phase: 'registering' }) });
  assert.equal(state.exitClass, 'state');
  assert.equal(ERROR_CODES.MERGE_BLOCKED.exit({ exitClass: state.exitClass }), EXIT.STATE);
  const policy = evaluate({
    snapshot: { draft: true },
    feedback: feedback({ findings: [finding('f_h4x8pz', 'high')] }),
  });
  assert.equal(policy.exitClass, 'policy');
  const err = mergeBlockedError(policy);
  assert.equal(err.code, 'MERGE_BLOCKED');
  assert.equal(err.message, '2 blockers: PR_DRAFT, FINDINGS_OPEN.');
  assert.equal(ERROR_CODES.MERGE_BLOCKED.exit(err.details), EXIT.POLICY);
  assert.match(err.hint ?? '', /ghx pr resolve/);
});

test('CI_NO_CHECKS passes automatically with ci.none, unless a required check is expected', () => {
  const none = { ...config(), ci: { ...config().ci, none: true } };
  const noChecks = ci({ state: 'no-checks', phase: 'registering' });
  assert.equal(evaluate({ ci: noChecks, config: none }).ready, true);
  const expected = ci({
    state: 'no-checks',
    phase: 'registering',
    expectedMissing: [{ name: 'build', workflow: 'CI', source: 'required', state: 'missing' }],
  });
  const e = evaluate({ ci: expected, config: none });
  assert.deepEqual(
    e.plan.blockers.map((b) => b.code),
    ['CI_PENDING', 'CI_NO_CHECKS'],
  );
});

test('CI_RED is waived only for same-tests or same-step, and never with merge.sharedRed off', () => {
  for (const v of ['same-tests', 'same-step'] as const) {
    const e = evaluate({ ci: red(failing('Test Reactor (shard 1/3)', v)) });
    assert.equal(e.ready, true, v);
    assert.deepEqual(
      e.plan.waivers.map((w) => w.code),
      ['CI_RED'],
    );
  }
  for (const v of ['different', 'main-green', 'no-main-run', 'not-compared', null] as const) {
    assert.ok(
      evaluate({ ci: red(failing('t', v)) }).plan.blockers.some((b) => b.code === 'CI_RED'),
      String(v),
    );
  }
  const mixed = evaluate({ ci: red(failing('a', 'same-tests'), failing('b', 'different')) });
  assert.ok(mixed.plan.blockers.some((b) => b.code === 'CI_RED'));
  const off = evaluate({ ci: red(failing('a', 'same-tests')), config: config({ merge: { sharedRed: 'off' } }) });
  assert.ok(off.plan.blockers.some((b) => b.code === 'CI_RED'));
  assert.equal(
    evaluate({ ci: red(failing('a', 'same-step')), config: config({ merge: { sharedRed: 'step' } }) }).ready,
    true,
  );
});

test('02 §14.5: the worked example is ready with a CI_RED waiver and a low-finding warning', () => {
  const e = evaluate({
    snapshot: { merge: merge({ mergeStateStatus: 'UNSTABLE' }) },
    ci: red(failing('Test Reactor (shard 1/3)', 'same-tests')),
    feedback: feedback({ findings: [finding('f_h4x8pz', 'high', 'addressed', true), finding('f_n2c6rv', 'low')] }),
  });
  const state = mergeStateOf(snapshot({ merge: merge({ mergeStateStatus: 'UNSTABLE' }) }), e);
  MergeState.parse(state);
  assert.equal(state.ready, true);
  assert.deepEqual(state.blockers, []);
  assert.deepEqual(state.waivers, [
    {
      code: 'CI_RED',
      message: 'Test Reactor (shard 1/3) fails with the same test on main run 37950011223 (c0ffee1).',
      overridable: true,
    },
  ]);
  assert.deepEqual(state.warnings, [
    {
      code: 'FINDINGS_OPEN',
      message: '1 open low finding (f_n2c6rv); below merge.blockOnSeverity (high).',
      overridable: true,
    },
  ]);
  assert.equal(e.plan.checks.find((c) => c.code === 'FINDINGS_OPEN')?.status, 'warn');
});

test('fail closed: unknown severity counts as high; unknown preconditions block', () => {
  assert.ok(
    evaluate({ feedback: feedback({ findings: [finding('f_a', 'critical')] }) }).plan.blockers.some(
      (b) => b.code === 'FINDINGS_OPEN',
    ),
  );
  assert.ok(
    evaluate({ feedback: feedback({ preconditions: [precondition('c_a', 'unknown')] }) }).plan.blockers.some(
      (b) => b.code === 'PRECONDITION_UNMET',
    ),
  );
  assert.equal(evaluate({ feedback: feedback({ preconditions: [precondition('c_a', 'withdrawn')] }) }).ready, true);
});

test('fail closed (04): an addressed blocking finding with an unverified commit counts as open; below the bar it does not', () => {
  const unverified = evaluate({ feedback: feedback({ findings: [finding('f_h4x8pz', 'high', 'addressed', null)] }) });
  const b = unverified.plan.blockers.find((x) => x.code === 'FINDINGS_OPEN');
  assert.match(b?.message ?? '', /f_h4x8pz \(high\) is marked addressed in 9f2c4e1, which could not be verified/);
  assert.deepEqual(b?.details?.findings, ['f_h4x8pz']);
  assert.equal(evaluate({ feedback: feedback({ findings: [finding('f_l', 'low', 'addressed', null)] }) }).ready, true);
  assert.equal(
    evaluate({
      feedback: feedback({ findings: [finding('f_m', 'medium')] }),
      config: config({ merge: { blockOnSeverity: 'medium' } }),
    }).ready,
    false,
  );
  for (const status of ['wontfix', 'deferred'] as const) {
    assert.equal(evaluate({ feedback: feedback({ findings: [finding('f_h', 'high', status)] }) }).ready, true);
  }
});

test('CHANGES_REQUESTED: per human, latest non-dismissed; bots and COMMENTED reviews do not count', () => {
  const dismissed = feedback({
    reviews: [
      review('maria-dev', 'CHANGES_REQUESTED', '2026-10-21T15:00:00Z'),
      review('maria-dev', 'DISMISSED', '2026-10-21T15:30:00Z'),
      review('maria-dev', 'COMMENTED', '2026-10-21T16:00:00Z'),
      review('copilot', 'CHANGES_REQUESTED', '2026-10-21T16:00:00Z', true),
    ],
  });
  assert.equal(evaluate({ feedback: dismissed }).ready, true);
  const commentedAfter = feedback({
    reviews: [
      review('maria-dev', 'CHANGES_REQUESTED', '2026-10-21T15:00:00Z'),
      review('maria-dev', 'COMMENTED', '2026-10-21T16:00:00Z'),
    ],
  });
  assert.equal(evaluate({ feedback: commentedAfter }).ready, false);
});

test('BLOCKED_BY_PROTECTION still fires when the CI_RED that would explain it is waived or overridden', () => {
  const blocked = { merge: merge({ mergeStateStatus: 'BLOCKED' as const }) };
  const waived = evaluate({ snapshot: blocked, ci: red(failing('build', 'same-tests')) });
  assert.deepEqual(
    waived.plan.blockers.map((b) => b.code),
    ['BLOCKED_BY_PROTECTION'],
  );
  const overridden = evaluate({
    snapshot: blocked,
    ci: red(failing('build', 'different')),
    request: { overrides: parseOverrides(['CI_RED'], 'user accepts the red build') },
  });
  assert.deepEqual(
    overridden.plan.blockers.map((b) => b.code),
    ['BLOCKED_BY_PROTECTION'],
  );
  const explained = evaluate({ snapshot: blocked, ci: red(failing('build', 'different')) });
  assert.deepEqual(
    explained.plan.blockers.map((b) => b.code),
    ['CI_RED'],
  );
});

test('METHOD_NOT_ALLOWED: squash needs --method, an allowedMethods entry and the repo setting', () => {
  const both = config({ merge: { method: 'squash', allowedMethods: ['merge', 'squash'] } });
  const implicit = evaluate({ config: both });
  assert.match(implicit.plan.blockers[0]?.message ?? '', /squash needs an explicit --method squash/);
  assert.equal(evaluate({ config: both, request: { method: 'squash' } }).ready, true);
  const repoOff = evaluate({
    config: both,
    request: { method: 'squash' },
    snapshot: { repoSettings: { ...snapshot().repoSettings, squashMergeAllowed: false } },
  });
  assert.match(repoOff.plan.blockers[0]?.message ?? '', /the repo does not allow squash merges/);
  const squash = evaluate({ config: both, request: { method: 'squash' } });
  assert.deepEqual(squash.plan.request.body, {
    sha: snapshot().head.sha,
    merge_method: 'squash',
    commit_title: `${snapshot().title} (#3301)`,
    commit_message: snapshot().body,
  });
  assert.equal(
    evaluate({ snapshot: { repoSettings: { ...snapshot().repoSettings, mergeCommitAllowed: false } } }).ready,
    false,
  );
});

test('MERGE_CONFLICT and BEHIND_BASE carry the exact fetch-and-merge commands', () => {
  const c = evaluate({ snapshot: { merge: merge({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }) } });
  assert.match(String(c.plan.blockers[0]?.details?.hint), /git fetch origin main && git merge origin\/main/);
  assert.match(mergeBlockedError(c).hint ?? '', /git fetch origin main && git merge origin\/main/);
  assert.equal(c.exitClass, 'state');
});

test('MERGEABLE_UNKNOWN: a known mergeable with an UNKNOWN mergeStateStatus still blocks', () => {
  const e = evaluate({
    snapshot: { merge: merge({ mergeable: 'MERGEABLE', mergeStateStatus: 'UNKNOWN', settled: false }) },
  });
  assert.deepEqual(
    e.plan.blockers.map((b) => b.code),
    ['MERGEABLE_UNKNOWN'],
  );
  assert.match(e.plan.blockers[0]?.message ?? '', /mergeStateStatus UNKNOWN/);
});

test('a closed PR skips the mergeability checks instead of piling up noise', () => {
  const e = evaluate({ snapshot: { state: 'MERGED', merge: merge({ mergeable: 'UNKNOWN', settled: false }) } });
  assert.deepEqual(
    e.plan.blockers.map((b) => b.code),
    ['PR_NOT_OPEN'],
  );
  for (const code of ['MERGEABLE_UNKNOWN', 'MERGE_CONFLICT', 'BEHIND_BASE', 'BLOCKED_BY_PROTECTION']) {
    assert.equal(e.plan.checks.find((c) => c.code === code)?.status, 'skipped');
  }
});

test('CI_PENDING: pending with only a baseline check missing blocks (04: §11.2/§11.3 win over row 10a)', () => {
  const e = evaluate({
    ci: ci({
      state: 'pending',
      phase: 'partial',
      expectedMissing: [{ name: 'e2e', workflow: null, source: 'baseline', state: 'missing' }],
    }),
  });
  assert.equal(e.plan.allowed, false);
  assert.deepEqual(
    e.plan.blockers.map((b) => b.code),
    ['CI_PENDING'],
  );
  assert.match(e.plan.blockers[0]?.message ?? '', /e2e not reported yet/);
});

test('CI_PENDING: a truncated check read blocks, even when every read check is red or green', () => {
  for (const c of [
    ci({ state: 'pending', phase: 'partial', truncated: true }),
    { ...red(failing('t', 'same-tests')), truncated: true as const },
  ]) {
    const e = evaluate({ ci: c });
    assert.ok(e.plan.blockers.some((b) => b.code === 'CI_PENDING'));
    assert.match(e.plan.blockers.find((b) => b.code === 'CI_PENDING')?.message ?? '', /More checks reported/);
  }
});

test('CI_PENDING: a green summary for a different SHA than the snapshot head blocks', () => {
  const e = evaluate({ ci: ci({ headSha: 'b'.repeat(40) }) });
  assert.equal(e.plan.allowed, false);
  assert.deepEqual(
    e.plan.blockers.map((b) => b.code),
    ['CI_PENDING'],
  );
  assert.match(e.plan.blockers[0]?.message ?? '', /evaluated for bbbbbbb, not the head 9f2c4e1/);
});

test('CI_PENDING: a SHA-mismatched (registering) summary blocks; the ETA is in the message', () => {
  const e = evaluate({ ci: ci({ state: 'pending', phase: 'registering', counts: { ...ci().counts, pass: 0 } }) });
  assert.match(e.plan.blockers[0]?.message ?? '', /checks not registered yet for 9f2c4e1/);
  const eta = evaluate({
    ci: ci({
      state: 'pending',
      phase: 'running',
      pending: [{ name: 'a', workflow: 'CI', status: 'in_progress', required: false }],
      eta: { seconds: 330, p90Seconds: 600, basis: 'baseline' },
    }),
  });
  assert.equal(eta.plan.blockers[0]?.message, '1 check pending for 9f2c4e1 (ETA ~6m).');
  assert.match(
    String(eta.plan.blockers[0]?.details?.hint),
    /ghx ci wait powerhouse-inc\/powerhouse#3301 --until mergeable/,
  );
});

test('KEY_STEP_SKIPPED: not evaluated is skipped only while ci.keySteps is not configured', () => {
  assert.equal(evaluate().plan.checks.find((c) => c.code === 'KEY_STEP_SKIPPED')?.status, 'skipped');
  const keySteps = config({ ci: { keySteps: ['Run tests'] } });
  for (const ciFacts of [undefined, {}, { keyStepsSkipped: null }]) {
    const e = evaluate({ config: keySteps, ...(ciFacts ? { ciFacts } : {}) });
    assert.deepEqual(
      e.plan.blockers.map((b) => b.code),
      ['KEY_STEP_SKIPPED'],
      JSON.stringify(ciFacts),
    );
  }
  assert.equal(evaluate({ config: keySteps, ciFacts: { keyStepsSkipped: [] } }).plan.allowed, true);
});

test('KEY_STEP_SKIPPED: a run whose jobs could not be read fails closed', () => {
  const e = evaluate({
    config: config({ ci: { keySteps: ['Run tests'] } }),
    ciFacts: { keyStepsSkipped: [], keyStepsUnchecked: [37948190914] },
  });
  assert.deepEqual(
    e.plan.blockers.map((b) => b.code),
    ['KEY_STEP_SKIPPED'],
  );
  assert.match(e.plan.blockers[0]?.message ?? '', /could not be checked for 1 run: 37948190914/);
});

test('warnings: unresolved threads, a base change under 24 h, children, high risk; old base changes are quiet', () => {
  const e = evaluate({
    feedback: feedback({ threads: 2 }),
    snapshot: {
      stack: {
        parent: null,
        declaredParent: null,
        children: [{ ref: 'powerhouse-inc/powerhouse#3302', state: 'OPEN', draft: false, headRef: 'x' }],
        baseChanges: [
          { from: 'feat/a', to: 'main', at: new Date(NOW - 3_600_000).toISOString(), automatic: true },
          { from: 'main', to: 'feat/a', at: new Date(NOW - 3 * 86_400_000).toISOString(), automatic: false },
        ],
      },
      meta: {
        status: 'ok',
        warnings: [],
        block: {
          t: 'pr',
          id: 'p_k3m9qa',
          gen: 'ghx/0.1.0',
          rev: 1,
          title: 't',
          description: 'd',
          testing: [],
          risk: 'catastrophic',
          components: [],
          revertPolicy: 'revert-safe',
        },
      },
    },
  });
  assert.equal(e.ready, true);
  assert.deepEqual(
    e.warnings.map((w) => w.code),
    ['UNRESOLVED_THREADS', 'BASE_CHANGED', 'HAS_CHILDREN', 'RISK_HIGH'],
  );
});

test('overrides: an override turns a blocker into plan.overrides; an unused one warns OVERRIDE_UNUSED', () => {
  const e = evaluate({
    snapshot: { author: { login: 'other-dev', isViewer: false, isBot: false, association: 'MEMBER' } },
    request: { overrides: parseOverrides(['AUTHOR_NOT_VIEWER,CI_RED'], 'user asked in chat') },
  });
  assert.equal(e.ready, true);
  assert.deepEqual(e.plan.overrides, [{ code: 'AUTHOR_NOT_VIEWER', reason: 'user asked in chat' }]);
  assert.equal(e.plan.checks.find((c) => c.code === 'AUTHOR_NOT_VIEWER')?.status, 'overridden');
  assert.deepEqual(
    e.notices.map((n) => n.code),
    ['OVERRIDE_UNUSED'],
  );
});

test('scope ci-gate keeps rows 6–12 only: an open finding or a draft does not affect the gate', () => {
  const e = evaluate({
    scope: 'ci-gate',
    snapshot: { draft: true },
    feedback: feedback({ findings: [finding('f_h4x8pz', 'high')] }),
    ci: red(failing('t', 'same-tests')),
  });
  assert.deepEqual(
    e.plan.checks.map((c) => c.code),
    CI_GATE_CODES,
  );
  assert.equal(e.ready, true);
  assert.deepEqual(e.warnings, []);
  const conflict = evaluate({ scope: 'ci-gate', snapshot: { merge: merge({ mergeable: 'CONFLICTING' }) } });
  assert.deepEqual(
    conflict.plan.blockers.map((b) => b.code),
    ['MERGE_CONFLICT'],
  );
});

test('CONFIG_MISSING (pr status without config) is a non-overridable blocker', () => {
  const e = evaluate({ configMissing: true });
  assert.deepEqual(
    e.plan.blockers.map((b) => [b.code, b.overridable]),
    [['CONFIG_MISSING', false]],
  );
  assert.equal(e.exitClass, 'policy');
});

test('the engine re-validates overrides: an empty reason or a non-overridable code is VALIDATION', () => {
  const failingCi = { ci: red(failing('test', 'different')) };
  for (const overrides of [
    { codes: ['CI_RED' as const], reason: '' },
    { codes: ['CI_RED' as const], reason: '  ' },
    { codes: ['PR_DRAFT' as never], reason: 'user asked' },
  ]) {
    assert.throws(
      () => evaluate({ ...failingCi, request: { overrides } }),
      (e) => e instanceof Error && 'code' in e && e.code === 'VALIDATION',
      JSON.stringify(overrides),
    );
  }
  const ok = evaluate({ ...failingCi, request: { overrides: { codes: ['CI_RED'], reason: ' user asked ' } } });
  assert.deepEqual(ok.plan.overrides, [{ code: 'CI_RED', reason: 'user asked' }]);
});

test('scope ci-gate: BLOCKED caused by CHANGES_REQUESTED (out of scope) stays blocked; full scope explains it', () => {
  const over = {
    snapshot: { merge: merge({ mergeStateStatus: 'BLOCKED' as const, reviewDecision: 'CHANGES_REQUESTED' as const }) },
    feedback: feedback({ reviews: [review('maria-dev', 'CHANGES_REQUESTED', '2026-10-21T15:00:00Z')] }),
  };
  const gate = evaluate({ ...over, scope: 'ci-gate' });
  assert.equal(gate.ready, false);
  assert.deepEqual(
    gate.plan.blockers.map((b) => b.code),
    ['BLOCKED_BY_PROTECTION'],
  );
  assert.match(gate.plan.blockers[0]?.message ?? '', /changes were requested/);
  assert.deepEqual(
    evaluate(over).plan.blockers.map((b) => b.code),
    ['CHANGES_REQUESTED'],
  );
});
