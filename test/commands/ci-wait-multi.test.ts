// Multiple targets and --any (02 §11.7; 03 M4.9): one loop, a result per target, the aggregate exit by
// precedence, and a summary that stays one document under 16 KB even for 10 red targets.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { WaitSummary } from '../../src/schemas/ci.ts';
import { EXIT } from '../contract/exit-table.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { GitHubSim, type SimJob, type SimState, sha, wait } from './ci-wait-world.ts';

const MIN = 60_000;
const head = (n: number) => sha((n % 16).toString(16));
const job = (id: number, o: Partial<SimJob> = {}): SimJob => ({
  id,
  runId: id,
  name: `job ${id}`,
  status: 'in_progress',
  startedAt: 0,
  ...o,
});

function twoPrs(): { sim: GitHubSim; clock: FakeClock } {
  const clock = new FakeClock();
  const state: SimState = {
    pr: { state: 'open', head: head(1) },
    prs: { 2: { state: 'open', head: head(2) } },
    checks: { [head(1)]: [job(11)], [head(2)]: [job(21)] },
  };
  return { sim: new GitHubSim(clock, state, { number: 1 }), clock };
}

test('--any returns at the first terminal target; the others are pending', async () => {
  const { sim } = twoPrs();
  sim.at(2 * MIN, (s) => ({
    ...s,
    checks: { ...s.checks, [head(2)]: [job(21, { status: 'completed', conclusion: 'success', completedAt: 2 * MIN })] },
  }));
  const r = await wait(sim, ['o/r#1', 'o/r#2', '--any']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const s = WaitSummary.parse(r.json);
  assert.equal(s.outcome, 'green');
  assert.deepEqual(
    s.results.map((x) => [x.target, x.outcome]),
    [
      ['o/r#1', 'pending'],
      ['o/r#2', 'green'],
    ],
  );
  assert.deepEqual(s.results[0]?.next, ['ghx ci wait o/r#1 o/r#2 --any']);
});

test('without --any every target finishes, and the exit follows the precedence (red beats green)', async () => {
  const { sim } = twoPrs();
  sim.at(2 * MIN, (s) => ({
    ...s,
    checks: { ...s.checks, [head(2)]: [job(21, { status: 'completed', conclusion: 'success', completedAt: 2 * MIN })] },
  }));
  sim.at(9 * MIN, (s) => ({
    ...s,
    checks: { ...s.checks, [head(1)]: [job(11, { status: 'completed', conclusion: 'failure', completedAt: 9 * MIN })] },
  }));
  const r = await wait(sim, ['o/r#1', 'o/r#2']);
  assert.equal(r.exitCode, EXIT.CI_RED, r.stdout);
  assert.equal(r.json.outcome, 'red');
  assert.deepEqual(
    r.json.results.map((x: { outcome: string }) => x.outcome),
    ['red', 'green'],
  );
  assert.ok(r.json.results[0].elapsedSec >= 9 * 60);
});

test('a listed-twice target is a validation error', async () => {
  const { sim } = twoPrs();
  const r = await wait(sim, ['o/r#1', '1', '-R', 'o/r']);
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  assert.equal(r.json.error.code, 'VALIDATION');
});

test('10 targets, each with 5 diagnosed failing jobs: compacted under 16 384 bytes, never spilled, full detail on disk', async () => {
  const clock = new FakeClock();
  const prs: NonNullable<SimState['prs']> = {};
  const checks: SimState['checks'] = {};
  for (let n = 1; n <= 10; n++) {
    const hh = n < 7 ? sha('abcdef'[n - 1] as string) : `${'0'.repeat(39)}${n - 7}`;
    prs[n] = { state: 'open', head: hh };
    checks[hh] = Array.from({ length: 5 }, (_, k) =>
      job(n * 100 + k, {
        runId: n * 1000,
        name: `Test shard ${k + 1}/5 ${'·'.repeat(60)}`,
        status: 'completed',
        conclusion: 'failure',
        completedAt: 0,
        tests: Array.from(
          { length: 8 },
          (_, t) => `packages/p${n}/test/suite-${k}.test.ts > case ${t} ${'y'.repeat(150)}`,
        ),
      }),
    );
  }
  const sim = new GitHubSim(clock, { pr: prs[1] as SimState['pr'], prs, checks }, { number: 1 });
  const targets = Array.from({ length: 10 }, (_, i) => `o/r#${i + 1}`);
  const r = await wait(sim, targets);
  assert.equal(r.exitCode, EXIT.CI_RED, r.stdout.slice(0, 400));
  assert.ok(Buffer.byteLength(r.stdout) < 16_384, `${Buffer.byteLength(r.stdout)} bytes`);
  assert.equal(r.json.spilled, undefined);
  const s = WaitSummary.parse(r.json);
  assert.equal(s.results.length, 10);
  const full = JSON.parse(readFileSync(s.diagnosisPath as string, 'utf8'));
  // Fake time moves while the diagnoses run, so the 60 s per-SHA budget may cut the last job or two.
  assert.ok(full.diagnoses.length >= 40, `${full.diagnoses.length} diagnoses on disk`);
  assert.equal(full.results[0].diagnosis.jobs.length, 5, 'the full form keeps all five');
  assert.ok(
    s.results.every((t) => (t.diagnosis?.jobs.length ?? 0) < 5),
    'the stdout form is compacted',
  );
  assert.ok((r.json.warnings ?? []).length <= 8, 'warnings are capped in the summary');
  assert.deepEqual(sim.mutations(), []);
});
