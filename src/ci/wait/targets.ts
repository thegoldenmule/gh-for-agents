// ci wait targets and head binding (02 §11.5; 03 M4.8). A target is a PR selector, `branch:<name>` or
// `branch:<name>@<sha>`. A PR binds its head at start and restarts on a head change by default; a
// branch binds its head at start (or the given SHA) and stays there, since main moves with every merge.
import { GhxError } from '../../core/errors.ts';
import { parseTargetRef } from '../../gh/refs.ts';
import type { RepoRef } from '../../gh/types.ts';

export type HeadPolicy = 'restart' | 'stop' | 'stay';

export type WaitTarget =
  | { kind: 'pr'; raw: string; number: number; repo?: RepoRef | undefined }
  | { kind: 'branch'; raw: string; branch: string; sha: string | null };

const BRANCH_PREFIX = 'branch:';
const SHA_SUFFIX = /^[0-9a-f]{7,40}$/;

export function parseWaitTarget(raw: string): WaitTarget {
  const s = raw.trim();
  if (s.startsWith(BRANCH_PREFIX)) {
    const rest = s.slice(BRANCH_PREFIX.length);
    const at = rest.lastIndexOf('@');
    const suffix = at > 0 ? rest.slice(at + 1) : '';
    const [branch, sha] = SHA_SUFFIX.test(suffix) ? [rest.slice(0, at), suffix] : [rest, null];
    if (branch === '' || /\s|\.\.|^\/|\/$/.test(branch)) {
      throw new GhxError('USAGE_BAD_SELECTOR', `'${raw}' is not a ci wait target.`, {
        hint: 'Use a PR (3198, owner/repo#3198), branch:<name> or branch:<name>@<sha>.',
      });
    }
    return { kind: 'branch', raw: s, branch, sha };
  }
  const t = parseTargetRef(s);
  if (t.kind !== 'pr') {
    throw new GhxError('USAGE_BAD_SELECTOR', `'${raw}' is a workflow run or job, not a ci wait target.`, {
      hint: 'ci wait takes a PR, branch:<name> or branch:<name>@<sha>; for one run use ghx ci why --run.',
    });
  }
  return { kind: 'pr', raw: s, number: t.number, ...(t.repo ? { repo: t.repo } : {}) };
}

/** The state-store key (one per target within a repo). */
export function targetKey(t: WaitTarget): string {
  return t.kind === 'pr' ? `pr-${t.number}` : `branch-${t.branch}${t.sha ? `@${t.sha}` : ''}`;
}

/** The state key of a target bound to `sha`: an unpinned branch is stored as `branch:<name>@<sha>`. */
export function boundKey(t: WaitTarget, sha: string): string {
  return targetKey(t.kind === 'branch' && t.sha === null ? { ...t, sha } : t);
}

/** The `target` every event and result carries. */
export function targetLabel(t: WaitTarget, repo: RepoRef): string {
  return t.kind === 'pr' ? `${repo.owner}/${repo.name}#${t.number}` : t.raw;
}

/**
 * What a head change does: PRs restart by default, branches stay. `branch:<name>@<sha>` names its
 * commit explicitly, so it always stays.
 */
export function headPolicy(t: WaitTarget, flag: HeadPolicy | undefined): HeadPolicy {
  if (t.kind === 'branch' && t.sha !== null) return 'stay';
  return flag ?? (t.kind === 'pr' ? 'restart' : 'stay');
}
