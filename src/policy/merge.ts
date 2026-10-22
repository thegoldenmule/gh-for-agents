// The merge policy engine (02 §8.2–8.4; 03 M6.4). Pure: snapshot, CI summary, feedback, config, overrides
// and the method request in; a MergePlan out. It is the one engine behind `pr status` (merge.ready and
// blockers), `pr merge` and `ci wait --until mergeable` (scope `ci-gate`, rows 6–12), so `ready` always
// means "pr merge would proceed now". All checks run and every violation is reported together.
// Fails closed: an unknown severity or risk ranks high, an `unknown` precondition blocks, and an
// addressed finding at or above merge.blockOnSeverity whose commit is still unverified counts as open (04).
import { GhxError } from '../core/errors.ts';
import { effectiveSeverity, type FoldResult } from '../feedback/fold.ts';
import type { Finding } from '../feedback/schemas.ts';
import type { PrSnapshot } from '../pr/snapshot/index.ts';
import type { CiSummary } from '../schemas/ci.ts';
import type { Warning } from '../schemas/common.ts';
import { riskRank, type Severity, severityRank, type Violation } from '../schemas/pr.ts';
import { CI_GATE_CODES, CONFIG_MISSING_CHECK, checkSpec, MERGE_CHECKS, type MergeCheckCode } from './checks.ts';
import type { SkippedKeyStep } from './key-steps.ts';
import type { Overrides } from './overrides.ts';
import type { MergePlan, MergeState, PlanCheck, PlanCheckStatus } from './schemas.ts';
import { isShared, type SharedRedMode, sharedRedWaived } from './shared-red.ts';

export type MergeMethod = 'merge' | 'squash' | 'rebase';

/** The config keys the engine reads. GhxConfig satisfies it; ci.none is optional until M4/M5 add it. */
export interface MergePolicyConfig {
  merge: {
    method: MergeMethod;
    allowedMethods: readonly MergeMethod[];
    sharedRed: SharedRedMode;
    blockOnSeverity: Severity;
    requireOwnPr: boolean;
  };
  // The index signature keeps GhxConfig['ci'] assignable while it has no `none` key (weak-type rule).
  ci: { readonly none?: boolean; readonly [key: string]: unknown };
}

export type PolicySnapshot = Pick<
  PrSnapshot,
  | 'repo'
  | 'ref'
  | 'number'
  | 'title'
  | 'body'
  | 'author'
  | 'state'
  | 'draft'
  | 'base'
  | 'head'
  | 'merge'
  | 'viewer'
  | 'repoSettings'
  | 'meta'
  | 'stack'
>;

export interface MergeRequest {
  /** `--method`; absent means merge.method. */
  method?: MergeMethod;
  /** `--expect-head` (7–40 hex). */
  expectHead?: string;
  /** From parseOverrides. */
  overrides?: Overrides | null;
}

/** CI facts the snapshot does not carry. null = not evaluated. */
export interface CiFacts {
  /** `GET actions/workflows` total_count, for CI_NO_CHECKS's auto-pass. */
  workflowsTotal?: number | null;
  /** From skippedKeySteps; null skips KEY_STEP_SKIPPED. */
  keyStepsSkipped?: readonly SkippedKeyStep[] | null;
}

export interface MergePolicyInput {
  snapshot: PolicySnapshot;
  /** The summary with expected set and shared-with-main verdicts filled in. */
  ci: CiSummary;
  ciFacts?: CiFacts;
  feedback: Pick<FoldResult, 'feedback' | 'preconditions'>;
  config: MergePolicyConfig;
  /** pr status without .github/ghx.json: adds the CONFIG_MISSING blocker (02 §4.2). */
  configMissing?: boolean;
  request?: MergeRequest;
  /** Epoch ms, for the 24 h base-change warning. */
  now: number;
  /** `ci-gate` keeps only 02 §8.2 rows 6–12 (ci wait --until mergeable). */
  scope?: 'full' | 'ci-gate';
}

export interface MergeEvaluation {
  plan: MergePlan;
  /** Merge warnings (MergeState.warnings): lower findings, threads, base change, children, high risk. */
  warnings: Violation[];
  /** Command warnings, e.g. OVERRIDE_UNUSED. */
  notices: Warning[];
  ready: boolean;
  /** MERGE_BLOCKED's exit class: 'policy' if any blocker is policy-class (6), else 'state' (9). */
  exitClass: 'state' | 'policy' | null;
}

interface Result {
  status: Exclude<PlanCheckStatus, 'overridden'>;
  message: string;
  details?: Record<string, unknown>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const short = (sha: string) => sha.slice(0, 7);
const pass = (message: string): Result => ({ status: 'pass', message });
const skip = (message: string): Result => ({ status: 'skipped', message });
const fail = (message: string, details?: Record<string, unknown>): Result => ({
  status: 'fail',
  message,
  ...(details ? { details } : {}),
});
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function method(i: MergePolicyInput): MergeMethod {
  return i.request?.method ?? i.config.merge.method;
}

// ── Individual checks ─────────────────────────────────────────────────────
function headMoved(s: PolicySnapshot, expect: string | undefined): Result {
  if (!expect) return skip('no --expect-head; the merge pins the evaluated head');
  if (s.head.sha.startsWith(expect.toLowerCase())) return pass(`head is ${short(s.head.sha)}`);
  return fail(`Head is ${short(s.head.sha)}, expected ${expect}.`, {
    expected: expect,
    actual: s.head.sha,
    hint: `Re-check the new head: ghx pr status ${s.ref}, then retry with --expect-head ${short(s.head.sha)}.`,
  });
}

function authorNotViewer(s: PolicySnapshot, c: MergePolicyConfig): Result {
  if (!c.merge.requireOwnPr) return skip('merge.requireOwnPr is false');
  if (s.author.login === s.viewer.login) return pass(`author ${s.author.login} is you`);
  return fail(`${s.ref} is authored by ${s.author.login}, not you (${s.viewer.login}).`, {
    author: s.author.login,
    hint: 'Only merge your own PRs; if the user asked for this one, add --override AUTHOR_NOT_VIEWER --reason "<who asked>".',
  });
}

const REPO_SETTING = {
  merge: 'mergeCommitAllowed',
  squash: 'squashMergeAllowed',
  rebase: 'rebaseMergeAllowed',
} as const;

function methodNotAllowed(i: MergePolicyInput): Result {
  const m = method(i);
  const why: string[] = [];
  if (!i.config.merge.allowedMethods.includes(m)) {
    why.push(`${m} is not in merge.allowedMethods (${i.config.merge.allowedMethods.join(', ')})`);
  }
  // 02 §8.2 row 5 and brief 6: squash or rebase only when explicitly asked for with --method.
  if (m !== 'merge' && i.request?.method !== m) why.push(`${m} needs an explicit --method ${m}`);
  if (!i.snapshot.repoSettings[REPO_SETTING[m]]) why.push(`the repo does not allow ${m} merges`);
  if (why.length === 0) return pass(`method ${m}`);
  return fail(`Method ${m} is not allowed: ${why.join('; ')}.`, {
    method: m,
    hint:
      m === 'merge'
        ? 'Merge commits are disabled on this repo; ask the user how this repo merges.'
        : 'Merge with the default method (omit --method), or ask the user to allow it in merge.allowedMethods.',
  });
}

function mergeableUnknown(s: PolicySnapshot): Result {
  const unknown = [
    ...(s.merge.mergeable === 'UNKNOWN' ? ['mergeable'] : []),
    // An UNKNOWN merge state would pass BEHIND_BASE, BLOCKED_BY_PROTECTION and the DIRTY conflict check.
    ...(s.merge.mergeStateStatus === 'UNKNOWN' ? ['mergeStateStatus'] : []),
  ];
  if (unknown.length === 0) return pass(`${s.merge.mergeable}, ${s.merge.mergeStateStatus}`);
  return fail(`GitHub still reports ${unknown.join(' and ')} UNKNOWN.`, {
    hint: `Re-run in a minute: ghx pr status ${s.ref}.`,
  });
}

function mergeConflict(s: PolicySnapshot): Result {
  if (s.merge.mergeable !== 'CONFLICTING' && s.merge.mergeStateStatus !== 'DIRTY') return pass(s.merge.mergeable);
  const b = s.base.ref;
  return fail(`${s.ref} conflicts with ${b}.`, {
    hint: `git fetch origin ${b} && git merge origin/${b}, resolve the conflicts, commit, then git push.`,
  });
}

function behindBase(s: PolicySnapshot): Result {
  if (s.merge.mergeStateStatus !== 'BEHIND') return pass(s.merge.mergeStateStatus);
  const b = s.base.ref;
  return fail(`${s.ref} is behind ${b} and the branch must be up to date.`, {
    hint: `git fetch origin ${b} && git merge origin/${b} && git push`,
  });
}

function blockedByProtection(s: PolicySnapshot, explained: boolean): Result {
  if (s.merge.mergeStateStatus !== 'BLOCKED') return pass(s.merge.mergeStateStatus);
  if (explained) return pass('BLOCKED, explained by the CI or review checks');
  const why =
    s.merge.reviewDecision === 'REVIEW_REQUIRED'
      ? 'an approving review is required'
      : s.merge.reviewDecision === 'CHANGES_REQUESTED'
        ? 'changes were requested'
        : 'branch protection or a ruleset blocks it';
  return fail(`GitHub reports ${s.ref} as BLOCKED: ${why}.`, {
    reviewDecision: s.merge.reviewDecision,
    hint: 'Check the branch protection rules or rulesets for the base branch.',
  });
}

const requiredMissing = (ci: CiSummary) =>
  ci.expectedMissing.filter((e) => e.state === 'missing' && e.source !== 'baseline');

/**
 * 02 §11.2/§11.3 win over §8.2 row 10a (04, CI_PENDING conflict): blocks whenever `ci.state` is pending,
 * including when only baseline checks are missing. A baseline check stops blocking only once
 * expectedState(…, agedOut) has aged it out of `missing`.
 */
function ciPending(i: MergePolicyInput): Result {
  const { ci, snapshot: s } = i;
  if (ci.headSha !== s.head.sha) {
    // CI evaluated for another commit says nothing about this head (04).
    return fail(`CI was evaluated for ${short(ci.headSha)}, not the head ${short(s.head.sha)}.`, {
      ciHeadSha: ci.headSha,
      headSha: s.head.sha,
      hint: `Re-read CI for the head: ghx ci wait ${s.ref} --until mergeable (run it in the background).`,
    });
  }
  const missing = ci.expectedMissing.filter((e) => e.state === 'missing');
  const pendingState = ci.state === 'pending';
  if (ci.pending.length === 0 && missing.length === 0 && !pendingState) return pass('no checks pending');
  const parts = [
    ...(ci.pending.length ? [`${plural(ci.pending.length, 'check')} pending`] : []),
    ...(missing.length ? [`${missing.map((m) => m.name).join(', ')} not reported yet`] : []),
    ...(pendingState && ci.pending.length === 0 && missing.length === 0 ? ['checks not registered yet'] : []),
  ];
  const eta = ci.eta ? ` (ETA ~${Math.max(1, Math.ceil(ci.eta.seconds / 60))}m)` : '';
  return fail(`${parts.join('; ')} for ${short(ci.headSha)}${eta}.`, {
    pending: ci.pending.map((p) => p.name),
    missing: missing.map((m) => m.name),
    hint: `Wait for CI: ghx ci wait ${s.ref} --until mergeable (run it in the background).`,
  });
}

function ciNoChecks(i: MergePolicyInput): Result {
  if (i.ci.state !== 'no-checks') return pass('checks reported');
  const expected = requiredMissing(i.ci).length === 0;
  if (expected && i.ciFacts?.workflowsTotal === 0) return pass('the repo has no workflows');
  if (expected && i.config.ci.none) return pass('ci.none: the repo has no CI');
  return fail(`No checks have reported for ${short(i.ci.headSha)}.`, {
    hint: `Wait: ghx ci wait ${i.snapshot.ref} --until mergeable. If CI never starts, ghx ci retrigger ${i.snapshot.ref}.`,
  });
}

function ciRed(i: MergePolicyInput): Result {
  const failing = i.ci.failing;
  if (failing.length === 0) return pass('no failing checks');
  if (sharedRedWaived(failing, i.config.merge.sharedRed)) {
    const each = failing.map((f) => {
      const m = f.sameOnMain;
      const how = m?.verdict === 'same-tests' ? 'with the same test' : 'at the same step';
      return `${f.name} fails ${how} on ${m?.mainBranch ?? 'main'} run ${m?.mainRunId ?? '?'} (${m?.mainSha ? short(m.mainSha) : '?'})`;
    });
    return { status: 'waived', message: `${each.join('; ')}.` };
  }
  const off = i.config.merge.sharedRed === 'off' && failing.every(isShared);
  return fail(`${plural(failing.length, 'failing check')}: ${failing.map((f) => f.name).join(', ')}.`, {
    failing: failing.map((f) => ({ name: f.name, sameOnMain: f.sameOnMain?.verdict ?? null })),
    hint: off
      ? 'Every failure is shared with main, but merge.sharedRed is off.'
      : `Diagnose: ghx ci why ${i.snapshot.ref}.`,
  });
}

function keyStepSkipped(i: MergePolicyInput): Result {
  const skipped = i.ciFacts?.keyStepsSkipped;
  if (skipped == null) return skip('ci.keySteps not evaluated');
  if (skipped.length === 0) return pass('no key step skipped');
  return fail(`Key step skipped in a green job: ${skipped.map((k) => `'${k.step}' in ${k.job}`).join(', ')}.`, {
    skipped,
    hint: 'A green job that skipped a key step proves nothing; check why the step was skipped.',
  });
}

function changesRequested(i: MergePolicyInput): Result {
  const latest = new Map<string, { at: string; state: string; url: string }>();
  for (const r of i.feedback.feedback.reviews) {
    if (r.author.isBot || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.githubState)) continue;
    const cur = latest.get(r.author.login);
    if (!cur || Date.parse(r.submittedAt) >= Date.parse(cur.at)) {
      latest.set(r.author.login, { at: r.submittedAt, state: r.githubState, url: r.url });
    }
  }
  const by = [...latest].filter(([, v]) => v.state === 'CHANGES_REQUESTED').map(([login]) => login);
  if (by.length === 0) return pass('no outstanding change requests');
  return fail(`Changes requested by ${by.join(', ')}.`, {
    by,
    hint: 'Address the review, then ask the reviewer to re-review or dismiss it.',
  });
}

/** Open for blocking: open, or (at or above the threshold) addressed with an unverified commit (04). */
function blockingFindings(findings: readonly Finding[], threshold: Severity): { f: Finding; unverified: boolean }[] {
  const t = severityRank(threshold);
  return findings.flatMap((f): { f: Finding; unverified: boolean }[] => {
    if (severityRank(f.severity) < t) return [];
    if (f.status === 'open') return [{ f, unverified: false }];
    if (f.status === 'addressed' && f.statusEvent?.verified == null) return [{ f, unverified: true }];
    return [];
  });
}

function findingsOpen(i: MergePolicyInput): { result: Result; warning: Violation | null } {
  const threshold = i.config.merge.blockOnSeverity;
  const blocking = blockingFindings(i.feedback.feedback.findings, threshold);
  const lower = i.feedback.feedback.findings.filter(
    (f) => f.status === 'open' && severityRank(f.severity) < severityRank(threshold),
  );
  const warning: Violation | null = lower.length
    ? {
        code: 'FINDINGS_OPEN',
        message: `${plural(lower.length, `open ${lowestLabel(lower)} finding`)} (${lower.map((f) => f.id).join(', ')}); below merge.blockOnSeverity (${threshold}).`,
        overridable: true,
      }
    : null;
  if (blocking.length === 0) {
    return {
      result: lower.length ? { status: 'warn', message: warning?.message ?? '' } : pass('no open findings'),
      warning,
    };
  }
  const desc = blocking.map(({ f, unverified }) =>
    unverified
      ? `${f.id} (${effectiveSeverity(f.severity)}) is marked addressed in ${short(f.statusEvent?.commit ?? '')}, which could not be verified`
      : `${f.id} (${effectiveSeverity(f.severity)}) is open`,
  );
  const ids = blocking.map(({ f }) => f.id);
  return {
    result: fail(desc.join('; '), {
      findings: ids,
      hint: `Resolve ${ids.join(', ')} (ghx pr resolve ${i.snapshot.ref} <id> --status addressed --commit <sha>) or add --override FINDINGS_OPEN --reason "…" if the user accepts it.`,
    }),
    warning,
  };
}

function lowestLabel(fs: readonly Finding[]): string {
  const ranks = new Set(fs.map((f) => effectiveSeverity(f.severity)));
  return ranks.size === 1 ? ([...ranks][0] ?? '') : 'lower-severity';
}

function preconditionUnmet(i: MergePolicyInput): Result {
  const unmet = i.feedback.preconditions.filter((p) => p.status !== 'met' && p.status !== 'withdrawn');
  if (unmet.length === 0)
    return pass(i.feedback.preconditions.length ? 'every precondition is met' : 'no preconditions');
  return fail(unmet.map((p) => `${p.id} is ${p.status}: ${p.evidence}`).join('; '), {
    preconditions: unmet.map((p) => p.id),
    hint: `Meet them, or record the outcome: ghx pr resolve ${i.snapshot.ref} <id> --status met --note "…".`,
  });
}

function mergeWarnings(i: MergePolicyInput, findingWarning: Violation | null): Violation[] {
  const s = i.snapshot;
  const out: Violation[] = [];
  const threads = i.feedback.feedback.counts.unresolvedHumanThreads;
  if (threads > 0) {
    out.push({
      code: 'UNRESOLVED_THREADS',
      message: `${plural(threads, 'unresolved human review thread')}.`,
      overridable: false,
    });
  }
  if (findingWarning) out.push(findingWarning);
  const recent = s.stack.baseChanges.filter((c) => i.now - Date.parse(c.at) < DAY_MS);
  for (const c of recent) {
    out.push({
      code: 'BASE_CHANGED',
      message: `The base changed from ${c.from} to ${c.to} at ${c.at}${c.automatic ? ' (automatic retarget)' : ''}; re-check the diff.`,
      overridable: false,
      details: { from: c.from, to: c.to, at: c.at, automatic: c.automatic },
    });
  }
  if (s.stack.children.length > 0) {
    out.push({
      code: 'HAS_CHILDREN',
      message: `${s.stack.children.map((c) => c.ref).join(', ')} ${s.stack.children.length === 1 ? 'is' : 'are'} stacked on this branch; GitHub retargets them on merge.`,
      overridable: false,
    });
  }
  if (s.meta.status === 'ok' && riskRank(String(s.meta.block.risk)) === 3) {
    out.push({ code: 'RISK_HIGH', message: `The PR declares risk ${s.meta.block.risk}.`, overridable: false });
  }
  return out;
}

// ── Assembly ──────────────────────────────────────────────────────────────
function requestOf(i: MergePolicyInput): MergePlan['request'] {
  const s = i.snapshot;
  const m = method(i);
  const body: Record<string, unknown> = { sha: s.head.sha, merge_method: m };
  if (m === 'squash') {
    body.commit_title = `${s.title} (#${s.number})`;
    body.commit_message = s.meta.status === 'ok' ? s.meta.block.description : s.body.trim();
  }
  return { method: 'PUT', path: `repos/${s.repo.owner}/${s.repo.name}/pulls/${s.number}/merge`, body };
}

/** Evaluate every merge check. Pure. */
export function evaluateMerge(i: MergePolicyInput): MergeEvaluation {
  const s = i.snapshot;
  const open = s.state === 'OPEN';
  const notOpen = skip(`PR is ${s.state}`);
  const overrides = new Set<string>(i.request?.overrides?.codes ?? []);
  const findings = findingsOpen(i);

  const results = new Map<MergeCheckCode, Result>([
    ['PR_NOT_OPEN', open ? pass('OPEN') : fail(`${s.ref} is ${s.state}.`, { state: s.state })],
    [
      'PR_DRAFT',
      s.draft
        ? fail(`${s.ref} is a draft.`, {
            hint: `Mark it ready: ghx pr edit ${s.ref} --input <file with {"draft":false}>.`,
          })
        : pass('not a draft'),
    ],
    ['HEAD_MOVED', headMoved(s, i.request?.expectHead)],
    ['AUTHOR_NOT_VIEWER', authorNotViewer(s, i.config)],
    ['METHOD_NOT_ALLOWED', methodNotAllowed(i)],
    ['MERGEABLE_UNKNOWN', open ? mergeableUnknown(s) : notOpen],
    ['MERGE_CONFLICT', open ? mergeConflict(s) : notOpen],
    ['BEHIND_BASE', open ? behindBase(s) : notOpen],
    ['CI_PENDING', ciPending(i)],
    ['CI_NO_CHECKS', ciNoChecks(i)],
    ['CI_RED', ciRed(i)],
    ['KEY_STEP_SKIPPED', keyStepSkipped(i)],
    ['CHANGES_REQUESTED', changesRequested(i)],
    ['FINDINGS_OPEN', findings.result],
    ['PRECONDITION_UNMET', preconditionUnmet(i)],
  ]);
  const stillFails = (code: MergeCheckCode) => results.get(code)?.status === 'fail' && !overrides.has(code);
  const explained = (['CI_PENDING', 'CI_NO_CHECKS', 'CI_RED', 'CHANGES_REQUESTED'] as const).some(stillFails);
  results.set('BLOCKED_BY_PROTECTION', open ? blockedByProtection(s, explained) : notOpen);

  const inScope = (code: string) => i.scope !== 'ci-gate' || (CI_GATE_CODES as readonly string[]).includes(code);
  const checks: PlanCheck[] = [];
  const blockers: Violation[] = [];
  const waivers: Violation[] = [];
  const used: { code: string; reason: string }[] = [];
  const violation = (code: string, r: Result, overridable: boolean): Violation => ({
    code,
    message: r.message,
    overridable,
    ...(r.details ? { details: r.details } : {}),
  });

  if (i.configMissing && i.scope !== 'ci-gate') {
    const r = fail('No .github/ghx.json: merge policy cannot be evaluated.', {
      hint: 'Run ghx init and commit .github/ghx.json.',
    });
    checks.push({ code: CONFIG_MISSING_CHECK.code, status: 'fail', message: r.message });
    blockers.push(violation(CONFIG_MISSING_CHECK.code, r, false));
  }
  for (const spec of MERGE_CHECKS) {
    if (!inScope(spec.code)) continue;
    const r = results.get(spec.code) as Result;
    if (r.status === 'fail' && spec.overridable && overrides.has(spec.code)) {
      checks.push({ code: spec.code, status: 'overridden', message: r.message });
      used.push({ code: spec.code, reason: i.request?.overrides?.reason ?? '' });
      continue;
    }
    checks.push({ code: spec.code, status: r.status, message: r.message });
    if (r.status === 'fail') blockers.push(violation(spec.code, r, spec.overridable));
    if (r.status === 'waived') waivers.push(violation(spec.code, r, spec.overridable));
  }

  const notices: Warning[] = [...overrides]
    .filter((code) => !used.some((u) => u.code === code))
    .map((code) => ({
      code: 'OVERRIDE_UNUSED',
      message: `--override ${code} had no effect: that check did not fail.`,
    }));
  const policyBlocked = blockers.some((b) => checkSpec(b.code)?.class !== 'state');
  const allowed = blockers.length === 0;
  return {
    plan: {
      ref: s.ref,
      headSha: s.head.sha,
      method: method(i),
      allowed,
      checks,
      blockers,
      waivers,
      overrides: used,
      request: requestOf(i),
    },
    warnings: i.scope === 'ci-gate' ? [] : mergeWarnings(i, findings.warning),
    notices,
    ready: allowed,
    exitClass: allowed ? null : policyBlocked ? 'policy' : 'state',
  };
}

/** pr status's `merge` object (02 §4.1). */
export function mergeStateOf(s: PolicySnapshot, e: MergeEvaluation): MergeState {
  return {
    mergeable: s.merge.mergeable,
    settled: s.merge.settled,
    mergeStateStatus: s.merge.mergeStateStatus,
    reviewDecision: s.merge.reviewDecision,
    method: e.plan.method,
    ready: e.ready,
    blockers: e.plan.blockers,
    waivers: e.plan.waivers,
    warnings: e.warnings,
    mergedAt: s.merge.mergedAt,
    mergeCommit: s.merge.mergeCommit,
  };
}

/** MERGE_BLOCKED (02 §8.4): exit 6 if any blocker is policy-class, else 9. */
export function mergeBlockedError(e: MergeEvaluation): GhxError {
  const codes = e.plan.blockers.map((b) => b.code);
  const hints = e.plan.blockers
    .map((b) => b.details?.hint)
    .filter((h): h is string => typeof h === 'string' && h !== '');
  return new GhxError('MERGE_BLOCKED', `${plural(codes.length, 'blocker')}: ${codes.join(', ')}.`, {
    hint: hints.length ? [...new Set(hints)].join(' ') : `Run ghx pr status ${e.plan.ref} for details.`,
    details: { plan: e.plan, exitClass: e.exitClass ?? 'state' },
  });
}
