// The pr merge test world: the 02 §14 worked example (pr-status-world.ts; #3301, mergeable with its red
// check waived as shared with main) plus the merge endpoints: the PUT, the REST re-read of the PR, the
// fresh children list and the head ref. Tests override single replies with fake.on() after install().
import { FakeClock, flush } from '../helpers/fake-clock.ts';
import { FakeGh, type GhReply } from '../helpers/fake-gh.ts';
import { HEAD } from '../unit/pr/snapshot-fixture.ts';
import { httpReply, okJson } from './ci-why-world.ts';
import { at, type InstallOptions, install, NOW, run, SLUG } from './pr-status-world.ts';

export { HEAD, OLD_HEAD } from '../unit/pr/snapshot-fixture.ts';
export { CONFIG, contexts, NOW, REF, SLUG, workedPr } from './pr-status-world.ts';

export const MERGE_COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
export const MERGED_AT = '2026-10-22T09:15:03Z';
export const MOVED_HEAD = 'd00dfeed00000000000000000000000000000001';
export const HEAD_BRANCH = 'fix/reactor-bind-document-id';

const isPath = (argv: readonly string[], path: string, method?: string) =>
  argv.some((a) => a.split('?')[0] === `repos/${SLUG}${path}`) && (method === undefined || argv.includes(method));

export const isPut = (argv: string[]) => isPath(argv, '/pulls/3301/merge', 'PUT');
export const isPullGet = (argv: string[]) => isPath(argv, '/pulls/3301', 'GET');
export const isChildren = (argv: string[]) => isPath(argv, '/pulls', 'GET');
export const isRefGet = (argv: string[]) => isPath(argv, `/git/ref/heads/${HEAD_BRANCH}`, 'GET');
export const isRefDelete = (argv: string[]) => isPath(argv, `/git/refs/heads/${HEAD_BRANCH}`, 'DELETE');

/** The REST pull as GitHub returns it (only the fields pr merge reads). */
export function pullJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 3301,
    state: 'closed',
    merged: true,
    merged_at: MERGED_AT,
    merge_commit_sha: MERGE_COMMIT,
    mergeable_state: 'unknown',
    head: { ref: HEAD_BRANCH, sha: HEAD },
    base: { ref: 'main' },
    ...over,
  };
}

/** The PR still open at `sha` with this mergeable_state. */
export const openPull = (mergeableState: string, sha = HEAD) =>
  pullJson({
    state: 'open',
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    mergeable_state: mergeableState,
    head: { ref: HEAD_BRANCH, sha },
  });

export const putOk = (): GhReply =>
  okJson({ sha: MERGE_COMMIT, merged: true, message: 'Pull Request successfully merged' });

/** A REST failure as `gh api --include` reports it: exit 1, the status line and GitHub's JSON body. */
export function httpError(status: number, text: string, message: string): GhReply {
  return {
    exitCode: 1,
    stdout: httpReply(`HTTP/2.0 ${status} ${text}`, JSON.stringify({ message, status: String(status) })),
    stderr: `gh: ${message} (HTTP ${status})\n`,
  };
}

export const put405 = () => httpError(405, 'Method Not Allowed', 'Pull Request is not mergeable');
export const put409 = () => httpError(409, 'Conflict', 'Head branch was modified. Review and try the merge again.');
export const put502 = () => httpError(502, 'Bad Gateway', 'Server Error');

/** The worked example plus a successful merge: PUT 200, the re-read shows it merged at HEAD. */
export function installMerge(fake: FakeGh = new FakeGh(), o: InstallOptions = {}): FakeGh {
  install(fake, o);
  fake.on(isPut, putOk());
  fake.on(isPullGet, okJson(pullJson()));
  fake.on(isChildren, okJson([]));
  fake.on(isRefGet, okJson({ ref: `refs/heads/${HEAD_BRANCH}`, object: { sha: HEAD, type: 'commit' } }));
  fake.on(isRefDelete, { exitCode: 0, stdout: 'HTTP/2.0 204 No Content\r\n\r\n', stderr: '' });
  return fake;
}

/** The PUT calls made, with their parsed JSON bodies. */
export function puts(fake: FakeGh): Record<string, unknown>[] {
  return fake.calls.filter((c) => isPut(c.argv)).map((c) => JSON.parse(c.stdin ?? 'null') as Record<string, unknown>);
}

/**
 * Make gh replies whose endpoint matches `re` take `ms` of REAL time, as slow log reads do under a loaded
 * test run. Fake time must not run past them: the main comparison's budget is a fake-clock timer.
 */
export function slowReplies(fake: FakeGh, re: RegExp, ms: number): void {
  const runner = fake.runner.bind(fake);
  fake.runner = (other) => {
    const r = runner(other);
    return async (req) => {
      if (req.args.some((a) => re.test(a.split('?')[0] ?? ''))) await new Promise((ok) => setTimeout(ok, ms));
      return r(req);
    };
  };
}

/** gh calls started and settled through `fake`, counted by a wrapper on its runner. */
interface GhActivity {
  started: number;
  settled: number;
  /** Calls that fetched a job or its log: real fs work (log analysis, caches) follows them. */
  heavy: number;
}

const IO_HEAVY = /\/actions\/jobs\/\d+(\/logs)?$/;

function track(fake: FakeGh): GhActivity {
  const io: GhActivity = { started: 0, settled: 0, heavy: 0 };
  const runner = fake.runner.bind(fake);
  fake.runner = (other) => {
    const r = runner(other);
    return async (req) => {
      io.started++;
      if (req.args.some((a) => IO_HEAVY.test(a.split('?')[0] ?? ''))) io.heavy++;
      try {
        return await r(req);
      } finally {
        io.settled++;
      }
    };
  };
  return io;
}

const tick = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/**
 * Real-time wait until no gh reply is in flight and, after a job or log fetch, until calls stop starting
 * (the quiesce of ci-wait-world.ts: log analysis is real I/O that fake time must not outrun). Bounded, so a
 * reply parked on a fake-clock delay cannot hang the driver.
 */
async function settle(io: GhActivity, heavySeen: number): Promise<void> {
  for (let i = 0; i < 1_000 && io.started !== io.settled; i++) await tick(1);
  if (io.heavy === heavySeen) return;
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 500 && stable < 5; i++) {
    await tick(10);
    const n = io.started === io.settled ? io.started : -2;
    stable = n === last && n >= 0 ? stable + 1 : 0;
    last = n;
  }
}

/**
 * Run `ghx <argv>` while advancing the fake clock, so mergeable retries and verify polls complete. Like
 * ci-wait-world.ts's drive: fake time only advances once gh replies and the real I/O after log fetches have
 * settled, so the main comparison's 60 s fake-clock budget never expires under a loaded test run.
 */
export async function runMerge(argv: string[], fake: FakeGh, clock = new FakeClock(NOW)) {
  const io = track(fake);
  let done = false;
  const p = run(argv, fake, { clock }).finally(() => {
    done = true;
  });
  const limit = clock.monotonic() + 120_000;
  let heavySeen = 0;
  await flush();
  for (;;) {
    await settle(io, heavySeen);
    heavySeen = io.heavy;
    if (done) break;
    if (clock.monotonic() >= limit) throw new Error('runMerge: the command did not finish within 120 s of fake time');
    await clock.advance(500);
  }
  return p;
}

export { at, okJson };
