import assert from 'node:assert/strict';
import { test } from 'node:test';
import { poll } from '../../../src/core/poll.ts';
import { seededRandom } from '../../../src/core/random.ts';
import { FakeClock } from '../../helpers/fake-clock.ts';

async function drain<T>(gen: AsyncGenerator<T, T, void>): Promise<{ yielded: T[]; result: T }> {
  const yielded: T[] = [];
  for (;;) {
    const r = await gen.next();
    if (r.done) return { yielded, result: r.value };
    yielded.push(r.value);
  }
}

test('backs off by factor up to maxMs and returns the done value', async () => {
  const clock = new FakeClock(0);
  const seen: number[] = [];
  const values = ['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'MERGEABLE'];
  const gen = poll({
    probe: async () => {
      seen.push(clock.monotonic());
      return values.shift() ?? 'MERGEABLE';
    },
    done: (v) => v !== 'UNKNOWN',
    interval: { initialMs: 1_000, maxMs: 3_000, factor: 2, jitter: 0 },
    clock,
    signal: new AbortController().signal,
  });
  const p = drain(gen);
  await clock.runUntil(() => seen.length === 4, { stepMs: 500 });
  const { yielded, result } = await p;
  assert.deepEqual(yielded, ['UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
  assert.equal(result, 'MERGEABLE');
  assert.deepEqual(seen, [0, 1_000, 3_000, 6_000]);
});

test('maxAttempts bounds the loop', async () => {
  const clock = new FakeClock(0);
  const p = drain(
    poll({
      probe: async () => 'UNKNOWN',
      done: () => false,
      interval: { initialMs: 100, maxMs: 100, factor: 1, jitter: 0.1 },
      clock,
      signal: new AbortController().signal,
      maxAttempts: 3,
      random: seededRandom(3),
    }),
  );
  await clock.advance(10_000);
  const { yielded, result } = await p;
  assert.equal(yielded.length, 2);
  assert.equal(result, 'UNKNOWN');
});

test('stretch hook lengthens the interval (rate budget)', async () => {
  const clock = new FakeClock(0);
  const seen: number[] = [];
  const p = drain(
    poll({
      probe: async () => {
        seen.push(clock.monotonic());
        return seen.length;
      },
      done: (n) => n >= 2,
      interval: { initialMs: 1_000, maxMs: 1_000, factor: 1, jitter: 0 },
      stretch: (ms) => ms * 4,
      clock,
      signal: new AbortController().signal,
    }),
  );
  await clock.advance(10_000);
  await p;
  assert.deepEqual(seen, [0, 4_000]);
});

test('abort rejects with the reason and reports transitions', async () => {
  const clock = new FakeClock(0);
  const c = new AbortController();
  const transitions: [number, number | undefined][] = [];
  let n = 0;
  const p = drain(
    poll({
      probe: async () => ++n,
      done: () => false,
      interval: { initialMs: 1_000, maxMs: 1_000, factor: 1, jitter: 0 },
      onValue: (v, prev) => transitions.push([v, prev]),
      clock,
      signal: c.signal,
    }),
  );
  await clock.advance(1_500);
  c.abort(new Error('shutdown'));
  await assert.rejects(p, /shutdown/);
  assert.deepEqual(transitions, [
    [1, undefined],
    [2, 1],
  ]);
});
