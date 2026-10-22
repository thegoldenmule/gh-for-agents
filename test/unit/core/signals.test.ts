import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { GhxError, isGhxError } from '../../../src/core/errors.ts';
import {
  createDeadline,
  createShutdown,
  GRACE_MS,
  installSignalHandlers,
  isAbort,
  withinGrace,
} from '../../../src/core/signals.ts';
import { FakeClock, flush } from '../../helpers/fake-clock.ts';

test('first trigger aborts with INTERRUPTED carrying the signal; second resolves forced', async () => {
  const s = createShutdown();
  let forced = false;
  void s.forced.then(() => {
    forced = true;
  });
  s.trigger('SIGTERM');
  assert.ok(s.signal.aborted);
  assert.ok(isGhxError(s.signal.reason, 'INTERRUPTED'));
  assert.deepEqual((s.signal.reason as GhxError).details, { signal: 'SIGTERM' });
  assert.equal((s.signal.reason as GhxError).exitCode, 143);
  await flush();
  assert.equal(forced, false);
  s.trigger('SIGINT');
  await flush();
  assert.equal(forced, true);
  assert.equal(s.cause, 'SIGTERM');
  assert.equal(s.count, 2);
});

test('installSignalHandlers routes and uninstalls', () => {
  const src = new EventEmitter();
  const s = createShutdown();
  const off = installSignalHandlers(s, src);
  assert.equal(src.listenerCount('SIGINT'), 1);
  src.emit('SIGINT');
  assert.equal(s.cause, 'SIGINT');
  assert.equal((s.signal.reason as GhxError).exitCode, 130);
  off();
  assert.equal(src.listenerCount('SIGINT') + src.listenerCount('SIGTERM') + src.listenerCount('SIGHUP'), 0);
});

test('deadline aborts with TIMEOUT on the fake clock', async () => {
  const clock = new FakeClock();
  const s = createShutdown();
  const d = createDeadline(clock, 60_000, s.signal, 'pr merge');
  assert.equal(d.at, 60_000);
  await clock.advance(59_999);
  assert.equal(d.signal.aborted, false);
  await clock.advance(1);
  assert.ok(isGhxError(d.signal.reason, 'TIMEOUT'));
  assert.deepEqual((d.signal.reason as GhxError).details, { deadlineMs: 60_000 });
  assert.match((d.signal.reason as GhxError).message, /pr merge exceeded its 1m deadline/);
});

test('deadline signal follows the shutdown; cancel stops the timer', async () => {
  const clock = new FakeClock();
  const s = createShutdown();
  const d = createDeadline(clock, 60_000, s.signal);
  d.cancel();
  await flush();
  assert.equal(clock.pendingTimers(), 0);
  s.trigger('SIGINT');
  assert.ok(isGhxError(d.signal.reason, 'INTERRUPTED'));
});

test('no deadline: only the shutdown aborts, no timer is armed', async () => {
  const clock = new FakeClock();
  const s = createShutdown();
  const d = createDeadline(clock, null, s.signal);
  assert.equal(d.at, undefined);
  assert.equal(clock.pendingTimers(), 0);
  await clock.advance(24 * 3_600_000);
  assert.equal(d.signal.aborted, false);
  s.trigger('SIGTERM');
  assert.ok(d.signal.aborted);
});

test('withinGrace returns the value when work settles inside the window', async () => {
  const clock = new FakeClock();
  const s = createShutdown();
  s.trigger('SIGTERM');
  const work = clock.sleep(1_000).then(() => 'summary');
  const p = withinGrace(work, { clock, shutdown: s });
  await clock.advance(1_000);
  assert.deepEqual(await p, { settled: true, value: 'summary' });
});

test('withinGrace gives up when the grace window expires', async () => {
  const clock = new FakeClock();
  const s = createShutdown();
  s.trigger('SIGTERM');
  const p = withinGrace(new Promise(() => {}), { clock, shutdown: s });
  await clock.advance(GRACE_MS - 1);
  let settled = false;
  void p.then(() => {
    settled = true;
  });
  await flush();
  assert.equal(settled, false);
  await clock.advance(1);
  assert.deepEqual(await p, { settled: false });
});

test('a second signal skips the grace window', async () => {
  const clock = new FakeClock();
  const s = createShutdown();
  s.trigger('SIGTERM');
  const p = withinGrace(new Promise(() => {}), { clock, shutdown: s });
  s.trigger('SIGTERM');
  assert.deepEqual(await p, { settled: false });
  assert.equal(clock.monotonic(), 0);
});

test('withinGrace reports a rejected work as settled with the error', async () => {
  const clock = new FakeClock();
  const s = createShutdown();
  const r = await withinGrace(Promise.reject(new Error('x')), { clock, shutdown: s });
  assert.ok(r.settled && 'error' in r);
});

test('isAbort', () => {
  assert.ok(isAbort(new GhxError('INTERRUPTED', 'x')));
  assert.ok(isAbort(new GhxError('TIMEOUT', 'x')));
  assert.ok(!isAbort(new GhxError('GH_FAILED', 'x')));
  assert.ok(!isAbort(new Error('x')));
});
