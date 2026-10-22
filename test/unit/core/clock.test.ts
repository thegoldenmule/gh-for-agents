import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isoNow, realClock } from '../../../src/core/clock.ts';
import { FakeClock } from '../../helpers/fake-clock.ts';

test('realClock.sleep rejects with the abort reason', async () => {
  const c = new AbortController();
  const p = realClock.sleep(10_000, c.signal);
  c.abort(new Error('stop'));
  await assert.rejects(p, /stop/);
  await assert.rejects(realClock.sleep(1, c.signal), /stop/);
});

test('FakeClock fires timers in order and only when advanced', async () => {
  const clock = new FakeClock(0);
  const fired: string[] = [];
  void clock.sleep(200).then(() => fired.push(`b@${clock.monotonic()}`));
  void clock.sleep(100).then(() => fired.push(`a@${clock.monotonic()}`));
  await clock.advance(50);
  assert.deepEqual(fired, []);
  assert.equal(clock.pendingTimers(), 2);
  await clock.advance(1_000);
  assert.deepEqual(fired, ['a@100', 'b@200']);
  assert.equal(clock.monotonic(), 1_050);
  assert.equal(clock.now(), 1_050);
});

test('FakeClock runs chained sleeps inside one advance', async () => {
  const clock = new FakeClock(0);
  let ticks = 0;
  void (async () => {
    for (let i = 0; i < 5; i++) {
      await clock.sleep(60_000);
      ticks++;
    }
  })();
  await clock.advance(10 * 60_000);
  assert.equal(ticks, 5);
});

test('FakeClock sleep rejects on abort and drops the timer', async () => {
  const clock = new FakeClock();
  const c = new AbortController();
  const p = clock.sleep(1_000, c.signal);
  c.abort(new Error('nope'));
  await assert.rejects(p, /nope/);
  assert.equal(clock.pendingTimers(), 0);
});

test('runUntil advances until the predicate holds, and gives up', async () => {
  const clock = new FakeClock(0);
  let done = false;
  void clock.sleep(45 * 60_000).then(() => {
    done = true;
  });
  await clock.runUntil(() => done, { stepMs: 60_000 });
  assert.equal(clock.monotonic(), 45 * 60_000);
  await assert.rejects(
    clock.runUntil(() => false, { maxMs: 5_000 }),
    /not met/,
  );
});

test('isoNow formats the clock epoch', () => {
  assert.equal(isoNow(new FakeClock(Date.UTC(2026, 9, 22, 9, 47))), '2026-10-22T09:47:00.000Z');
});
