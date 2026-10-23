// The merge checks of 02 §8.2 as data: code, class and overridability, in table order. `state` blockers
// clear when GitHub's state changes (exit 9); `policy` blockers are ghx rules (exit 6), some overridable
// with --override CODE --reason. CONFIG_MISSING is pr status's extra blocker (02 §4.2).

export type CheckClass = 'state' | 'policy';

export interface CheckSpec {
  /** 02 §8.2 row ("10a", "10b" for the two CI rows). */
  row: string;
  code: string;
  class: CheckClass;
  overridable: boolean;
}

export const MERGE_CHECKS = [
  { row: '1', code: 'PR_NOT_OPEN', class: 'state', overridable: false },
  { row: '2', code: 'PR_DRAFT', class: 'state', overridable: false },
  { row: '3', code: 'HEAD_MOVED', class: 'state', overridable: false },
  { row: '4', code: 'AUTHOR_NOT_VIEWER', class: 'policy', overridable: true },
  // Not in 02 §8.2: GitHub refuses the merge PUT without write access to the base repo (never overridable).
  { row: '4b', code: 'NO_MERGE_PERMISSION', class: 'policy', overridable: false },
  { row: '5', code: 'METHOD_NOT_ALLOWED', class: 'policy', overridable: false },
  { row: '6', code: 'MERGEABLE_UNKNOWN', class: 'state', overridable: false },
  { row: '7', code: 'MERGE_CONFLICT', class: 'state', overridable: false },
  { row: '8', code: 'BEHIND_BASE', class: 'state', overridable: false },
  { row: '9', code: 'BLOCKED_BY_PROTECTION', class: 'state', overridable: false },
  { row: '10a', code: 'CI_PENDING', class: 'state', overridable: false },
  { row: '10b', code: 'CI_NO_CHECKS', class: 'state', overridable: true },
  { row: '11', code: 'CI_RED', class: 'policy', overridable: true },
  { row: '12', code: 'KEY_STEP_SKIPPED', class: 'policy', overridable: true },
  { row: '13', code: 'CHANGES_REQUESTED', class: 'policy', overridable: true },
  { row: '14', code: 'FINDINGS_OPEN', class: 'policy', overridable: true },
  // Not in 02 §8.2: more feedback existed than ghx reads, so an unread finding may be open (fails closed).
  { row: '14b', code: 'FEEDBACK_TRUNCATED', class: 'policy', overridable: true },
  { row: '15', code: 'PRECONDITION_UNMET', class: 'policy', overridable: true },
] as const satisfies readonly CheckSpec[];

export type MergeCheckCode = (typeof MERGE_CHECKS)[number]['code'];

/** pr status reports a missing config as a blocker; pr merge refuses earlier with exit 3. */
export const CONFIG_MISSING_CHECK: CheckSpec = {
  row: '-',
  code: 'CONFIG_MISSING',
  class: 'policy',
  overridable: false,
};

/** `ci wait --until mergeable` evaluates the merge CI gate, 02 §8.2 rows 6–12 (02 §11.2). */
export const CI_GATE_CODES: readonly MergeCheckCode[] = [
  'MERGEABLE_UNKNOWN',
  'MERGE_CONFLICT',
  'BEHIND_BASE',
  'BLOCKED_BY_PROTECTION',
  'CI_PENDING',
  'CI_NO_CHECKS',
  'CI_RED',
  'KEY_STEP_SKIPPED',
];

const BY_CODE = new Map<string, CheckSpec>([...MERGE_CHECKS, CONFIG_MISSING_CHECK].map((c) => [c.code, c]));

export function checkSpec(code: string): CheckSpec | undefined {
  return BY_CODE.get(code);
}

export const OVERRIDABLE_CODES: readonly string[] = MERGE_CHECKS.filter((c) => c.overridable).map((c) => c.code);
