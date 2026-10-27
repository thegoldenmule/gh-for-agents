// ghx ci rerun <pr|run:<id>> (02 §13.1; 03 M5.1), in-process over the fake GitHub in ci-why-world.ts.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { EXIT } from '../contract/exit-table.ts';
import { FakeGh, type GhReply } from '../helpers/fake-gh.ts';
import { runInProcess, scratchDir } from '../helpers/harness.ts';
import {
  httpReply,
  install,
  jobRow,
  mainRun,
  okJson,
  prRun,
  sha,
  vitestLog,
  type WJob,
  type World,
} from './ci-why-world.ts';

const SLUG = 'o/r';
const H = sha('a');

const red = (id: number, name: string, o: Partial<WJob> = {}): WJob => ({
  id,
  runId: 500,
  name,
  conclusion: 'failure',
  log: { text: vitestLog([`src/${name}.test.ts > works`]) },
  ...o,
});

const config = (ci: Record<string, unknown>) => ({ version: 1, components: { app: {} }, ci });

const world = (jobs: WJob[], o: Partial<World> = {}): World => ({ slug: SLUG, number: 7, headSha: H, jobs, ...o });

const pathOf = (argv: readonly string[]): string | undefined => argv.find((a) => a.startsWith('repos/'))?.split('?')[0];
const isPost =
  (suffix: string) =>
  (argv: string[]): boolean =>
    argv.includes('POST') && (pathOf(argv) ?? '').endsWith(suffix);
const isGet = (suffix: string) => (argv: string[]) =>
  !argv.includes('POST') && pathOf(argv) === `repos/${SLUG}/${suffix}`;

const created: GhReply = { exitCode: 0, stdout: httpReply('HTTP/2.0 201 Created', '{}'), stderr: '' };

/** The fake world plus 201s for every rerun POST; `runs` overrides fields of actions/runs/{id}. */
function scene(w: World, runs: Record<number, Record<string, unknown>> = {}): FakeGh {
  const fake = install(new FakeGh(), w);
  for (const [id, patch] of Object.entries(runs)) {
    fake.on(isGet(`actions/runs/${id}`), okJson({ ...prRun(w, Number(id)), ...patch }));
  }
  fake.on((a) => a.includes('POST') && (pathOf(a) ?? '').endsWith('/rerun-failed-jobs'), created);
  fake.on((a) => a.includes('POST') && (pathOf(a) ?? '').endsWith('/rerun'), created);
  return fake;
}

async function rerun(fake: FakeGh, args: string[] = []) {
  const artifacts = mkdtempSync(join(scratchDir(), 'rerun-'));
  return runInProcess(['ci', 'rerun', `${SLUG}#7`, ...args], { gh: fake, env: { GHX_ARTIFACT_DIR: artifacts } });
}

const posts = (fake: FakeGh) => fake.calls.filter((c) => c.argv.includes('POST')).map((c) => pathOf(c.argv));

test('a failed completed run is rerun with rerun-failed-jobs, in one read-then-POST sequence', async () => {
  const w = world([red(101, 'test'), { id: 102, runId: 500, name: 'lint', conclusion: 'success' }]);
  const fake = scene(w);
  const r = await rerun(fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.ref, 'o/r#7');
  assert.equal(r.json.headSha, H);
  assert.deepEqual(r.json.rerun, [
    {
      runId: 500,
      workflow: 'CI',
      method: 'failed-jobs',
      jobs: ['test'],
      previousAttempt: 1,
      url: 'https://github.com/o/r/actions/runs/500',
      flake: null,
    },
  ]);
  assert.deepEqual(r.json.skipped, []);
  assert.deepEqual(r.json.overrides, []);
  assert.deepEqual(r.json.next, ['ghx ci wait o/r#7']);
  fake.expectCalls(
    [
      isGet('contents/.github/ghx.json'),
      { prefix: ['api', 'graphql'] },
      isGet('actions/runs/500'),
      isPost('actions/runs/500/rerun-failed-jobs'),
    ],
    { ordered: true, exhaustive: true },
  );
});

test('a run still in progress is skipped as RUN_IN_PROGRESS (exit 9) and nothing is posted', async () => {
  const fake = scene(world([red(101, 'test'), { id: 102, runId: 500, name: 'e2e', conclusion: null }]));
  const r = await rerun(fake);
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.equal(r.json.error.code, 'RUN_IN_PROGRESS');
  assert.deepEqual(r.json.error.details, { runs: [500] });
  assert.match(r.json.error.hint, /ghx ci wait o\/r#7 --until settled/);
  fake.expectNoMutations();
});

test('an in-progress run is skipped while a completed one is rerun', async () => {
  const fake = scene(world([red(101, 'test'), red(201, 'build', { runId: 600, workflowId: 6, workflow: 'Build' })]), {
    600: { status: 'in_progress', conclusion: null },
  });
  const r = await rerun(fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(
    r.json.rerun.map((x: { runId: number }) => x.runId),
    [500],
  );
  assert.deepEqual(r.json.skipped, [{ runId: 600, workflow: 'Build', reason: 'RUN_IN_PROGRESS', attempt: 1 }]);
  assert.deepEqual(posts(fake), [`repos/${SLUG}/actions/runs/500/rerun-failed-jobs`]);
});

test('attempt 3 hits RERUN_LIMIT (exit 6); the override needs --reason and is then recorded', async () => {
  const w = world([red(101, 'test', { attempt: 3 })]);
  const limited = await rerun(scene(w, { 500: { run_attempt: 3 } }));
  assert.equal(limited.exitCode, EXIT.POLICY, limited.stdout);
  assert.equal(limited.json.error.code, 'RERUN_LIMIT');
  assert.equal(limited.json.error.message, 'Run 500 is on attempt 3 (limit 3).');
  assert.equal(limited.json.error.details.runId, 500);
  assert.equal(limited.json.error.details.attempt, 3);
  assert.match(limited.json.error.hint, /ghx ci why o\/r#7/);

  const noReason = scene(w, { 500: { run_attempt: 3 } });
  const bad = await rerun(noReason, ['--override', 'RERUN_LIMIT']);
  assert.equal(bad.exitCode, EXIT.USAGE, bad.stdout);
  assert.equal(bad.json.error.code, 'VALIDATION');
  assert.equal(noReason.calls.length, 0, 'the override is validated before any gh call');

  const wrongCode = await rerun(scene(w, { 500: { run_attempt: 3 } }), ['--override', 'CI_RED', '--reason', 'x']);
  assert.equal(wrongCode.json.error.code, 'VALIDATION');

  const fake = scene(w, { 500: { run_attempt: 3 } });
  const ok = await rerun(fake, ['--override', 'RERUN_LIMIT', '--reason', 'user asked in chat']);
  assert.equal(ok.exitCode, EXIT.OK, ok.stdout);
  assert.equal(ok.json.rerun[0].previousAttempt, 3);
  assert.deepEqual(ok.json.overrides, [{ code: 'RERUN_LIMIT', reason: 'user asked in chat' }]);
  assert.deepEqual(posts(fake), [`repos/${SLUG}/actions/runs/500/rerun-failed-jobs`]);
});

test('ci.maxRerunAttempts raises the limit', async () => {
  const w = world([red(101, 'test', { attempt: 3 })], { config: config({ maxRerunAttempts: 5 }) });
  const r = await rerun(scene(w, { 500: { run_attempt: 3 } }));
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const capped = world([red(101, 'test')], { config: config({ maxRerunAttempts: 1 }) });
  const c = await rerun(scene(capped));
  assert.equal(c.json.error.code, 'RERUN_LIMIT');
  assert.equal(c.json.error.message, 'Run 500 is on attempt 1 (limit 1).');
});

test('--job posts to jobs/{id}/rerun for one matching job out of several', async () => {
  const fake = scene(world([red(101, 'Test Reactor (shard 1/3)'), red(102, 'lint')]));
  const r = await rerun(fake, ['--job', 'Test Reactor*']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.rerun[0].method, 'job');
  assert.deepEqual(r.json.rerun[0].jobs, ['Test Reactor (shard 1/3)']);
  assert.deepEqual(posts(fake), [`repos/${SLUG}/actions/jobs/101/rerun`]);
});

test('--job selecting every red job of the run uses rerun-failed-jobs, with no warning', async () => {
  const fake = scene(world([red(101, 'test a'), red(102, 'test b'), red(103, 'lint', { runId: 600 })]));
  const r = await rerun(fake, ['--job', 'test*']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(posts(fake), [`repos/${SLUG}/actions/runs/500/rerun-failed-jobs`]);
  assert.equal(r.json.warnings, undefined);
});

test('--job selecting two of three red jobs in one run widens to rerun-failed-jobs and warns RERUN_WIDENED', async () => {
  const fake = scene(world([red(101, 'test a'), red(102, 'test b'), red(103, 'lint')]));
  const r = await rerun(fake, ['--job', 'test*']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(posts(fake), [`repos/${SLUG}/actions/runs/500/rerun-failed-jobs`]);
  assert.deepEqual(r.json.rerun[0].jobs, ['test a', 'test b', 'lint']);
  const w = r.json.warnings.find((x: { code: string }) => x.code === 'RERUN_WIDENED');
  assert.deepEqual(w.details, { runId: 500, selected: ['test a', 'test b'], extra: ['lint'] });
});

test('--job matching no failed job is NO_FAILED_RUNS listing the failing names', async () => {
  const fake = scene(world([red(101, 'test')]));
  const r = await rerun(fake, ['--job', 'e2e*']);
  assert.equal(r.exitCode, EXIT.STATE);
  assert.equal(r.json.error.code, 'NO_FAILED_RUNS');
  assert.deepEqual(r.json.error.details.failing, ['test']);
  fake.expectNoMutations();
});

test('green CI is NO_FAILED_RUNS (exit 9) with the CI state', async () => {
  const fake = scene(world([{ id: 101, runId: 500, name: 'test', conclusion: 'success' }]));
  const r = await rerun(fake);
  assert.equal(r.exitCode, EXIT.STATE);
  assert.equal(r.json.error.code, 'NO_FAILED_RUNS');
  assert.equal(r.json.error.message, `No failed Actions runs for head ${H.slice(0, 7)}.`);
  assert.deepEqual(r.json.error.details, { ciState: 'green' });
  assert.match(r.json.error.hint, /ghx ci retrigger/);
  fake.expectCalls([isGet('contents/.github/ghx.json'), { prefix: ['api', 'graphql'] }], {
    ordered: true,
    exhaustive: true,
  });
});

test('error precedence: an in-progress run outranks one at the limit', async () => {
  const fake = scene(world([red(101, 'test', { attempt: 3 }), red(201, 'build', { runId: 600, workflowId: 6 })]), {
    500: { run_attempt: 3 },
    600: { status: 'in_progress', conclusion: null },
  });
  const r = await rerun(fake);
  assert.equal(r.json.error.code, 'RUN_IN_PROGRESS');
  assert.deepEqual(r.json.error.details, { runs: [600] });
  fake.expectNoMutations();
});

test('--expect-head that is not the head is HEAD_MOVED (exit 9) before any run is read', async () => {
  const fake = scene(world([red(101, 'test')]));
  const r = await rerun(fake, ['--expect-head', 'bbbbbbb']);
  assert.equal(r.exitCode, EXIT.STATE);
  assert.equal(r.json.error.code, 'HEAD_MOVED');
  fake.expectNoCall(isGet('actions/runs/500'));
  const ok = await rerun(scene(world([red(101, 'test')])), ['--expect-head', H.slice(0, 7)]);
  assert.equal(ok.exitCode, EXIT.OK, ok.stdout);
});

test('--dry-run halts before the POST with wouldRun and the plan as preview', async () => {
  const fake = scene(world([red(101, 'test')]));
  const r = await rerun(fake, ['--dry-run']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.dryRun, true);
  assert.ok(r.json.wouldRun[0].argv.includes(`repos/${SLUG}/actions/runs/500/rerun-failed-jobs`));
  assert.equal(r.json.preview.rerun[0].runId, 500);
  fake.expectNoMutations();
});

test('the smoke scenario reaches the dry-run halt on the rerun POST', async () => {
  const fake = FakeGh.fromScenario('smoke/ci-rerun');
  const r = await runInProcess(['ci', 'rerun', 'powerhouse-inc/powerhouse#3301', '--flaky', '--dry-run'], {
    gh: fake,
    env: { GHX_ARTIFACT_DIR: mkdtempSync(join(scratchDir(), 'rerun-smoke-')) },
  });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.dryRun, true);
  assert.ok(
    r.json.wouldRun[0].argv.includes('repos/powerhouse-inc/powerhouse/actions/runs/37948190914/rerun-failed-jobs'),
    JSON.stringify(r.json.wouldRun),
  );
  assert.equal(r.json.preview.rerun[0].flake[0].signals[0].kind, 'infra-error');
  fake.expectNoMutations();
});

// ── --flaky, one case per flake signal (02 §11.8) ──────────────────────────
const T = 'src/flaky.test.ts > sometimes';

interface FlakyCase {
  name: string;
  kind: string;
  score: 'high' | 'medium';
  /** The flaky job; the scene also has a real failure 'real' (id 102) in the same run. */
  job: WJob;
  world?: Partial<World>;
  extra?: (fake: FakeGh, w: World) => void;
}

const flakyCases: FlakyCase[] = [
  {
    name: 'infra-error: ECONNRESET in the log',
    kind: 'infra-error',
    score: 'high',
    job: red(101, 'e2e', { log: { text: vitestLog([], { extra: ['Error: read ECONNRESET'] }) } }),
  },
  {
    name: 'known-flaky: ci.knownFlaky lists the job',
    kind: 'known-flaky',
    score: 'medium',
    job: red(101, 'e2e'),
    world: { config: config({ knownFlaky: [{ job: 'e2e' }] }) },
  },
  {
    name: 'same-sha-passed: the job passed on attempt 1 of this run',
    kind: 'same-sha-passed',
    score: 'high',
    job: red(101, 'e2e', { attempt: 2 }),
    extra: (fake, w) => {
      const rows = [
        jobRow(w, { id: 91, runId: 500, name: 'e2e', conclusion: 'success', attempt: 1 }),
        jobRow(w, { id: 92, runId: 500, name: 'real', conclusion: 'failure', attempt: 1 }),
      ];
      fake.on(isGet('actions/runs/500/attempts/1/jobs'), okJson({ total_count: rows.length, jobs: rows }));
      fake.on(isGet('actions/runs/500'), okJson({ ...prRun(w, 500), run_attempt: 2 }));
    },
  },
  {
    name: 'main-intermittent: the test fails and passes alternately on main',
    kind: 'main-intermittent',
    score: 'medium',
    job: red(101, 'e2e', { log: { text: vitestLog([T]) } }),
    world: {
      mainRuns: { 5: [mainRun(903, 'failure'), mainRun(902, 'success'), mainRun(901, 'failure')] },
      otherJobs: [
        red(9031, 'e2e', { runId: 903, headSha: sha('d'), log: { text: vitestLog([T]) } }),
        red(9011, 'e2e', { runId: 901, headSha: sha('d'), log: { text: vitestLog([T]) } }),
      ],
    },
  },
];

for (const c of flakyCases) {
  test(`--flaky ${c.name}: reruns only that job, with the ${c.kind} evidence`, async () => {
    const real = red(102, 'real', { attempt: c.job.attempt ?? 1 });
    const w = world([c.job, real], c.world);
    const fake = scene(w);
    c.extra?.(fake, w);
    const r = await rerun(fake, ['--flaky']);
    assert.equal(r.exitCode, EXIT.OK, r.stdout);
    assert.deepEqual(posts(fake), [`repos/${SLUG}/actions/jobs/101/rerun`]);
    const [entry] = r.json.rerun;
    assert.equal(entry.method, 'job');
    assert.deepEqual(entry.jobs, ['e2e']);
    assert.equal(entry.flake.length, 1);
    assert.equal(entry.flake[0].job, 'e2e');
    assert.equal(entry.flake[0].jobId, 101);
    assert.equal(entry.flake[0].score, c.score);
    assert.equal(entry.flake[0].candidate, true);
    assert.ok(
      entry.flake[0].signals.some((s: { kind: string }) => s.kind === c.kind),
      JSON.stringify(entry.flake[0].signals),
    );
  });
}

test('--flaky with no candidate is NO_FLAKY_CANDIDATES (exit 9) and nothing is posted', async () => {
  const fake = scene(world([red(101, 'Test Reactor (shard 1/3)')]));
  const r = await rerun(fake, ['--flaky']);
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.equal(r.json.error.code, 'NO_FLAKY_CANDIDATES');
  assert.deepEqual(r.json.error.details, { failing: ['Test Reactor (shard 1/3)'] });
  assert.match(r.json.error.hint, /ghx ci why o\/r#7/);
  fake.expectNoMutations();
});

test('--flaky skips a run without candidates as NOT_FLAKY while another run is rerun', async () => {
  const fake = scene(
    world([
      red(101, 'e2e', { log: { text: vitestLog([], { extra: ['No space left on device'] }) } }),
      red(201, 'unit', { runId: 600, workflowId: 6, workflow: 'Unit' }),
    ]),
  );
  const r = await rerun(fake, ['--flaky']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(posts(fake), [`repos/${SLUG}/actions/runs/500/rerun-failed-jobs`]);
  assert.deepEqual(r.json.skipped, [{ runId: 600, workflow: 'Unit', reason: 'NOT_FLAKY', attempt: 1 }]);
});

test('--flaky never widens: 2 flaky jobs and 1 real failure in one run rerun one flaky job, defer the other', async () => {
  const flaky = (id: number, name: string) =>
    red(id, name, { log: { text: vitestLog([], { extra: ['Error: read ECONNRESET'] }) } });
  const fake = scene(world([flaky(101, 'e2e'), flaky(103, 'e2e-2'), red(102, 'real')]));
  const r = await rerun(fake, ['--flaky']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(posts(fake), [`repos/${SLUG}/actions/jobs/101/rerun`]);
  fake.expectNoCall(isPost('/rerun-failed-jobs'));
  assert.equal(r.json.rerun[0].method, 'job');
  assert.deepEqual(r.json.rerun[0].jobs, ['e2e']);
  assert.equal(
    r.json.warnings?.some((w: { code: string }) => w.code === 'RERUN_WIDENED'),
    undefined,
  );
  const [deferred] = r.json.skipped;
  assert.equal(r.json.skipped.length, 1);
  assert.deepEqual(
    { runId: deferred.runId, reason: deferred.reason, jobs: deferred.jobs },
    { runId: 500, reason: 'DEFERRED', jobs: ['e2e-2'] },
  );
  assert.match(deferred.message, /once run 500 completes/);
  assert.deepEqual(r.json.next, ['ghx ci wait o/r#7', 'ghx ci rerun o/r#7 --flaky (after run 500 completes)']);
});

test('--flaky with every red job of the run a candidate reruns the run with rerun-failed-jobs', async () => {
  const flaky = (id: number, name: string) =>
    red(id, name, { log: { text: vitestLog([], { extra: ['Error: read ECONNRESET'] }) } });
  const fake = scene(world([flaky(101, 'e2e'), flaky(103, 'e2e-2')]));
  const r = await rerun(fake, ['--flaky']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(posts(fake), [`repos/${SLUG}/actions/runs/500/rerun-failed-jobs`]);
  assert.deepEqual(r.json.skipped, []);
});

// --- run:<id>: one workflow run, without a PR (main) ---

async function rerunRun(fake: FakeGh, target: string, args: string[] = []) {
  const artifacts = mkdtempSync(join(scratchDir(), 'rerun-'));
  return runInProcess(['ci', 'rerun', target, '-R', SLUG, ...args], { gh: fake, env: { GHX_ARTIFACT_DIR: artifacts } });
}

test('run:<id> reruns that run’s failed jobs from one read of the run and its jobs, with no PR', async () => {
  const w = world([red(101, 'test'), { id: 102, runId: 500, name: 'lint', conclusion: 'success' }]);
  const fake = scene(w);
  const r = await rerunRun(fake, 'run:500');
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.ref, null);
  assert.equal(r.json.target, 'run:500');
  assert.equal(r.json.headSha, H);
  assert.deepEqual(
    r.json.rerun.map((x: { runId: number; method: string; jobs: string[] }) => [x.runId, x.method, x.jobs]),
    [[500, 'failed-jobs', ['test']]],
  );
  assert.deepEqual(r.json.next, ['ghx ci wait run:500 -R o/r']);
  assert.deepEqual(posts(fake), [`repos/${SLUG}/actions/runs/500/rerun-failed-jobs`]);
  fake.expectNoCall({ prefix: ['api', 'graphql'] });
  assert.equal(fake.calls.filter((c) => pathOf(c.argv) === `repos/${SLUG}/actions/runs/500`).length, 1);
});

test('run:<id> --job reruns one matching job through jobs/{id}/rerun', async () => {
  const fake = scene(world([red(101, 'test'), red(103, 'e2e')]));
  const r = await rerunRun(fake, 'run:500', ['--job', 'e2e']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(posts(fake), [`repos/${SLUG}/actions/jobs/103/rerun`]);
});

test('run:<id> with a sibling job still running is RUN_IN_PROGRESS; the hint waits on the run in the background', async () => {
  const fake = scene(world([red(101, 'test'), { id: 102, runId: 500, name: 'e2e', conclusion: null }]));
  const r = await rerunRun(fake, 'run:500');
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.equal(r.json.error.code, 'RUN_IN_PROGRESS');
  assert.match(r.json.error.hint, /ghx ci wait run:500 -R o\/r --until settled with run_in_background: true/);
  assert.match(r.json.error.hint, /ghx ci rerun run:500 -R o\/r/);
  assert.deepEqual(posts(fake), []);
});

test('run:<id> --expect-head checks the run’s commit (HEAD_MOVED on another commit)', async () => {
  const fake = scene(world([red(101, 'test')]));
  const r = await rerunRun(fake, 'run:500', ['--expect-head', 'bbbbbbb']);
  assert.equal(r.exitCode, EXIT.STATE, r.stdout);
  assert.equal(r.json.error.code, 'HEAD_MOVED');
  assert.match(r.json.error.message, /Run 500 is for commit aaaaaaa/);
  assert.deepEqual(posts(fake), []);
  const ok = await rerunRun(scene(world([red(101, 'test')])), 'run:500', ['--expect-head', 'aaaaaaa']);
  assert.equal(ok.exitCode, EXIT.OK, ok.stdout);
});

test('a run URL is a run target; a branch is not a ci rerun target', async () => {
  const fake = scene(world([red(101, 'test')]));
  const url = await rerunRun(fake, `https://github.com/${SLUG}/actions/runs/500`);
  assert.equal(url.exitCode, EXIT.OK, url.stdout);
  assert.equal(url.json.target, 'run:500');
  const branch = await rerunRun(scene(world([red(101, 'test')])), 'branch:main');
  assert.equal(branch.exitCode, EXIT.USAGE);
  assert.equal(branch.json.error.code, 'USAGE_BAD_SELECTOR');
  assert.match(branch.json.error.hint, /ci rerun does not take branch:.*it takes a PR .*run:<id>/);
  assert.match(branch.json.error.hint, /ghx ci why branch:main names the branch head's runs/);
});
