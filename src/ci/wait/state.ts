// The ci wait state store (02 §11.1 resumability; 03 M4.6). One JSON file per repo + target + bound SHA
// under <artifacts>/<host>/<owner>/<repo>/ci-wait/, written atomically (temp file + rename), plus a
// per-target index naming the latest bound SHA, so a re-run can send its first poll with the stored
// ETags before it knows the head. A corrupt file is a miss (WAIT_STATE_DISCARDED); state expires 24 h
// after every check of its SHA completed. A per-target lock file serialises concurrent runs.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ArtifactStore } from '../../core/artifacts.ts';
import type { Clock } from '../../core/clock.ts';
import { secureHex } from '../../core/random.ts';
import type { RepoRef } from '../../gh/types.ts';
import { Bucket, CiPhase, FailingJob, Outcome, TargetSummary } from '../../schemas/ci.ts';
import { Sha } from '../../schemas/common.ts';
import type { BaselineStats } from './eta.ts';
import type { WorkflowTimeouts } from './job-timeouts.ts';
import type { MachineState } from './machine.ts';
import { type PollerState, WorkflowRunNode } from './poller.ts';

export const STATE_TTL_AFTER_SETTLE_MS = 24 * 60 * 60_000;
export const LOCK_POLL_MS = 1_000;

const MachineStateSchema = z.object({
  target: z.string(),
  boundSha: Sha,
  boundAt: z.number(),
  phase: CiPhase.nullable(),
  buckets: z.record(z.string(), Bucket),
  expected: z.array(
    z.object({ name: z.string(), workflow: z.string().nullable(), source: z.enum(['required', 'config', 'baseline']) }),
  ),
  agedOut: z.array(z.string()),
  othersSettledAt: z.number().nullable(),
  seenFailures: z.array(z.string()),
  reported: z.array(z.string()),
  lastEventAt: z.number(),
});

const JobStatsSchema = z.object({
  samples: z.number(),
  medianSec: z.number(),
  p90Sec: z.number(),
  queueMedianSec: z.number(),
  source: z.enum(['push', 'pull_request']),
});

const TimeoutsSchema = z.object({
  jobs: z.array(
    z.object({
      id: z.string(),
      name: z.string().nullable(),
      timeoutMinutes: z.number().nullable(),
      matrix: z.boolean(),
      uses: z.boolean(),
    }),
  ),
});

export const WaitStateSchema = z.object({
  v: z.literal(1),
  target: z.string(),
  boundSha: Sha,
  savedAt: z.number(),
  /** Epoch ms when every check of the SHA had completed; null while anything is pending. */
  settledAt: z.number().nullable(),
  /** Epoch ms the wait for this target first started (elapsedSec; not reset by a head restart). */
  waitStartedAt: z.number(),
  restarts: z.number().int().min(0),
  base: z.string(),
  defaultBranch: z.string(),
  machine: MachineStateSchema,
  poller: z.object({
    etags: z.record(z.string(), z.object({ etag: z.string(), body: z.unknown() })),
    suites: z.record(z.string(), WorkflowRunNode.nullable()),
    suiteLookups: z.record(z.string(), z.number()),
  }),
  baselines: z.record(z.string(), JobStatsSchema),
  /** Workflow ids whose ETA samples were read. */
  etaWorkflows: z.array(z.number()),
  /** Scanned workflow files by run id; null = unreadable. */
  timeouts: z.record(z.string(), TimeoutsSchema.nullable()),
  /** Full diagnoses by job id. */
  diagnoses: z.record(z.string(), FailingJob),
  diagnosis: z.object({ spentMs: z.number(), partial: z.boolean() }),
  /** The last outcome returned for this SHA. */
  terminal: z.object({ outcome: Outcome, settled: z.boolean(), summary: TargetSummary }).nullable(),
});

export type WaitState = Omit<z.infer<typeof WaitStateSchema>, 'machine' | 'poller' | 'baselines' | 'timeouts'> & {
  machine: MachineState;
  poller: PollerState;
  baselines: BaselineStats;
  timeouts: Record<string, WorkflowTimeouts | null>;
};

const Index = z.object({ v: z.literal(1), boundSha: Sha, savedAt: z.number() });

export type LoadResult =
  | { kind: 'hit'; state: WaitState }
  | { kind: 'miss' }
  | { kind: 'expired' }
  | { kind: 'discarded'; reason: string };

export interface WaitStore {
  readonly dir: string;
  /** The latest bound SHA for a target, if a previous run saved one. */
  latest(key: string): string | undefined;
  load(key: string, boundSha: string): LoadResult;
  /** Atomic write of the state and the target's index. */
  save(key: string, state: WaitState): void;
  /** Wait for the target's lock; resolves with its release. A lock whose holder is gone is broken. */
  lock(key: string, o: { signal: AbortSignal; onStale?: (pid: number | null) => void }): Promise<() => void>;
}

/** A target key as a file-name segment. */
export function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._@-]+/g, '_').slice(0, 120);
}

function readJson(path: string): { ok: true; value: unknown } | { ok: false; missing: boolean; message: string } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return { ok: false, missing: (e as NodeJS.ErrnoException).code === 'ENOENT', message: String(e) };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, missing: false, message: e instanceof Error ? e.message : String(e) };
  }
}

function writeAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${secureHex(4)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

/** True when a process with this pid exists (EPERM: it exists, owned by someone else). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function createWaitStore(o: {
  artifacts: ArtifactStore;
  repo: RepoRef;
  clock: Clock;
  /** The holder pid written to lock files (tests pass another to simulate a dead holder). */
  pid?: number;
  alive?: (pid: number) => boolean;
}): Promise<WaitStore> {
  const marker = await o.artifacts.pathFor('ci-wait', '.keep', o.repo);
  const dir = join(marker, '..');
  mkdirSync(dir, { recursive: true });
  const statePath = (key: string, sha: string) => join(dir, `${safeKey(key)}-${sha}.json`);
  const indexPath = (key: string) => join(dir, `${safeKey(key)}.index.json`);
  const alive = o.alive ?? pidAlive;
  return {
    dir,
    latest(key) {
      const r = readJson(indexPath(key));
      if (!r.ok) return undefined;
      const p = Index.safeParse(r.value);
      return p.success ? p.data.boundSha : undefined;
    },
    load(key, boundSha) {
      const path = statePath(key, boundSha);
      const r = readJson(path);
      if (!r.ok) return r.missing ? { kind: 'miss' } : { kind: 'discarded', reason: r.message };
      const p = WaitStateSchema.safeParse(r.value);
      if (!p.success) {
        const issue = p.error.issues[0];
        return { kind: 'discarded', reason: `${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'invalid'}` };
      }
      if (p.data.boundSha !== boundSha) return { kind: 'discarded', reason: 'bound SHA mismatch' };
      if (p.data.settledAt !== null && o.clock.now() - p.data.settledAt > STATE_TTL_AFTER_SETTLE_MS) {
        rmSync(path, { force: true });
        return { kind: 'expired' };
      }
      return { kind: 'hit', state: p.data as WaitState };
    },
    save(key, state) {
      writeAtomic(statePath(key, state.boundSha), state);
      writeAtomic(indexPath(key), { v: 1, boundSha: state.boundSha, savedAt: state.savedAt });
    },
    async lock(key, l) {
      const path = join(dir, `${safeKey(key)}.lock`);
      const pid = o.pid ?? process.pid;
      for (;;) {
        try {
          writeFileSync(path, JSON.stringify({ pid }), { flag: 'wx' });
          let released = false;
          return () => {
            if (released) return;
            released = true;
            rmSync(path, { force: true });
          };
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }
        const r = readJson(path);
        const holder = r.ok ? z.object({ pid: z.number().int() }).safeParse(r.value) : undefined;
        if (!holder?.success || !alive(holder.data.pid)) {
          l.onStale?.(holder?.success ? holder.data.pid : null);
          rmSync(path, { force: true });
          continue;
        }
        await o.clock.sleep(LOCK_POLL_MS, l.signal);
      }
    },
  };
}
