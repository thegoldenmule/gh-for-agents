// The ci wait state store (02 §11.1 resumability; 03 M4.6). One JSON file per repo + target + bound SHA
// under <artifacts>/<host>/<owner>/<repo>/ci-wait/, written atomically (temp file + rename), plus a
// per-target index naming the latest bound SHA, so a re-run can send its first poll with the stored
// ETags before it knows the head. A corrupt file is a miss (WAIT_STATE_DISCARDED); state expires 24 h
// after the later of its last save and the completion of every check of its SHA. A per-target lock covers only one load or save (04, wave 4
// review), and only one key is ever held, so there is no lock order.
// One wait per target: a per-target lease (`<key>.lease`) names the process polling it. A second wait on
// the same target, repo and machine finds it held and follows instead of polling: it reads the leader's
// saved state until a terminal answer to its own question appears, or takes the lease over once the
// leader is gone (it exited, its pid is dead, or it is past the `until` it promised to be back by).
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
/** Real-time retry interval while another process holds a lock (holds last one file read or write). */
export const LOCK_POLL_MS = 5;
/** How long a load or save waits for a lock before breaking it (WAIT_STATE_DISCARDED). */
export const LOCK_WAIT_MS = 2_000;
/** A lock older than this (by its own timestamp) is stale even if its pid is alive: the pid was reused. */
export const LOCK_STALE_MS = 30_000;
/** A lease holder promises to refresh it by `until` (its next wake plus this grace), or it is stale. */
export const LEASE_GRACE_MS = 2 * 60_000;

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
  firstSeen: z.record(z.string(), z.number()).optional(),
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
    rollup: z.record(z.string(), z.union([z.literal(true), z.number()])).optional(),
  }),
  baselines: z.record(z.string(), JobStatsSchema),
  /** Workflow ids whose ETA samples were read. */
  etaWorkflows: z.array(z.number()),
  /** Scanned workflow files by run id; null = unreadable. */
  timeouts: z.record(z.string(), TimeoutsSchema.nullable()),
  /** Full diagnoses by job id. */
  diagnoses: z.record(z.string(), FailingJob),
  diagnosis: z.object({
    spentMs: z.number(),
    partial: z.boolean(),
    /** Job ids diagnosed under --no-compare-main: a comparing run diagnoses them again. */
    uncompared: z.array(z.string()).optional(),
  }),
  /** The last outcome returned for this SHA. */
  terminal: z
    .object({
      outcome: Outcome,
      settled: z.boolean(),
      summary: TargetSummary,
      /** The --until and sorted --check of the run that stored it (a resume honours only the same question). */
      until: z.string().optional(),
      check: z.array(z.string()).optional(),
      /** Whether that run compared failures with main (absent: stored before this was recorded). */
      compareMain: z.boolean().optional(),
    })
    .nullable(),
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
  /**
   * Atomic write of the state and the target's index. `alsoIndex` names further keys whose index points
   * at this binding (an unpinned branch target, whose state lives under its pinned key).
   */
  save(key: string, state: WaitState, alsoIndex?: string): void;
  /** Run `fn` holding the target's lock (load and save take it themselves). */
  withLock<T>(key: string, fn: () => T): T;
  /**
   * Take the target's lease, promising to refresh it by `until` (epoch ms): the lease, or the live holder.
   * A stale lease (dead pid, past its `until`, unreadable) is broken first (onStale).
   */
  lease(key: string, until: number): Lease | { holder: LeaseHolder };
}

export interface LeaseHolder {
  pid: number;
  at: number;
  until: number;
}

export interface Lease {
  /** Promise the next refresh by `until`; false when the lease was lost (broken as stale by another wait). */
  refresh(until: number): boolean;
  /** Give it up (only while it is still this one). Idempotent. */
  release(): void;
}

const LeaseFile = z.object({ pid: z.number().int(), at: z.number(), until: z.number(), nonce: z.string() });

const LockFile = z.object({ pid: z.number().int(), at: z.number(), nonce: z.string() });

/** Block the thread for `ms` (a lock is held for one file operation, so waits are milliseconds). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
  /**
   * A lock was broken: its holder is gone, it is older than LOCK_STALE_MS, or the wait bound passed. Or a
   * lease (`lease: true`): its holder is gone, or it is past its `until` ('old').
   */
  onStale?: (o: { pid: number | null; reason: 'gone' | 'old' | 'timeout' | 'unreadable'; lease?: boolean }) => void;
  /** Default LOCK_WAIT_MS (tests shorten it). */
  lockWaitMs?: number;
}): Promise<WaitStore> {
  const marker = await o.artifacts.pathFor('ci-wait', '.keep', o.repo);
  const dir = join(marker, '..');
  mkdirSync(dir, { recursive: true });
  const statePath = (key: string, sha: string) => join(dir, `${safeKey(key)}-${sha}.json`);
  const indexPath = (key: string) => join(dir, `${safeKey(key)}.index.json`);
  const alive = o.alive ?? pidAlive;
  const pid = o.pid ?? process.pid;

  /** Take the lock: a complete lock file appears atomically (temp file + link), or EEXIST. */
  const acquire = (path: string): string | null => {
    const nonce = secureHex(8);
    const tmp = `${path}.${nonce}.tmp`;
    writeFileSync(tmp, JSON.stringify({ pid, at: o.clock.now(), nonce }));
    try {
      linkSync(tmp, path);
      return nonce;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      return null;
    } finally {
      rmSync(tmp, { force: true });
    }
  };
  const holder = (path: string) => {
    const r = readJson(path);
    if (!r.ok) return r.missing ? undefined : null;
    const p = LockFile.safeParse(r.value);
    return p.success ? p.data : null;
  };
  /** Remove the lock only while it still carries `nonce` (never another process's lock). */
  const removeIf = (path: string, nonce: string | null): void => {
    const h = holder(path);
    if (h === undefined) return;
    if (nonce === null ? h === null : h?.nonce === nonce) rmSync(path, { force: true });
  };
  const withLock = <T>(key: string, fn: () => T): T => {
    const path = join(dir, `${safeKey(key)}.lock`);
    // Bounded by attempts (real time; the clock may be fake): each failed attempt sleeps LOCK_POLL_MS.
    const attempts = Math.ceil((o.lockWaitMs ?? LOCK_WAIT_MS) / LOCK_POLL_MS);
    let tries = 0;
    let nonce: string | null;
    for (;;) {
      nonce = acquire(path);
      if (nonce !== null) break;
      const h = holder(path);
      if (h === undefined) continue;
      const reason =
        h === null
          ? 'unreadable'
          : !alive(h.pid)
            ? 'gone'
            : o.clock.now() - h.at > LOCK_STALE_MS
              ? 'old'
              : ++tries > attempts
                ? 'timeout'
                : null;
      if (reason === null) {
        sleepSync(LOCK_POLL_MS);
        continue;
      }
      o.onStale?.({ pid: h?.pid ?? null, reason });
      removeIf(path, h?.nonce ?? null);
    }
    try {
      return fn();
    } finally {
      removeIf(path, nonce);
    }
  };
  const leasePath = (key: string) => join(dir, `${safeKey(key)}.lease`);
  const leaseHolder = (path: string) => {
    const r = readJson(path);
    if (!r.ok) return r.missing ? undefined : null;
    const p = LeaseFile.safeParse(r.value);
    return p.success ? p.data : null;
  };
  const lease = (key: string, until: number): Lease | { holder: LeaseHolder } => {
    const path = leasePath(key);
    for (;;) {
      const nonce = secureHex(8);
      const tmp = `${path}.${nonce}.tmp`;
      writeFileSync(tmp, JSON.stringify({ pid, at: o.clock.now(), until, nonce }));
      try {
        linkSync(tmp, path);
        return heldLease(path, nonce);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      } finally {
        rmSync(tmp, { force: true });
      }
      const h = leaseHolder(path);
      if (h === undefined) continue;
      const reason = h === null ? 'unreadable' : !alive(h.pid) ? 'gone' : o.clock.now() > h.until ? 'old' : null;
      if (reason === null && h !== null) return { holder: { pid: h.pid, at: h.at, until: h.until } };
      o.onStale?.({ pid: h?.pid ?? null, reason: reason ?? 'unreadable', lease: true });
      // Remove it only while it is still the stale one (another wait may have broken and retaken it).
      const again = leaseHolder(path);
      if (again !== undefined && (again === null ? h === null : again.nonce === h?.nonce))
        rmSync(path, { force: true });
    }
  };
  const heldLease = (path: string, nonce: string): Lease => {
    let held = true;
    const mine = () => held && leaseHolder(path)?.nonce === nonce;
    return {
      refresh(until) {
        if (!mine()) {
          held = false;
          return false;
        }
        writeAtomic(path, { pid, at: o.clock.now(), until, nonce });
        return true;
      },
      release() {
        if (mine()) rmSync(path, { force: true });
        held = false;
      },
    };
  };
  return {
    dir,
    lease,
    latest(key) {
      const r = readJson(indexPath(key));
      if (!r.ok) return undefined;
      const p = Index.safeParse(r.value);
      return p.success ? p.data.boundSha : undefined;
    },
    withLock,
    load(key, boundSha) {
      return withLock(key, () => loadUnlocked(key, boundSha));
    },
    save(key, state, alsoIndex) {
      const index = { v: 1, boundSha: state.boundSha, savedAt: state.savedAt };
      withLock(key, () => {
        writeAtomic(statePath(key, state.boundSha), withReported(loadUnlocked(key, state.boundSha), state));
        writeAtomic(indexPath(key), index);
      });
      if (alsoIndex !== undefined && alsoIndex !== key)
        withLock(alsoIndex, () => writeAtomic(indexPath(alsoIndex), index));
    },
  };

  /**
   * Concurrent waits on one SHA each poll on their own (04): a save keeps the failures the other already
   * reported (first-failure continuation), never replacing them. The caller's state is not changed.
   */
  function withReported(prev: LoadResult, state: WaitState): WaitState {
    if (prev.kind !== 'hit') return state;
    const reported = [...new Set([...state.machine.reported, ...prev.state.machine.reported])];
    if (reported.length === state.machine.reported.length) return state;
    return { ...state, machine: { ...state.machine, reported } };
  }

  function loadUnlocked(key: string, boundSha: string): LoadResult {
    const path = statePath(key, boundSha);
    const r = readJson(path);
    if (!r.ok) return r.missing ? { kind: 'miss' } : { kind: 'discarded', reason: r.message };
    const p = WaitStateSchema.safeParse(r.value);
    if (!p.success) {
      const issue = p.error.issues[0];
      return { kind: 'discarded', reason: `${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'invalid'}` };
    }
    if (p.data.boundSha !== boundSha) return { kind: 'discarded', reason: 'bound SHA mismatch' };
    // From the later of CI completion and the last save (04, final review): state saved today for a PR
    // that settled last week is fresh. Unsettled state expires 24 h after its last save.
    if (o.clock.now() - Math.max(p.data.settledAt ?? 0, p.data.savedAt) > STATE_TTL_AFTER_SETTLE_MS) {
      rmSync(path, { force: true });
      return { kind: 'expired' };
    }
    return { kind: 'hit', state: p.data as WaitState };
  }
}
