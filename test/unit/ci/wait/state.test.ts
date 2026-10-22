// The wait state store (03 M4.6): round trip, index, corrupt files, expiry and the per-target lock.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { initialState } from '../../../../src/ci/wait/machine.ts';
import { emptyPollerState } from '../../../../src/ci/wait/poller.ts';
import {
  createWaitStore,
  LOCK_STALE_MS,
  LOCK_WAIT_MS,
  STATE_TTL_AFTER_SETTLE_MS,
  safeKey,
  type WaitState,
} from '../../../../src/ci/wait/state.ts';
import { createArtifactStore } from '../../../../src/core/artifacts.ts';
import { FakeClock } from '../../../helpers/fake-clock.ts';
import { scratchDir } from '../../../helpers/harness.ts';

const repo = { host: 'github.com', owner: 'o', name: 'r' };
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

async function store(o: Omit<Parameters<typeof createWaitStore>[0], 'artifacts' | 'repo' | 'clock'> = {}) {
  const clock = new FakeClock();
  const root = mkdtempSync(join(scratchDir(), 'state-'));
  const s = await createWaitStore({ artifacts: createArtifactStore({ root, clock }), repo, clock, ...o });
  return { clock, s, root };
}

function state(clock: FakeClock, sha = A, o: Partial<WaitState> = {}): WaitState {
  return {
    v: 1,
    target: 'o/r#7',
    boundSha: sha,
    savedAt: clock.now(),
    settledAt: null,
    waitStartedAt: clock.now(),
    restarts: 0,
    base: 'main',
    defaultBranch: 'main',
    machine: initialState({ target: 'o/r#7', boundSha: sha, boundAt: clock.now(), expected: [] }),
    poller: emptyPollerState(),
    baselines: {},
    etaWorkflows: [],
    timeouts: {},
    diagnoses: {},
    diagnosis: { spentMs: 0, partial: false },
    terminal: null,
    ...o,
  };
}

test('save, then latest and load round-trip; another SHA is a miss', async () => {
  const { clock, s } = await store();
  assert.equal(s.latest('pr-7'), undefined);
  assert.equal(s.load('pr-7', A).kind, 'miss');
  s.save('pr-7', state(clock));
  assert.equal(s.latest('pr-7'), A);
  const r = s.load('pr-7', A);
  assert.equal(r.kind, 'hit');
  assert.equal(r.kind === 'hit' && r.state.machine.boundSha, A);
  assert.equal(s.load('pr-7', B).kind, 'miss');
  s.save('pr-7', state(clock, B));
  assert.equal(s.latest('pr-7'), B, 'the index follows the latest binding');
  assert.equal(s.load('pr-7', A).kind, 'hit', 'the old state stays until it expires');
});

test('a corrupt or partial state file is discarded with a reason', async () => {
  const { clock, s } = await store();
  s.save('pr-7', state(clock));
  writeFileSync(join(s.dir, `${safeKey('pr-7')}-${A}.json`), '{"v":1,"target":');
  const r = s.load('pr-7', A);
  assert.equal(r.kind, 'discarded');
  writeFileSync(join(s.dir, `${safeKey('pr-7')}-${A}.json`), JSON.stringify({ v: 1, target: 'x' }));
  assert.equal(s.load('pr-7', A).kind, 'discarded');
});

test('state expires 24 h after its SHA settled, not before', async () => {
  const { clock, s } = await store();
  s.save('pr-7', state(clock, A, { settledAt: clock.now() }));
  await clock.advance(STATE_TTL_AFTER_SETTLE_MS);
  assert.equal(s.load('pr-7', A).kind, 'hit');
  await clock.advance(1);
  assert.equal(s.load('pr-7', A).kind, 'expired');
  assert.equal(s.load('pr-7', A).kind, 'miss', 'the expired file is removed');
});

test('expiry counts from the later of settle and save: old CI saved today is fresh', async () => {
  const { clock, s } = await store();
  await clock.advance(3 * STATE_TTL_AFTER_SETTLE_MS);
  s.save('pr-7', state(clock, A, { settledAt: clock.now() - 2 * STATE_TTL_AFTER_SETTLE_MS }));
  assert.equal(s.load('pr-7', A).kind, 'hit');
  await clock.advance(STATE_TTL_AFTER_SETTLE_MS);
  assert.equal(s.load('pr-7', A).kind, 'hit');
  await clock.advance(1);
  assert.equal(s.load('pr-7', A).kind, 'expired');
});

test('a pending SHA expires 24 h after its last save', async () => {
  const { clock, s } = await store();
  s.save('pr-7', state(clock));
  await clock.advance(STATE_TTL_AFTER_SETTLE_MS);
  assert.equal(s.load('pr-7', A).kind, 'hit');
  await clock.advance(1);
  assert.equal(s.load('pr-7', A).kind, 'expired');
});

const lockPath = (s: { dir: string }) => join(s.dir, `${safeKey('pr-7')}.lock`);
const lockFile = (pid: number, at: number, nonce = 'other') => JSON.stringify({ pid, at, nonce });

test('the lock covers one call: held inside withLock with a complete lock file, removed after', async () => {
  const { s } = await store();
  const seen = s.withLock('pr-7', () => JSON.parse(readFileSync(lockPath(s), 'utf8')));
  assert.equal(seen.pid, process.pid);
  assert.equal(typeof seen.nonce, 'string');
  assert.equal(existsSync(lockPath(s)), false, 'released');
});

test('release never deletes a lock another process now holds (nonce check)', async () => {
  const { s, clock } = await store();
  s.withLock('pr-7', () => writeFileSync(lockPath(s), lockFile(process.pid, clock.now())));
  assert.equal(existsSync(lockPath(s)), true, 'the other holder keeps its lock');
});

test('a live holder blocks only up to the bound, then the lock is broken (timeout)', async () => {
  const stale: string[] = [];
  const { s, clock } = await store({ lockWaitMs: 30, onStale: (x) => stale.push(x.reason) });
  writeFileSync(lockPath(s), lockFile(process.pid, clock.now()));
  const t0 = Date.now();
  s.save('pr-7', state(clock));
  assert.ok(Date.now() - t0 >= 30);
  assert.deepEqual(stale, ['timeout']);
  assert.equal(s.load('pr-7', A).kind, 'hit');
});

test('a reused pid does not block: a lock older than LOCK_STALE_MS is stale although its pid is alive', async () => {
  const stale: string[] = [];
  const { s, clock } = await store({ onStale: (x) => stale.push(x.reason) });
  writeFileSync(lockPath(s), lockFile(process.pid, clock.now()));
  await clock.advance(LOCK_STALE_MS + 1);
  const t0 = Date.now();
  s.save('pr-7', state(clock));
  assert.ok(Date.now() - t0 < LOCK_WAIT_MS, 'broken at once, not after the bound');
  assert.deepEqual(stale, ['old']);
});

test('a lock whose holder pid is gone is broken and reported', async () => {
  const stale: (number | null)[] = [];
  const { s, clock } = await store({ alive: () => false, onStale: (x) => stale.push(x.pid) });
  writeFileSync(lockPath(s), lockFile(999_999, clock.now()));
  s.save('pr-7', state(clock));
  assert.deepEqual(stale, [999_999]);
});
