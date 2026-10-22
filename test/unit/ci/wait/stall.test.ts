import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActionsJob } from '../../../../src/ci/github.ts';
import type { BaselineStats } from '../../../../src/ci/wait/eta.ts';
import { scanJobTimeouts } from '../../../../src/ci/wait/job-timeouts.ts';
import {
  detectStalls,
  runningThreshold,
  STALL_DEFAULTS,
  type StallInput,
  settledAt,
  stallConfig,
} from '../../../../src/ci/wait/stall.ts';
import { CiSection } from '../../../../src/config/sections/ci.ts';
import { type Check, StalledCheck } from '../../../../src/schemas/ci.ts';
import { FakeClock } from '../../../helpers/fake-clock.ts';
import { at, check, job, MIN, passed, SEC, T0 } from './_data.ts';

const p90 = (sec: number): BaselineStats => ({
  build: { samples: 3, medianSec: sec * 0.8, p90Sec: sec, queueMedianSec: 0, source: 'push' },
});

const running = (startMin = 0): { checks: Check[]; jobs: ActionsJob[] } => ({
  checks: [check('build', { jobId: 11, runId: 1, startedAt: at(startMin) })],
  jobs: [job(11, 'build', { status: 'in_progress', created_at: at(0), started_at: at(startMin), runner_id: 7 })],
});

const queued = (o: { sibling?: Partial<ActionsJob> } = {}): { checks: Check[]; jobs: ActionsJob[] } => ({
  // Only `build` is a considered check; `lint` is a sibling job in the same run (e.g. a --check filter).
  checks: [check('build', { jobId: 11, runId: 1, status: 'queued', startedAt: at(0) })],
  jobs: [
    job(11, 'build', { status: 'queued', created_at: at(0), started_at: at(0), runner_id: null, runner_name: null }),
    job(12, 'lint', { status: 'queued', created_at: at(0), started_at: at(0), runner_id: null, ...o.sibling }),
  ],
});

/** A StallInput at `now` on a FakeClock that starts at T0 and is advanced to `atMs` after T0. */
async function input(atMs: number, o: Partial<StallInput>): Promise<StallInput> {
  const clock = new FakeClock(T0);
  await clock.advance(atMs);
  return {
    checks: [],
    jobs: [],
    baselines: {},
    timeouts: {},
    expected: [],
    now: clock.now(),
    config: stallConfig(),
    ...o,
  };
}

interface Row {
  label: string;
  /** Threshold measured from T0 + startMs. */
  startMs?: number;
  thresholdSec: number;
  state: 'running' | 'queued' | 'missing';
  name?: string;
  basis: string;
  setup: Partial<StallInput>;
}

const rows: Row[] = [
  {
    label: 'running, short p90 (4 min): max(12m, 19m) = 19 min',
    thresholdSec: 19 * 60,
    state: 'running',
    basis: 'p90+15m',
    setup: { ...running(), baselines: p90(240) },
  },
  {
    label: 'running, long p90 (20 min): max(60m, 35m) = 60 min',
    thresholdSec: 60 * 60,
    state: 'running',
    basis: '3×p90',
    setup: { ...running(), baselines: p90(1200) },
  },
  {
    label: 'running, crossover p90 (7.5 min): both formulas give 22.5 min',
    thresholdSec: 1350,
    state: 'running',
    basis: '3×p90',
    setup: { ...running(), baselines: p90(450) },
  },
  {
    label: 'first run, no baseline, literal timeout-minutes: 45',
    thresholdSec: 45 * 60,
    state: 'running',
    basis: 'timeout-minutes',
    setup: { ...running(), timeouts: { '1': scanJobTimeouts('jobs:\n  build:\n    timeout-minutes: 45\n') } },
  },
  {
    label: 'first run, no baseline, timeout an expression: 360 min',
    thresholdSec: 360 * 60,
    state: 'running',
    basis: 'default-360',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal GitHub Actions expression
    setup: { ...running(), timeouts: { '1': scanJobTimeouts('jobs:\n  build:\n    timeout-minutes: ${{ x }}\n') } },
  },
  {
    label: 'first run, no baseline, timeout absent (file unread): 360 min',
    thresholdSec: 360 * 60,
    state: 'running',
    basis: 'default-360',
    setup: running(),
  },
  {
    label: 'queued with no runner, nothing else in the run started: ci.stall.queuedMinutes (30)',
    thresholdSec: 30 * 60,
    state: 'queued',
    basis: 'ci.stall.queuedMinutes',
    setup: queued(),
  },
  {
    label: 'queued, then a runner assigned at 29 min: the running rules take over from started_at',
    startMs: 29 * MIN,
    thresholdSec: 19 * 60,
    state: 'running',
    basis: 'p90+15m',
    setup: { ...running(29), baselines: p90(240) },
  },
  {
    label: 'config override ci.stall.queuedMinutes: 5',
    thresholdSec: 5 * 60,
    state: 'queued',
    basis: 'ci.stall.queuedMinutes',
    setup: { ...queued(), config: stallConfig({ queuedMinutes: 5 }) },
  },
  {
    label: 'a required check never registers: ci.stall.missingMinutes (10) after everything else settled',
    startMs: 7 * MIN,
    thresholdSec: 10 * 60,
    state: 'missing',
    name: 'deploy',
    basis: 'ci.stall.missingMinutes',
    setup: {
      checks: [passed('build', 5), passed('lint', 7)],
      expected: [
        { name: 'build', workflow: null, source: 'required', state: 'reported' },
        { name: 'deploy', workflow: null, source: 'required', state: 'missing' },
        { name: 'main-only', workflow: null, source: 'baseline', state: 'missing' },
      ],
    },
  },
  {
    label: 'a config check never registers, with a missingMinutes override',
    startMs: 5 * MIN,
    thresholdSec: 2 * 60,
    state: 'missing',
    name: 'e2e',
    basis: 'ci.stall.missingMinutes',
    setup: {
      checks: [passed('build', 5)],
      expected: [{ name: 'e2e', workflow: 'E2E', source: 'config', state: 'missing' }],
      config: stallConfig({ missingMinutes: 2 }),
    },
  },
];

for (const r of rows) {
  test(`stall: ${r.label} — not at −1 s, stalled at +1 s`, async () => {
    const edge = (r.startMs ?? 0) + r.thresholdSec * SEC;
    assert.deepEqual(detectStalls(await input(edge - SEC, r.setup)), [], 'not stalled 1 s before');
    assert.deepEqual(detectStalls(await input(edge, r.setup)), [], 'not stalled exactly at the threshold');
    const got = detectStalls(await input(edge + SEC, r.setup));
    assert.deepEqual(got, [
      {
        name: r.name ?? 'build',
        state: r.state,
        forSec: r.thresholdSec + 1,
        thresholdSec: r.thresholdSec,
        basis: r.basis,
      },
    ]);
    for (const s of got) StalledCheck.parse(s);
  });
}

test('queued for 45 min while a sibling in the same run is in progress: not stalled', async () => {
  const setup = queued({ sibling: { status: 'in_progress', runner_id: 9, started_at: at(1) } });
  const got = detectStalls(await input(45 * MIN, setup));
  assert.deepEqual(got, []);
});

test('a skipped sibling does not count as started (it never had a runner)', async () => {
  const setup = queued({ sibling: { status: 'completed', conclusion: 'skipped', runner_id: 0 } });
  const got = detectStalls(await input(31 * MIN, setup));
  assert.deepEqual(
    got.map((s) => [s.name, s.state]),
    [['build', 'queued']],
  );
  const done = queued({ sibling: { status: 'completed', conclusion: 'success', runner_id: 3 } });
  assert.deepEqual(detectStalls(await input(31 * MIN, done)), []);
});

test('queued is measured from created_at, not started_at (spike §3.5)', async () => {
  const s = queued();
  // A queued job whose started_at was bumped still counts from created_at.
  const jobs = s.jobs.map((j) => ({ ...j, started_at: at(20) }));
  const got = detectStalls(await input(30 * MIN + SEC, { ...s, jobs }));
  assert.deepEqual(
    got.map((x) => [x.name, x.forSec]),
    [['build', 1801]],
  );
});

test('without job rows, checks alone drive the rules (siblings by runId)', async () => {
  const idle = [
    check('a', { runId: 5, status: 'queued', startedAt: at(0) }),
    check('b', { runId: 5, status: 'queued', startedAt: at(0) }),
  ];
  assert.equal(detectStalls(await input(31 * MIN, { checks: idle })).length, 2);
  const busy = [idle[0] as Check, check('b', { runId: 5, status: 'in_progress', startedAt: at(1) })];
  assert.deepEqual(detectStalls(await input(31 * MIN, { checks: busy })), []);
  const run = [check('c', { status: 'in_progress', startedAt: at(0) })];
  assert.equal(detectStalls(await input(360 * MIN + SEC, { checks: run }))[0]?.basis, 'default-360');
});

test('first run at 360 min: cancelled (red) and stalled race; each snapshot decides deterministically', async () => {
  const edge = 360 * MIN + SEC;
  const pending = running();
  const stalledFirst = detectStalls(await input(edge, pending));
  assert.deepEqual(
    stalledFirst.map((s) => s.state),
    ['running'],
  );
  const cancelled = {
    checks: [
      check('build', {
        jobId: 11,
        bucket: 'cancelled',
        status: 'completed',
        conclusion: 'cancelled',
        completedAt: at(360),
      }),
    ],
    jobs: [job(11, 'build', { status: 'completed', conclusion: 'cancelled', completed_at: at(360) })],
  };
  assert.deepEqual(detectStalls(await input(edge, cancelled)), [], 'a cancelled check is red, never stalled');
  // Same snapshot, same answer.
  assert.deepEqual(detectStalls(await input(edge, pending)), stalledFirst);
});

test('missing never fires while anything is pending, nor for baseline checks, nor before any check reported', async () => {
  const expected = [{ name: 'deploy', workflow: null, source: 'required' as const, state: 'missing' as const }];
  const pending = [passed('lint', 1), check('build', { status: 'in_progress', startedAt: at(0) })];
  assert.deepEqual(detectStalls(await input(60 * MIN, { checks: pending, expected, baselines: p90(3600) })), []);
  assert.deepEqual(detectStalls(await input(60 * MIN, { checks: [], expected })), []);
  assert.equal(settledAt([]), null);
  assert.equal(settledAt(pending), null);
  assert.equal(settledAt([passed('a', 3), passed('b', 9)]), T0 + 9 * MIN);
});

test('several at once: one overdue, one queued, one missing — all reported, in order', async () => {
  const checks = [
    check('build', { jobId: 11, runId: 1, startedAt: at(0) }),
    check('deploy', { jobId: 21, runId: 2, status: 'queued', startedAt: at(0) }),
  ];
  const jobs = [
    job(11, 'build', { status: 'in_progress', started_at: at(0), runner_id: 7 }),
    job(21, 'deploy', { run_id: 2, status: 'queued', created_at: at(0), runner_id: null }),
  ];
  const got = detectStalls(await input(40 * MIN, { checks, jobs, baselines: p90(240) }));
  assert.deepEqual(got, [
    { name: 'build', state: 'running', forSec: 2400, thresholdSec: 1140, basis: 'p90+15m' },
    { name: 'deploy', state: 'queued', forSec: 2400, thresholdSec: 1800, basis: 'ci.stall.queuedMinutes' },
  ]);
});

test('runningThreshold and stallConfig', () => {
  assert.deepEqual(runningThreshold(undefined, { minutes: 45, basis: 'timeout-minutes' }), {
    thresholdSec: 2700,
    basis: 'timeout-minutes',
  });
  assert.deepEqual(runningThreshold(100.2, { minutes: 360, basis: 'default-360' }), {
    thresholdSec: 1001,
    basis: 'p90+15m',
  });
  assert.deepEqual(stallConfig(), STALL_DEFAULTS);
  assert.deepEqual(stallConfig({ missingMinutes: 3 }), { queuedMinutes: 30, missingMinutes: 3 });
});

test('config: ci.stall is optional, takes positive integers, and is strict', () => {
  assert.equal(CiSection.parse({}).stall, undefined);
  assert.deepEqual(CiSection.parse({ stall: { queuedMinutes: 5 } }).stall, { queuedMinutes: 5 });
  assert.deepEqual(stallConfig(CiSection.parse({ stall: { queuedMinutes: 5 } }).stall), {
    queuedMinutes: 5,
    missingMinutes: 10,
  });
  for (const bad of [{ queuedMinutes: 0 }, { missingMinutes: 1.5 }, { other: 1 }]) {
    assert.equal(CiSection.safeParse({ stall: bad }).success, false, JSON.stringify(bad));
  }
});
