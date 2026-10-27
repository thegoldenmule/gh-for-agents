// The passthrough runner (02 §10, 03 M7.1): a synthetic read spec that runs one allowlisted gh read on
// the read-mode gh client and wraps it as {passthrough:{argv, exitCode, json?, text?, stdoutPath?,
// stdoutBytes, stderr?}}. Inline output is capped below the global bound (03 Q5) so the envelope itself
// never spills; larger stdout goes to the artifact dir as stdoutPath.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { type AnyCommandSpec, type Context, defineCommand } from '../core/command.ts';
import { rethrowControlFlow } from '../core/control-flow.ts';
import { type ErrorDetails, GhxError } from '../core/errors.ts';
import { byteLength, DEFAULT_MAX_BYTES } from '../core/output.ts';
import { apiShape } from '../gh/guard.ts';
import { GhFailure } from '../gh/index.ts';
import type { ResolvedRepo } from '../gh/repo.ts';
import { DEFAULT_HOST, type RepoRef, repoArg, repoSlug, sameRepo } from '../gh/types.ts';
import type { PassthroughPlan } from './policy.ts';
import { firstPositional } from './policy.ts';

/** Room the envelope keeps for argv, stderr and keys under the bound. */
export const ENVELOPE_RESERVE = 4_096;
export const STDERR_MAX = 2_048;

export const Envelope = z.object({
  argv: z.array(z.string()),
  exitCode: z.number().int(),
  json: z.unknown().optional(),
  text: z.string().optional(),
  stdoutPath: z.string().optional(),
  stdoutBytes: z.number().int(),
  stderr: z.string().optional(),
});
export type Envelope = z.infer<typeof Envelope>;

const Input = z.object({
  name: z.array(z.string()).min(1),
  args: z.array(z.string()).min(1),
  inject: z.enum(['flag', 'positional', 'placeholders', 'none']),
  maxBytes: z.number().int().optional(),
});

/** The inline cap for json/text: the bound minus the envelope's reserve. */
export function inlineCap(maxBytes: number): number {
  return Math.max(0, maxBytes - ENVELOPE_RESERVE);
}

/** The last STDERR_MAX bytes of stderr, whole characters only. */
function stderrTail(s: string): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= STDERR_MAX) return s;
  return buf
    .subarray(buf.length - STDERR_MAX)
    .toString('utf8')
    .replace(/^�+/, '');
}

/** The argv that runs: the plan's args with the resolved repo injected the way the verb takes it. */
export function finalArgs(plan: Pick<PassthroughPlan, 'args' | 'inject'>, repo: RepoRef | undefined): string[] {
  const args = [...plan.args];
  if (!repo) return args;
  switch (plan.inject) {
    case 'flag': {
      // Before any `--`, where it would become a positional.
      const at = args.indexOf('--');
      args.splice(at === -1 ? args.length : at, 0, '-R', repoArg(repo));
      return args;
    }
    case 'positional':
      args.splice(2, 0, repoArg(repo));
      return args;
    case 'placeholders': {
      const endpoint = apiShape(args).endpoint;
      if (endpoint === undefined || !/\{(owner|repo)\}/.test(endpoint)) return args;
      const filled = endpoint.replaceAll('{owner}', repo.owner).replaceAll('{repo}', repo.name);
      // The token apiShape reads as the endpoint, not a header or --jq value that happens to match.
      for (let k = 1; k < args.length; k++) {
        if (args[k] !== endpoint) continue;
        const next = [...args];
        next[k] = filled;
        if (apiShape(next).endpoint !== filled) continue;
        if (repo.host !== DEFAULT_HOST && !next.some((a) => a === '--hostname' || a.startsWith('--hostname='))) {
          next.push('--hostname', repo.host);
        }
        return next;
      }
      return args;
    }
    default:
      return args;
  }
}

async function buildEnvelope(
  argv: string[],
  exitCode: number,
  stdout: string,
  stderr: string,
  cap: number,
  spill: (content: string, ext: 'json' | 'txt') => Promise<string>,
): Promise<Envelope> {
  const env: Envelope = { argv: ['gh', ...argv], exitCode, stdoutBytes: byteLength(stdout) };
  let parsed: { value: unknown } | undefined;
  if (stdout.trim() !== '') {
    try {
      parsed = { value: JSON.parse(stdout) };
    } catch {
      parsed = undefined;
    }
  }
  if (parsed && byteLength(JSON.stringify(parsed.value)) <= cap) env.json = parsed.value;
  else if (!parsed && byteLength(JSON.stringify(stdout)) <= cap) env.text = stdout;
  else env.stdoutPath = await spill(stdout, parsed ? 'json' : 'txt');
  if (stderr.trim() !== '') env.stderr = stderrTail(stderr);
  return env;
}

export const passthroughOutput = z.object({ passthrough: Envelope });

/** The synthetic spec for one plan; `ghx <name>` in messages and spill names. */
export function passthroughSpec(name: readonly string[]): AnyCommandSpec {
  return defineCommand({
    name: [name[0] ?? 'gh', ...name.slice(1)],
    summary: `Passthrough: gh ${name.join(' ')} in a JSON envelope`,
    kind: 'read',
    input: Input,
    needs: { repo: 'optional' },
    timeout: { defaultMs: 120_000, maxMs: 600_000 },
    output: passthroughOutput,
    async run(input, ctx) {
      const needsRepo =
        input.inject === 'flag' ||
        input.inject === 'positional' ||
        (input.inject === 'placeholders' && /\{(owner|repo)\}/.test(apiShape(input.args).endpoint ?? ''));
      const resolved = needsRepo ? await ctx.tryRepo() : undefined;
      const planArgs = input.name.join(' ') === 'run list' ? await expandCommit(input.args, ctx, resolved) : input.args;
      const args = finalArgs({ ...input, args: planArgs }, resolved?.repo);
      const envMax = ctx.env.GHX_MAX_BYTES;
      const maxBytes =
        input.maxBytes ?? (envMax !== undefined && /^\d+$/.test(envMax) ? Number(envMax) : DEFAULT_MAX_BYTES);
      const cap = inlineCap(maxBytes);
      const spill = async (content: string, ext: 'json' | 'txt'): Promise<string> => {
        const sha = createHash('sha256').update(content).digest('hex').slice(0, 12);
        const ref = await ctx.artifacts.write({
          kind: 'passthrough',
          name: `${input.name.join('-')}-${sha}.${ext}`,
          content,
        });
        return ref.path;
      };
      try {
        const r = await ctx.gh.exec({ args, mutates: false, timeoutMs: 600_000 });
        return { passthrough: await buildEnvelope(args, r.exitCode, r.stdout, r.stderr, cap, spill) };
      } catch (e) {
        rethrowControlFlow(e);
        const res = e instanceof GhFailure ? e.result : undefined;
        if (!(e instanceof GhFailure) || !res || res.exitCode === null || e.failure.code === 'GH_NOT_INSTALLED') {
          throw e;
        }
        const envelope = { passthrough: await buildEnvelope(args, res.exitCode, res.stdout, res.stderr, cap, spill) };
        const details: ErrorDetails = {
          ...envelope,
          ...(e.failure.status !== undefined ? { status: e.failure.status } : {}),
        };
        if (e.failure.code === 'GH_TOO_LARGE' && input.name.join(' ') === 'pr diff') {
          throw diffTooLarge(input.args, details, e);
        }
        throw new GhxError('GH_FAILED', e.message, {
          hint: `gh exited ${res.exitCode}; its stderr is in details.passthrough.stderr.`,
          details,
          cause: e,
        });
      }
    },
  });
}

/** A SHA shorter than a full one: what an agent copies from `git log --oneline` or a PR page. */
const SHORT_SHA = /^[0-9a-f]{4,39}$/i;

/** Where `run list`'s commit filter sits: the token index and the value (`--commit X`, `--commit=X`, `-c X`, `-cX`). */
function commitFlag(args: readonly string[]): { at: number; value: string; prefix: string } | undefined {
  for (let i = 0; i < args.length; i++) {
    const t = args[i] as string;
    if (t === '--') return undefined;
    if ((t === '--commit' || t === '-c') && args[i + 1] !== undefined) {
      return { at: i + 1, value: args[i + 1] as string, prefix: '' };
    }
    const m = /^(--commit=|-c=?)(.+)$/.exec(t);
    if (m) return { at: i, value: m[2] as string, prefix: m[1] as string };
  }
  return undefined;
}

/**
 * `gh run list --commit` matches full SHAs only: a short one silently lists nothing. Expand it with the
 * local checkout when that is the target repo (with a COMMIT_EXPANDED warning, since the envelope has no
 * notes); otherwise refuse with REF_NOT_FOUND rather than return an empty list that looks like an answer.
 */
async function expandCommit(
  args: readonly string[],
  ctx: Pick<Context, 'git' | 'warn'>,
  resolved: ResolvedRepo | undefined,
): Promise<string[]> {
  const f = commitFlag(args);
  if (f === undefined || !SHORT_SHA.test(f.value)) return [...args];
  const local = resolved?.cwdRepo !== undefined && sameRepo(resolved.cwdRepo, resolved.repo);
  const full = local ? await ctx.git.revParse(f.value) : undefined;
  if (full === undefined) {
    const slug = resolved ? repoSlug(resolved.repo) : '{owner}/{repo}';
    throw new GhxError(
      'REF_NOT_FOUND',
      `--commit ${f.value} is a short SHA; gh run list matches full 40-character SHAs only, so it would list nothing.`,
      {
        hint: local
          ? `${f.value} is not a commit in the local checkout; git fetch, or pass the full SHA (ghx api repos/${slug}/commits/${f.value} returns it as sha).`
          : `Pass the full SHA: git rev-parse ${f.value} in a checkout of ${slug}, or ghx api repos/${slug}/commits/${f.value} (its sha).`,
        details: { commit: f.value, localCheckout: local },
      },
    );
  }
  ctx.warn({
    code: 'COMMIT_EXPANDED',
    message: `--commit ${f.value} was expanded to ${full} from the local checkout; gh run list matches full SHAs only.`,
  });
  const out = [...args];
  out[f.at] = `${f.prefix}${full}`;
  return out;
}

/** `pr diff` past GitHub's 300-file limit (HTTP 406, G-300): point at a local diff. */
function diffTooLarge(args: readonly string[], details: ErrorDetails, cause: unknown): GhxError {
  const sel = firstPositional(args.slice(2));
  const n = sel !== undefined ? (/^#?(\d+)$/.exec(sel)?.[1] ?? /\/pull\/(\d+)/.exec(sel)?.[1]) : undefined;
  const suggestion = n !== undefined ? ['git', 'fetch', 'origin', `pull/${n}/head`] : undefined;
  const hint =
    n !== undefined
      ? `Diff locally: git fetch origin pull/${n}/head && git diff --stat origin/<base>...FETCH_HEAD (ghx pr status ${n} names the base).`
      : 'Diff locally in a checkout: git diff --stat origin/<base>...origin/<head>.';
  return new GhxError('DIFF_TOO_LARGE', "The PR diff exceeds GitHub's 300-file limit (HTTP 406).", {
    hint,
    details: { ...details, ...(suggestion ? { suggestion } : {}) },
    cause,
  });
}
