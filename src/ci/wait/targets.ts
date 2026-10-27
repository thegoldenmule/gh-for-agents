// CI targets and head binding (02 §11.5, §12, §13.1; 03 M4.8). The one parser for the targets of ci wait,
// ci why and ci rerun: a PR selector, `branch:<name>`, `branch:<name>@<sha>`, or `run:<id>` (a run or job
// URL is that run). A PR binds its head at start and restarts on a head change by default; a branch binds
// its head at start (or the given SHA) and stays there, since main moves with every merge; a run's commit
// never changes.
import { GhxError } from '../../core/errors.ts';
import { tryParseTargetRef } from '../../gh/refs.ts';
import { type RepoRef, repoSlug } from '../../gh/types.ts';

export type HeadPolicy = 'restart' | 'stop' | 'stay';

export type CiTarget =
  | { kind: 'pr'; raw: string; number: number; repo?: RepoRef | undefined }
  | { kind: 'branch'; raw: string; branch: string; sha: string | null }
  | { kind: 'run'; raw: string; runId: number; repo?: RepoRef | undefined };

/** ci wait's name for a target (every target kind waits). */
export type WaitTarget = CiTarget;

export type CiTargetKind = CiTarget['kind'];

const BRANCH_PREFIX = 'branch:';
const RUN_PREFIX = 'run:';
const SHA_SUFFIX = /^[0-9a-f]{7,40}$/;
/** A word that reads as a branch name given without `branch:` (main, release/1.2). */
const BARE_BRANCH = /^[\w.-]+(?:\/[\w.-]+)*$/;

const FORMS: Readonly<Record<CiTargetKind, string>> = {
  pr: 'a PR (3198, owner/repo#3198)',
  branch: 'branch:<name> or branch:<name>@<sha>',
  run: 'run:<id> (or a run URL)',
};

function badTarget(raw: string, command: string, allow: readonly CiTargetKind[], hint?: string): GhxError {
  return new GhxError('USAGE_BAD_SELECTOR', `'${raw}' is not a ${command} target.`, {
    hint: hint ?? `${command} takes ${allow.map((k) => FORMS[k]).join(', ')}.`,
  });
}

/**
 * Parse one CI target for `command` (for messages), accepting only the kinds in `allow`. A bare word
 * that looks like a branch (`main`) is refused with the explicit `branch:main` form in the hint: ghx
 * never guesses whether a word is a branch.
 */
export function parseCiTarget(
  raw: string,
  command: string,
  allow: readonly CiTargetKind[] = ['pr', 'branch', 'run'],
): CiTarget {
  const s = raw.trim();
  const refuse = (kind: CiTargetKind): never => {
    const takes = allow.map((k) => FORMS[k]).join(', ');
    // A branch spans runs: ci why lists them, each a run:<id> this command may take.
    const why = kind === 'branch' && allow.includes('run') ? ` ghx ci why ${s} names the branch head's runs.` : '';
    throw badTarget(raw, command, allow, `${command} does not take ${FORMS[kind]}; it takes ${takes}.${why}`);
  };
  if (s.startsWith(BRANCH_PREFIX)) {
    const rest = s.slice(BRANCH_PREFIX.length);
    const at = rest.lastIndexOf('@');
    const suffix = at > 0 ? rest.slice(at + 1) : '';
    const [branch, sha] = SHA_SUFFIX.test(suffix) ? [rest.slice(0, at), suffix] : [rest, null];
    if (branch === '' || /\s|\.\.|^\/|\/$/.test(branch)) throw badTarget(raw, command, allow);
    if (!allow.includes('branch')) refuse('branch');
    return { kind: 'branch', raw: s, branch, sha };
  }
  if (s.startsWith(RUN_PREFIX)) {
    const rest = s.slice(RUN_PREFIX.length);
    const t = /^\d+$/.test(rest) ? undefined : tryParseTargetRef(rest);
    const runId = t === undefined ? Number(rest) : t.kind === 'run' ? t.number : t.kind === 'job' ? t.runId : undefined;
    if (runId === undefined || !Number.isSafeInteger(runId) || runId <= 0) {
      throw badTarget(raw, command, allow, 'Use run:<id> (run:37948190914) or a run URL.');
    }
    if (!allow.includes('run')) refuse('run');
    return { kind: 'run', raw: `run:${runId}`, runId, ...(t?.repo ? { repo: t.repo } : {}) };
  }
  const t = tryParseTargetRef(s);
  if (t === undefined) {
    const hint =
      BARE_BRANCH.test(s) && allow.includes('branch')
        ? `For a branch, say so: ghx ${command} branch:${s} (a branch has no mergeable state; --until mergeable takes a PR).`
        : undefined;
    throw badTarget(raw, command, allow, hint);
  }
  if (t.kind === 'pr') {
    if (!allow.includes('pr')) refuse('pr');
    return { kind: 'pr', raw: s, number: t.number, ...(t.repo ? { repo: t.repo } : {}) };
  }
  // A run URL, or a job URL (its run).
  const runId = t.kind === 'run' ? t.number : t.runId;
  if (runId === undefined) throw badTarget(raw, command, allow);
  if (!allow.includes('run')) refuse('run');
  return { kind: 'run', raw: `run:${runId}`, runId, ...(t.repo ? { repo: t.repo } : {}) };
}

export function parseWaitTarget(raw: string): WaitTarget {
  return parseCiTarget(raw, 'ci wait');
}

/** The repo a target names itself (a PR ref or a URL), if any. */
export function targetRepo(t: CiTarget): RepoRef | undefined {
  return t.kind === 'branch' ? undefined : t.repo;
}

/** The state-store key (one per target within a repo). */
export function targetKey(t: WaitTarget): string {
  if (t.kind === 'pr') return `pr-${t.number}`;
  if (t.kind === 'run') return `run-${t.runId}`;
  return `branch-${t.branch}${t.sha ? `@${t.sha}` : ''}`;
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
 * A target as a ghx argument that names its repo: owner/repo#N for a PR (the ref embeds it), otherwise
 * the target with `-R owner/repo`, for `next` and hints that must work from any directory.
 */
export function targetArg(t: CiTarget, repo: RepoRef, sha?: string): string {
  if (t.kind === 'pr') return `${repo.owner}/${repo.name}#${t.number}`;
  const label = t.kind === 'branch' && t.sha === null && sha ? `branch:${t.branch}@${sha.slice(0, 7)}` : t.raw;
  return `${label} -R ${repoSlug(repo)}`;
}

/**
 * What a head change does: PRs restart by default, branches stay. `branch:<name>@<sha>` names its
 * commit explicitly, and a run's commit is fixed, so both always stay.
 */
export function headPolicy(t: WaitTarget, flag: HeadPolicy | undefined): HeadPolicy {
  if ((t.kind === 'branch' && t.sha !== null) || t.kind === 'run') return 'stay';
  return flag ?? (t.kind === 'pr' ? 'restart' : 'stay');
}
