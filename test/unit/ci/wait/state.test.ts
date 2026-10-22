// The wait state store (03 M4.6): round trip, index, corrupt files, expiry and the per-target lock.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { initialState } from '../../../../src/ci/wait/machine.ts';
import { emptyPollerState } from '../../../../src/ci/wait/poller.ts';
import { createWaitStore, STATE_TTL_AFTER_SETTLE_MS, safeKey, type WaitState } from '../../../../src/ci/wait/state.ts';
import { createArtifactStore } from '../../../../src/core/artifacts.ts';
import { FakeClock } from '../../../helpers/fake-clock.ts';
import { scratchDir } from '../../../helpers/harness.ts';

const repo = { host: 'github.com', owner: 'o', name: 'r' };
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

async function store(o: { pid?: number; alive?: (pid: number) => boolean } = {}) {
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

test('a pending SHA never expires', async () => {
  const { clock, s } = await store();
  s.save('pr-7', state(clock));
  await clock.advance(3 * STATE_TTL_AFTER_SETTLE_MS);
  assert.equal(s.load('pr-7', A).kind, 'hit');
});

test('the lock: a second run waits on the clock until the first releases', async () => {
  const { s, clock } = await store();
  const signal = new AbortController().signal;
  const release = await s.lock('pr-7', { signal });
  const box: { release?: () => void } = {};
  void s.lock('pr-7', { signal }).then((r) => {
    box.release = r;
  });
  await clock.advance(5_000);
  assert.ok(box.release === undefined, 'still waiting');
  release();
  await clock.advance(1_000);
  const got = box.release as (() => void) | undefined;
  assert.ok(got, 'acquired after the holder released');
  got();
  assert.equal(existsSync(join(s.dir, `${safeKey('pr-7')}.lock`)), false, 'release removes the lock file');
});

test('a stale lock (holder pid gone) is broken and reported', async () => {
  const { s } = await store({ alive: () => false });
  writeFileSync(join(s.dir, `${safeKey('pr-7')}.lock`), JSON.stringify({ pid: 999_999 }));
  const stale: (number | null)[] = [];
  const release = await s.lock('pr-7', { signal: new AbortController().signal, onStale: (p) => stale.push(p) });
  assert.deepEqual(stale, [999_999]);
  release();
});
