import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { z } from 'zod';
import { isGhxError } from '../../../src/core/errors.ts';
import { seededRandom } from '../../../src/core/random.ts';
import { createGh } from '../../../src/gh/index.ts';
import type { ProcRequest } from '../../../src/proc/runner.ts';
import { FakeClock, flush } from '../../helpers/fake-clock.ts';
import { FakeGh, FakeGhUnmatched } from '../../helpers/fake-gh.ts';
import { canonicalArgv } from '../../helpers/fixture-match.ts';
import { runInProcess } from '../../helpers/harness.ts';
import { listScenarios } from '../../helpers/scenario.ts';

const tmp = mkdtempSync(join(tmpdir(), 'ghx-fakegh-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const repo = { host: 'github.com', owner: 'o', name: 'r' };
const req = (args: string[], extra: Partial<ProcRequest> = {}): ProcRequest => ({
  cmd: 'gh',
  args,
  env: {},
  signal: new AbortController().signal,
  ...extra,
});

test('canonical argv: -R normalised, -H and -f/-F pairs sorted after the rest', () => {
  assert.deepEqual(canonicalArgv(['api', '-H', 'b: 2', 'x', '-F', 'n=1', '-H', 'a: 1', '-f', 'q=2', '--repo=o/r']), [
    'api',
    'x',
    '-R',
    'github.com/o/r',
    '-H',
    'a: 1',
    '-H',
    'b: 2',
    '-F',
    'n=1',
    '-f',
    'q=2',
  ]);
});

test('canonical argv: --hostname github.com is dropped, other hosts are kept', () => {
  assert.deepEqual(canonicalArgv(['api', '--hostname', 'github.com', 'x']), ['api', 'x']);
  assert.deepEqual(canonicalArgv(['api', '--hostname=github.com', 'x']), ['api', 'x']);
  assert.deepEqual(canonicalArgv(['api', '--hostname', 'ghe.example', 'x']), ['api', '--hostname', 'ghe.example', 'x']);
});

test('scenario replay through createGh: successive replies, last repeats; field order is irrelevant', async () => {
  const fake = FakeGh.fromScenario('fake-gh-selftest');
  const gh = createGh({
    proc: fake.runner(),
    clock: new FakeClock(),
    signal: new AbortController().signal,
    mode: 'read',
    random: seededRandom(1),
  });
  const S = z.object({ number: z.number(), second: z.boolean().optional() });
  assert.deepEqual(await gh.json({ args: ['pr', 'view', '1', '--json', 'number'], repo }, S), { number: 1 });
  assert.deepEqual(await gh.json({ args: ['pr', 'view', '1', '--json', 'number'], repo }, S), {
    number: 1,
    second: true,
  });
  assert.deepEqual(await gh.json({ args: ['pr', 'view', '1', '--json', 'number'], repo }, S), {
    number: 1,
    second: true,
  });
  const v = await gh.graphql('{ viewer { login } }', { n: 1 }, z.object({ viewer: z.object({ login: z.string() }) }));
  assert.equal(v.viewer.login, 'viewer-user');
  fake.expectNoMutations();
});

test('a failing fixture surfaces as the classified public error', async () => {
  const fake = FakeGh.fromScenario('fake-gh-selftest');
  const gh = createGh({
    proc: fake.runner(),
    clock: new FakeClock(),
    signal: new AbortController().signal,
    mode: 'read',
    random: seededRandom(1),
  });
  await assert.rejects(gh.exec({ args: ['pr', 'view', '404'], repo, notFound: 'PR_NOT_FOUND' }), (e) =>
    isGhxError(e, 'PR_NOT_FOUND'),
  );
});

test('an unmatched call throws and names the nearest fixtures', async () => {
  const fake = FakeGh.fromScenario('fake-gh-selftest');
  await assert.rejects(fake.runner()(req(['pr', 'view', '2', '--json', 'number', '-R', 'o/r'])), (e) => {
    assert.ok(e instanceof FakeGhUnmatched);
    assert.equal(e.nearest[0], 'pr view 1 --json number -R github.com/o/r');
    assert.equal(e.nearest.length, 3);
    return true;
  });
});

test('stdin is matched for writes (key order irrelevant)', async () => {
  const fake = FakeGh.fromScenario('fake-gh-selftest');
  const run = fake.runner();
  const args = ['api', '--include', '-X', 'POST', 'repos/o/r/issues', '--input', '-'];
  const ok = await run(req(args, { stdin: '{"body":"b","title":"t"}' }));
  assert.match(ok.stdout, /"number":7/);
  await assert.rejects(run(req(args, { stdin: '{"title":"other"}' })), FakeGhUnmatched);
  assert.throws(() => fake.expectNoMutations(), /mutating calls/);
});

test('stdoutFile fixtures are copied to the request file (logs)', async () => {
  const fake = FakeGh.fromScenario('fake-gh-selftest');
  const gh = createGh({
    proc: fake.runner(),
    clock: new FakeClock(),
    signal: new AbortController().signal,
    mode: 'read',
    random: seededRandom(1),
  });
  const file = join(tmp, 'job-1.log');
  await gh.apiText({ path: 'repos/o/r/actions/jobs/1/logs', toFile: file });
  assert.equal(readFileSync(file, 'utf8'), '##[error]Process completed with exit code 1.\n');
});

test('hang blocks until the caller aborts; delayMs resolves on the FakeClock', async () => {
  const clock = new FakeClock();
  const fake = FakeGh.fromScenario('fake-gh-selftest', { clock });
  const c = new AbortController();
  const p = fake.runner()(req(['pr', 'checks', '9', '-R', 'o/r'], { signal: c.signal }));
  let settled = false;
  void p.then(() => {
    settled = true;
  });
  await clock.advance(3_600_000);
  assert.equal(settled, false);
  c.abort();
  assert.equal((await p).aborted, true);
  const slow = new FakeGh({ clock }).on(['pr', 'list'], { exitCode: 0, stdout: '[]', stderr: '', delayMs: 5_000 });
  const q = slow.runner()(req(['pr', 'list']));
  let done = false;
  void q.then(() => {
    done = true;
  });
  await clock.advance(4_999);
  await flush();
  assert.equal(done, false);
  await clock.advance(1);
  assert.equal((await q).stdout, '[]');
});

test('on(): successive replies, prefix and predicate matchers; later rules win', async () => {
  const fake = new FakeGh()
    .on({ prefix: ['run', 'list'] }, { exitCode: 0, stdout: 'any', stderr: '' })
    .on(
      ['run', 'list', '--limit', '1'],
      [
        { exitCode: 0, stdout: 'a', stderr: '' },
        { exitCode: 0, stdout: 'b', stderr: '' },
      ],
    )
    .on((argv) => argv[0] === 'repo', { exitCode: 0, stdout: 'repo', stderr: '' });
  const run = fake.runner();
  assert.deepEqual(
    [
      (await run(req(['run', 'list', '--limit', '1']))).stdout,
      (await run(req(['run', 'list', '--limit', '1']))).stdout,
      (await run(req(['run', 'list', '--limit', '1']))).stdout,
      (await run(req(['run', 'list', '--json', 'x']))).stdout,
      (await run(req(['repo', 'view']))).stdout,
    ],
    ['a', 'b', 'b', 'any', 'repo'],
  );
  fake.assertAllConsumed();
});

test('timeline replies are selected by FakeClock.monotonic()', async () => {
  const clock = new FakeClock();
  const reply = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' });
  const fake = new FakeGh().timeline(clock, [
    { atMs: 0, on: [[['pr', 'checks', '1'], reply('nothing reported')]] },
    { atMs: 45_000, on: [[['pr', 'checks', '1'], reply('9 pending')]] },
    { atMs: 240_000, on: [[['pr', 'checks', '1'], reply('typecheck pass')]] },
  ]);
  const run = fake.runner();
  const at = async (ms: number) => {
    await clock.advance(ms - clock.monotonic());
    return (await run(req(['pr', 'checks', '1']))).stdout;
  };
  assert.deepEqual(
    [await at(0), await at(44_999), await at(45_000), await at(300_000)],
    ['nothing reported', 'nothing reported', '9 pending', 'typecheck pass'],
  );
  assert.deepEqual(
    fake.calls.map((c) => c.at),
    [0, 44_999, 45_000, 300_000],
  );
});

test('expectCalls (ordered/exhaustive), expectNoCall, assertAllConsumed', async () => {
  const fake = FakeGh.fromScenario('fake-gh-selftest');
  const run = fake.runner();
  await run(req(['pr', 'view', '1', '--json', 'number', '-R', 'o/r']));
  await run(req(['pr', 'view', '404', '-R', 'o/r']));
  fake.expectCalls([['pr', 'view', '1', '--json', 'number', '-R', 'o/r'], { prefix: ['pr', 'view', '404'] }], {
    ordered: true,
    exhaustive: true,
  });
  assert.throws(
    () => fake.expectCalls([{ prefix: ['pr', 'view', '404'] }, { prefix: ['pr', 'view', '1'] }], { ordered: true }),
    /in order/,
  );
  assert.throws(
    () => fake.expectCalls([{ prefix: ['pr', 'view'] }], { exhaustive: false, ordered: false }) ?? assert.fail(),
    () => true,
  );
  fake.expectNoCall(['run', 'view']);
  assert.throws(() => fake.expectNoCall({ prefix: ['pr'] }), /was called/);
  assert.throws(() => fake.assertAllConsumed(), /not consumed: 002-pr-view-1-again.json/);
});

test('through the harness: doctor against a FakeGh scenario makes no mutation', async () => {
  const fake = FakeGh.fromScenario('doctor-ok');
  const r = await runInProcess(['doctor'], { gh: fake });
  assert.notEqual(r.exitCode, 1);
  fake.expectNoMutations();
  fake.expectCalls([['--version'], ['auth', 'status', '--json', 'hosts'], ['pr', 'checks', '--help']], {
    ordered: true,
    exhaustive: true,
  });
});

test('scenarios are discovered by directory', () => {
  const all = listScenarios();
  assert.ok(all.includes('doctor-ok') && all.includes('fake-gh-selftest'));
});
