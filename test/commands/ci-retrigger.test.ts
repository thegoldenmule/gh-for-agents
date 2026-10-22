// ghx ci retrigger <pr> (02 §13.2; 03 M5.2): close and reopen, preflight refusals, the reopen retry ending
// in REOPEN_FAILED, and the post-reopen suite check (NO_NEW_RUNS), as FakeGh call sequences.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RETRIGGER_PR_QUERY } from '../../src/ci/rerun/retrigger.ts';
import { createShutdown, type Shutdown } from '../../src/core/signals.ts';
import { EXIT } from '../contract/exit-table.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { FakeGh, type GhReply } from '../helpers/fake-gh.ts';
import { runInProcess } from '../helpers/harness.ts';
import { httpReply, okJson, serverError, sha } from './ci-why-world.ts';

const SLUG = 'o/r';
const H = sha('a');

interface Pr {
  state?: 'OPEN' | 'CLOSED' | 'MERGED';
  author?: string | null;
  viewer?: string;
  headRef?: boolean;
  baseRef?: boolean;
}

function prReply(p: Pr = {}): GhReply {
  return okJson({
    data: {
      viewer: { login: p.viewer ?? 'me' },
      repository: {
        pullRequest: {
          number: 7,
          state: p.state ?? 'OPEN',
          headRefOid: H,
          headRefName: 'fix/x',
          baseRefName: 'main',
          author: p.author === null ? null : { __typename: 'User', login: p.author ?? 'me' },
          headRef: p.headRef === false ? null : { name: 'fix/x' },
          baseRef: p.baseRef === false ? null : { name: 'main' },
        },
      },
    },
  });
}

const suites = (ids: number[]): GhReply =>
  okJson({
    total_count: ids.length,
    check_suites: ids.map((id) => ({
      id,
      app: { slug: 'github-actions' },
      status: id > 100 ? 'queued' : 'completed',
      conclusion: id > 100 ? null : 'failure',
      created_at: '2026-10-22T11:00:00Z',
    })),
  });

const pull = (state: 'open' | 'closed', at: string): GhReply =>
  okJson({ number: 7, state, closed_at: state === 'closed' ? at : null, updated_at: at });

const isQuery = (a: string[]) => a[1] === 'graphql' && a.includes(`query=${RETRIGGER_PR_QUERY}`);
const isSuites = (a: string[]) => a.some((x) => x.startsWith(`repos/${SLUG}/commits/${H}/check-suites`));
const isPatch = (state: 'open' | 'closed') => (a: string[], stdin?: string) =>
  a.includes('PATCH') &&
  a.includes(`repos/${SLUG}/pulls/7`) &&
  (JSON.parse(stdin ?? '{}') as { state?: string }).state === state;

interface Scene {
  pr?: GhReply[];
  suites?: GhReply[];
  close?: GhReply[];
  open?: GhReply[];
}

/** Each scene's FakeClock, shared with its FakeGh so calls carry their fake time. */
const clocks = new WeakMap<FakeGh, FakeClock>();

function scene(s: Scene = {}): FakeGh {
  const clock = new FakeClock();
  const fake = new FakeGh({ clock });
  clocks.set(fake, clock);
  fake.on(isQuery, s.pr ?? [prReply()]);
  fake.on(isSuites, s.suites ?? [suites([11]), suites([11, 101, 102])]);
  fake.on(isPatch('closed'), s.close ?? [pull('closed', '2026-10-22T12:00:01Z')]);
  fake.on(isPatch('open'), s.open ?? [pull('open', '2026-10-22T12:00:02Z')]);
  return fake;
}

/** Run with a FakeClock that is advanced until the command finishes (retry backoff, suite polling). */
async function retrigger(fake: FakeGh, args: string[] = [], o: { shutdown?: Shutdown } = {}) {
  const clock = clocks.get(fake) ?? new FakeClock();
  let done = false;
  const p = runInProcess(['ci', 'retrigger', `${SLUG}#7`, ...args], { gh: fake, clock, ...o }).finally(() => {
    done = true;
  });
  await clock.runUntil(() => done, { stepMs: 500, maxMs: 600_000 });
  return { ...(await p), clock };
}

const count = (fake: FakeGh, m: (a: string[], stdin?: string) => boolean) =>
  fake.calls.filter((c) => m(c.argv, c.stdin)).length;

test('closes then reopens, and reports the new check suites on the head', async () => {
  const fake = scene();
  const r = await retrigger(fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(r.json, {
    ref: 'o/r#7',
    headSha: H,
    closedAt: '2026-10-22T12:00:01Z',
    reopenedAt: '2026-10-22T12:00:02Z',
    newRuns: [
      { checkSuiteId: 101, app: 'github-actions', status: 'queued', createdAt: '2026-10-22T11:00:00Z' },
      { checkSuiteId: 102, app: 'github-actions', status: 'queued', createdAt: '2026-10-22T11:00:00Z' },
    ],
    overrides: [],
    next: ['ghx ci wait o/r#7'],
  });
  fake.expectCalls([isQuery, isSuites, isPatch('closed'), isPatch('open'), isSuites], {
    ordered: true,
    exhaustive: true,
  });
  assert.equal(count(fake, isPatch('closed')), 1);
});

const REFUSALS: [string, Pr, string, number][] = [
  ['a closed PR', { state: 'CLOSED' }, 'PR_NOT_OPEN', EXIT.STATE],
  ['a merged PR', { state: 'MERGED' }, 'PR_NOT_OPEN', EXIT.STATE],
  ['a deleted head branch', { headRef: false }, 'HEAD_BRANCH_MISSING', EXIT.STATE],
  ['a deleted base branch', { baseRef: false }, 'BRANCH_MISSING', EXIT.STATE],
  ["someone else's PR", { author: 'other-dev' }, 'AUTHOR_NOT_VIEWER', EXIT.POLICY],
  ['a PR whose author was deleted', { author: null }, 'AUTHOR_NOT_VIEWER', EXIT.POLICY],
  ['closed with its head deleted: PR_NOT_OPEN first', { state: 'CLOSED', headRef: false }, 'PR_NOT_OPEN', EXIT.STATE],
];

for (const [name, pr, code, exit] of REFUSALS) {
  test(`preflight: ${name} is ${code} and nothing is patched`, async () => {
    const fake = scene({ pr: [prReply(pr)] });
    const r = await retrigger(fake);
    assert.equal(r.exitCode, exit, r.stdout);
    assert.equal(r.json.error.code, code);
    fake.expectCalls([isQuery], { exhaustive: true });
  });
}

test('HEAD_BRANCH_MISSING says a closed PR could not be reopened and how to fix it', async () => {
  const r = await retrigger(scene({ pr: [prReply({ headRef: false })] }));
  assert.match(r.json.error.message, /'fix\/x' no longer exists/);
  assert.match(r.json.error.hint, /git push -u origin fix\/x/);
});

test('AUTHOR_NOT_VIEWER is overridable with --reason; without one it is VALIDATION before any call', async () => {
  const noReason = scene({ pr: [prReply({ author: 'other-dev' })] });
  const bad = await retrigger(noReason, ['--override', 'AUTHOR_NOT_VIEWER']);
  assert.equal(bad.exitCode, EXIT.USAGE, bad.stdout);
  assert.equal(bad.json.error.code, 'VALIDATION');
  assert.equal(noReason.calls.length, 0);

  const fake = scene({ pr: [prReply({ author: 'other-dev' })] });
  const r = await retrigger(fake, ['--override', 'AUTHOR_NOT_VIEWER', '--reason', 'user asked in chat']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(r.json.overrides, [{ code: 'AUTHOR_NOT_VIEWER', reason: 'user asked in chat' }]);
  assert.equal(count(fake, isPatch('open')), 1);
});

test('an app author matches its [bot] viewer login', async () => {
  const r = await retrigger(scene({ pr: [prReply({ author: 'my-app', viewer: 'my-app[bot]' })] }));
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
});

test('--expect-head that is not the head is HEAD_MOVED with no PATCH', async () => {
  const fake = scene();
  const r = await retrigger(fake, ['--expect-head', 'bbbbbbb']);
  assert.equal(r.exitCode, EXIT.STATE);
  assert.equal(r.json.error.code, 'HEAD_MOVED');
  fake.expectNoMutations();
});

test('a reopen failing 3 times is REOPEN_FAILED (exit 7) with the hint to reopen in the UI', async () => {
  const fake = scene({ open: [serverError()], pr: [prReply(), prReply({ state: 'CLOSED' })] });
  const r = await retrigger(fake);
  assert.equal(r.exitCode, EXIT.GH_FAILED, r.stdout);
  assert.equal(r.json.error.code, 'REOPEN_FAILED');
  assert.match(r.json.error.message, /o\/r#7 was closed to retrigger CI but reopening it failed/);
  assert.equal(r.json.error.hint, 'Ask the user to reopen o/r#7 in the GitHub UI now.');
  assert.deepEqual(r.json.error.details, { closedAt: '2026-10-22T12:00:01Z', state: 'CLOSED' });
  assert.equal(count(fake, isPatch('open')), 3, 'the reopen is retried 3 times');
  assert.equal(count(fake, isPatch('closed')), 1, 'the close is never retried');
  fake.expectCalls([isQuery, isSuites, isPatch('closed'), isPatch('open'), isQuery], { ordered: true });
});

test('a reopen that succeeds on the third try is a success', async () => {
  const fake = scene({ open: [serverError(), serverError(), pull('open', '2026-10-22T12:00:09Z')] });
  const r = await retrigger(fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.reopenedAt, '2026-10-22T12:00:09Z');
  assert.equal(count(fake, isPatch('open')), 3);
});

test('a reopen that errored but landed (the re-read says OPEN) is a success', async () => {
  const fake = scene({ open: [serverError()], pr: [prReply(), prReply({ state: 'OPEN' })] });
  const r = await retrigger(fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.newRuns.length, 2);
});

test('a reopen GitHub refuses outright (422) is not retried and ends in REOPEN_FAILED with its message', async () => {
  const refused: GhReply = {
    exitCode: 1,
    stdout: httpReply(
      'HTTP/2.0 422 Unprocessable Entity',
      JSON.stringify({ message: 'Validation Failed', errors: [{ message: 'state cannot be changed.' }] }),
    ),
    stderr: 'gh: Validation Failed (HTTP 422)\n',
  };
  const fake = scene({ open: [refused], pr: [prReply(), prReply({ state: 'CLOSED' })] });
  const r = await retrigger(fake);
  assert.equal(r.json.error.code, 'REOPEN_FAILED');
  assert.match(r.json.error.message, /state cannot be changed/);
  assert.equal(count(fake, isPatch('open')), 1);
});

test('a close that errored but landed (the re-read says CLOSED) still reopens', async () => {
  const fake = scene({ close: [serverError()], pr: [prReply(), prReply({ state: 'CLOSED' })] });
  const r = await retrigger(fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(count(fake, isPatch('closed')), 1, 'the close is never retried');
  assert.equal(count(fake, isPatch('open')), 1);
});

test('a close that failed and did not land is GH_FAILED, and no reopen is sent', async () => {
  const fake = scene({ close: [serverError()], pr: [prReply(), prReply()] });
  const r = await retrigger(fake);
  assert.equal(r.exitCode, EXIT.GH_FAILED, r.stdout);
  assert.equal(r.json.error.code, 'GH_FAILED');
  assert.equal(count(fake, isPatch('closed')), 1);
  assert.equal(count(fake, isPatch('open')), 0);
});

test('a close whose re-read also fails still sends the reopen, and warns CLOSE_UNCONFIRMED', async () => {
  const fake = scene({ close: [serverError()], pr: [prReply(), serverError()] });
  const r = await retrigger(fake);
  assert.equal(count(fake, isPatch('closed')), 1, 'the close is never retried');
  assert.equal(count(fake, isPatch('open')), 1, 'the close may have landed, so the PR is reopened');
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const w = r.json.warnings.find((x: { code: string }) => x.code === 'CLOSE_UNCONFIRMED');
  assert.match(w.message, /may not have closed; it was reopened/);
});

/** Fire `shutdown` as the close PATCH is answered: the close lands, then SIGINT arrives before the reopen. */
function interruptOnClose(fake: FakeGh, shutdown: Shutdown): void {
  fake.on(
    (a, stdin) => {
      if (!isPatch('closed')(a, stdin)) return false;
      shutdown.trigger('SIGINT');
      return true;
    },
    pull('closed', '2026-10-22T12:00:01Z'),
  );
}

test('SIGINT between the close and the reopen still reopens the PR, then reports INTERRUPTED', async () => {
  const fake = scene();
  const shutdown = createShutdown();
  interruptOnClose(fake, shutdown);
  const r = await retrigger(fake, [], { shutdown });
  assert.equal(count(fake, isPatch('closed')), 1);
  assert.equal(count(fake, isPatch('open')), 1, 'the reopen runs on a client the abort cannot kill');
  assert.equal(r.exitCode, EXIT.SIGINT, r.stdout);
  assert.equal(r.json.error.code, 'INTERRUPTED');
});

test('a deadline that kills the close PATCH in flight still sends the reopen (the close may have landed)', async () => {
  const fake = scene({ close: [{ ...pull('closed', '2026-10-22T12:00:01Z'), delayMs: 60_000 }] });
  const r = await retrigger(fake, ['--timeout', '10s']);
  assert.equal(count(fake, isPatch('closed')), 1);
  assert.equal(count(fake, isPatch('open')), 1);
  assert.equal(r.exitCode, EXIT.TIMEOUT, r.stdout);
  assert.equal(r.json.error.code, 'TIMEOUT');
});

test('a reopen still hanging when the grace window after the deadline ends is REOPEN_FAILED with closedAt', async () => {
  const fake = scene({
    close: [{ ...pull('closed', '2026-10-22T12:00:01Z'), delayMs: 9_000 }],
    open: [{ ...pull('open', '2026-10-22T12:00:02Z'), hang: true }],
  });
  const r = await retrigger(fake, ['--timeout', '10s']);
  assert.equal(count(fake, isPatch('open')), 1);
  assert.equal(r.exitCode, EXIT.GH_FAILED, r.stdout);
  assert.equal(r.json.error.code, 'REOPEN_FAILED');
  assert.match(r.json.error.message, /grace window ended before the reopen finished/);
  assert.equal(r.json.error.details.closedAt, '2026-10-22T12:00:01Z');
});

test('no new check suite within the window warns NO_NEW_RUNS; the window runs on the injected clock', async () => {
  const fake = scene({ suites: [suites([11])] });
  const r = await retrigger(fake, ['--wait-for-runs', '20s']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(r.json.newRuns, []);
  const w = r.json.warnings.find((x: { code: string }) => x.code === 'NO_NEW_RUNS');
  assert.match(w.message, /within 20s of the reopen/);
  const polls = fake.calls.filter((c) => isSuites(c.argv));
  // Baseline, then reads at 0, 3, 7.5, 14.25 and 20 s after the reopen.
  assert.equal(polls.length, 6);
  const span = (polls.at(-1)?.at ?? 0) - (polls[1]?.at ?? 0);
  assert.ok(span >= 19_000 && span <= 20_500, `polled for ${span} ms`);
});

test('--wait-for-runs 0s checks once; an invalid or too long window is VALIDATION before any call', async () => {
  const once = scene({ suites: [suites([11])] });
  const r = await retrigger(once, ['--wait-for-runs', '0s']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(once.calls.filter((c) => isSuites(c.argv)).length, 2);
  for (const bad of ['soon', '60', '10m']) {
    const fake = scene();
    const v = await retrigger(fake, ['--wait-for-runs', bad]);
    assert.equal(v.exitCode, EXIT.USAGE, `${bad}: ${v.stdout}`);
    assert.equal(v.json.error.code, 'VALIDATION');
    assert.equal(fake.calls.length, 0);
  }
});

test('--dry-run halts at the close PATCH: nothing is mutated', async () => {
  const fake = scene();
  const r = await retrigger(fake, ['--dry-run']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.dryRun, true);
  assert.ok(r.json.wouldRun[0].argv.includes('PATCH'));
  assert.deepEqual(JSON.parse(r.json.wouldRun[0].stdin), { state: 'closed' });
  fake.expectNoMutations();
  fake.expectCalls([isQuery, isSuites], { ordered: true, exhaustive: true });
});

test('the smoke scenario reaches the dry-run halt on the close PATCH', async () => {
  const fake = FakeGh.fromScenario('smoke/ci-retrigger');
  const r = await runInProcess(['ci', 'retrigger', 'powerhouse-inc/powerhouse#3301', '--dry-run'], { gh: fake });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.dryRun, true);
  assert.ok(r.json.wouldRun[0].argv.includes('repos/powerhouse-inc/powerhouse/pulls/3301'));
  fake.expectNoMutations();
});
