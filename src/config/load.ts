// Config discovery for the TARGET repo, not the cwd repo (01 §5, 02 §15 ask 1):
//   1. the cwd toplevel resolves to the target → read the local working copy (uncommitted edits count);
//   2. otherwise → GET repos/{o}/{r}/contents/.github/ghx.json on the default branch (a read call).
// Local wins whenever it applies; the two are never merged. Invalid is always an error, whatever the need.
// A local read records where it came from (HEAD, and whether the file differs from HEAD's) and, from git
// alone (no network), warns CONFIG_DRIFT when the file differs from the default branch's remote-tracking
// copy while HEAD lacks commits of that branch: a stale checkout, whose ci.expected and policy are old.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ConfigNeed, Warning } from '../core/command.ts';
import { GhxError, mapZodIssues } from '../core/errors.ts';
import { suggest } from '../core/suggest.ts';
import { type Gh, GhFailure } from '../gh/index.ts';
import { tryParseRepo } from '../gh/refs.ts';
import type { ResolvedRepo } from '../gh/repo.ts';
import { type RepoRef, repoSlug, sameRepo } from '../gh/types.ts';
import type { Git } from '../git/index.ts';
import { parseJsonWithPosition } from '../util/json.ts';
import { CONFIG_PATH, CONFIG_VERSION, ConfigSchema, defaultConfig, type GhxConfig } from './schema.ts';

export type ConfigSource =
  /** `commit`: HEAD of the checkout; `dirty`: the file differs from HEAD's (both absent when git cannot say). */
  | { kind: 'local'; path: string; commit?: string; dirty?: boolean }
  | { kind: 'remote'; repo: RepoRef; ref: string; path: typeof CONFIG_PATH }
  | { kind: 'default' };

export interface LoadedConfig {
  config: GhxConfig;
  source: ConfigSource;
  /** CONFIG_DRIFT, for the command's warnings. */
  warnings: Warning[];
}

export interface LoadConfigOptions {
  /** The target repo; undefined when the command resolved none (local only). */
  target: ResolvedRepo | undefined;
  git: Git;
  gh: Gh;
  need: Exclude<ConfigNeed, 'none'>;
}

const ContentsResponse = z.object({
  content: z.string(),
  encoding: z.string(),
  url: z.string().optional(),
});

/** The source as plain JSON (error details, the CI_PENDING blocker, the ci wait `start` event). */
export function describeSource(s: ConfigSource): Record<string, unknown> {
  if (s.kind === 'local') {
    return {
      kind: 'local',
      path: s.path,
      ...(s.commit !== undefined ? { commit: s.commit } : {}),
      ...(s.dirty !== undefined ? { dirty: s.dirty } : {}),
    };
  }
  if (s.kind === 'remote') return { kind: 'remote', repo: repoSlug(s.repo), ref: s.ref, path: s.path };
  return { kind: 'default' };
}

/** Parse and validate config text. Exported for `ghx doctor` and tests. */
export function parseConfigText(text: string, source: ConfigSource): GhxConfig {
  const label =
    source.kind === 'local'
      ? source.path
      : source.kind === 'remote'
        ? `${repoSlug(source.repo)}:${CONFIG_PATH}`
        : CONFIG_PATH;
  const parsed = parseJsonWithPosition(text);
  if (!parsed.ok) {
    throw new GhxError('CONFIG_INVALID_JSON', `${label} is not valid JSON: ${parsed.message}.`, {
      hint: `Fix the JSON in ${CONFIG_PATH}.`,
      details: { line: parsed.line, column: parsed.column, source: describeSource(source) },
    });
  }
  const v = parsed.value as { version?: unknown } | null;
  if (v && typeof v === 'object' && typeof v.version === 'number' && v.version !== CONFIG_VERSION) {
    throw new GhxError(
      'CONFIG_UNSUPPORTED_VERSION',
      `${label} has version ${v.version}; this ghx supports version ${CONFIG_VERSION}.`,
      {
        hint: 'Upgrade ghx, or set "version": 1.',
        details: { version: v.version, supported: [CONFIG_VERSION], source: describeSource(source) },
      },
    );
  }
  const r = ConfigSchema.safeParse(parsed.value);
  if (!r.success) {
    const issues = mapZodIssues(r.error, {
      schema: ConfigSchema,
      input: parsed.value,
      suggest: (w, c) => suggest(w, c),
    });
    const first = issues.find((i) => i.suggestion !== undefined) ?? issues[0];
    throw new GhxError(
      'CONFIG_INVALID',
      `${label}: ${first ? `${first.path || '(root)'}: ${first.message}` : 'invalid'}${issues.length > 1 ? ` (+${issues.length - 1} more)` : ''}.`,
      {
        hint: first
          ? `Fix ${CONFIG_PATH} at ${first.path || '(root)'}${first.suggestion ? ` (did you mean '${first.suggestion}'?)` : ''}; run 'ghx schema config' for the format.`
          : `Run 'ghx schema config' for the format.`,
        details: { issues, source: describeSource(source) },
      },
    );
  }
  return r.data;
}

// Synchronous, like the wait state and cache reads: an async read is a threadpool hop that tests driving a
// fake clock cannot wait for, so fake time could pass before the command's first call.
function readLocal(toplevel: string): { text: string; path: string } | undefined {
  const path = join(toplevel, CONFIG_PATH);
  try {
    return { text: readFileSync(path, 'utf8'), path };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new GhxError('CONFIG_INVALID', `Cannot read ${path}: ${(e as Error).message}`, {
      details: { source: { kind: 'local', path } },
    });
  }
}

async function readRemote(gh: Gh, repo: RepoRef): Promise<{ text: string; ref: string } | undefined> {
  try {
    const r = await gh.api({ path: `repos/{owner}/{repo}/contents/${CONFIG_PATH}`, repo }, ContentsResponse, {
      notFound: 'REF_NOT_FOUND',
    });
    if (r.notModified) return undefined;
    const ref = (r.data.url ? new URL(r.data.url).searchParams.get('ref') : null) ?? 'HEAD';
    const text = r.data.encoding === 'base64' ? Buffer.from(r.data.content, 'base64').toString('utf8') : r.data.content;
    return { text, ref };
  } catch (e) {
    if (e instanceof GhFailure && e.failure.code === 'GH_NOT_FOUND') return undefined;
    throw e;
  }
}

/** One line naming the source: `the working tree at fb84c4e (dirty)`, `o/r@main`, `the defaults`. */
export function sourceLabel(s: ConfigSource): string {
  if (s.kind === 'remote') return `${repoSlug(s.repo)}@${s.ref}`;
  if (s.kind === 'default') return 'the defaults';
  const at = s.commit ? ` at ${s.commit.slice(0, 7)}` : '';
  return `the working tree${at}${s.dirty ? ' (dirty)' : ''}`;
}

/** The remote-tracking ref of the target's default branch: `<remote>/HEAD`'s target, else `<remote>/main|master`. */
async function baseRef(git: Git, target: ResolvedRepo): Promise<string | undefined> {
  const remotes = (await git.remotes()).filter((r) => {
    const repo = tryParseRepo(r.url);
    return repo !== undefined && sameRepo(repo, target.repo);
  });
  for (const r of remotes) {
    const head = await git.remoteHead?.(r.name);
    if (head) return head;
    for (const b of ['main', 'master']) if (await git.revParse(`${r.name}/${b}`)) return `${r.name}/${b}`;
  }
  return undefined;
}

/**
 * HEAD and dirtiness of the local file, and CONFIG_DRIFT: the file differs from the default branch's
 * remote-tracking copy and HEAD is behind that branch. A branch on top of it (behind 0) that edits the
 * file is the edit under review, not drift. Anything git cannot answer is skipped quietly.
 */
export async function inspectLocal(
  git: Git,
  file: string,
  target: ResolvedRepo | undefined,
): Promise<{ commit?: string; dirty?: boolean; warnings: Warning[] }> {
  const out: { commit?: string; dirty?: boolean; warnings: Warning[] } = { warnings: [] };
  const commit = await git.revParse('HEAD');
  if (commit) out.commit = commit;
  const work = await git.hashFile?.(file);
  if (!work) return out;
  const atHead = await git.blobAt?.('HEAD', CONFIG_PATH);
  if (commit) out.dirty = atHead !== work;
  if (!target) return out;
  const base = await baseRef(git, target);
  const atBase = base ? await git.blobAt?.(base, CONFIG_PATH) : undefined;
  if (!base || !atBase || atBase === work) return out;
  const counts = await git.aheadBehind?.('HEAD', base);
  if (counts && counts.behind === 0) return out;
  const baseCommit = await git.revParse(base);
  const head = commit ? `HEAD (${commit.slice(0, 7)})` : 'HEAD';
  const where = counts
    ? `${head} is ${counts.behind} commit${counts.behind === 1 ? '' : 's'} behind ${base}${counts.ahead > 0 ? ` and ${counts.ahead} ahead` : ''}`
    : `${head} may not include ${base}`;
  out.warnings.push({
    code: 'CONFIG_DRIFT',
    message:
      `${CONFIG_PATH} here differs from ${base}'s${baseCommit ? ` (${baseCommit.slice(0, 7)})` : ''}, and ${where}. ` +
      `ghx reads the working tree, so ci.expected and the merge policy may be stale: pull, or run ghx from an up-to-date checkout.`,
    details: {
      path: file,
      base,
      ...(baseCommit ? { baseCommit } : {}),
      ...(commit ? { head: commit } : {}),
      ...(counts ? { ahead: counts.ahead, behind: counts.behind } : {}),
    },
  });
  return out;
}

/** Which source applies: local when the cwd checkout is the target (or no target), else remote. */
export function localApplies(target: ResolvedRepo | undefined, toplevel: string | undefined): boolean {
  if (!toplevel) return false;
  if (!target) return true;
  return target.cwdRepo !== undefined && sameRepo(target.cwdRepo, target.repo);
}

export async function loadConfig(o: LoadConfigOptions): Promise<LoadedConfig> {
  const toplevel = await o.git.toplevel();
  if (localApplies(o.target, toplevel)) {
    const local = readLocal(toplevel as string);
    if (local) {
      const config = parseConfigText(local.text, { kind: 'local', path: local.path });
      const { warnings, ...seen } = await inspectLocal(o.git, local.path, o.target);
      return { config, source: { kind: 'local', path: local.path, ...seen }, warnings };
    }
  } else if (o.target) {
    const remote = await readRemote(o.gh, o.target.repo);
    if (remote) {
      const source: ConfigSource = { kind: 'remote', repo: o.target.repo, ref: remote.ref, path: CONFIG_PATH };
      return { config: parseConfigText(remote.text, source), source, warnings: [] };
    }
  }
  if (o.need === 'optional') return { config: defaultConfig(), source: { kind: 'default' }, warnings: [] };
  const where = o.target ? repoSlug(o.target.repo) : (toplevel ?? 'this directory');
  throw new GhxError('CONFIG_MISSING', `${where} has no ${CONFIG_PATH}.`, {
    hint: "Run 'ghx init' to write a starter config (or 'ghx schema config' for the format).",
    details: { ...(o.target ? { repo: repoSlug(o.target.repo) } : {}), path: CONFIG_PATH },
  });
}
