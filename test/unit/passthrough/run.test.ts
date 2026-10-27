// The passthrough envelope (02 §10, 03 M7.1, Q5): json or text inline under a cap that keeps the
// document under the 16 KB bound, stdoutPath past it, stderr capped at 2 KB, -R injection, the gh
// child environment, and the GH_FAILED / DIFF_TOO_LARGE mappings.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { DEFAULT_MAX_BYTES } from '../../../src/core/output.ts';
import { inlineCap, STDERR_MAX } from '../../../src/passthrough/run.ts';
import { EXIT } from '../../contract/exit-table.ts';
import { FakeClock } from '../../helpers/fake-clock.ts';
import { FakeGh } from '../../helpers/fake-gh.ts';
import { gitCheckout } from '../../helpers/fake-git.ts';
import { runInProcess } from '../../helpers/harness.ts';

const DIFF_406 = readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'gh-stderr', 'diff-406.txt'), 'utf8');
const ok = (stdout: string, stderr = '') => ({ exitCode: 0, stdout, stderr });

describe('envelope', () => {
  test('JSON stdout is parsed into json, with argv, exitCode and stdoutBytes', async () => {
    const out = '[{"number":7}]\n';
    const fake = new FakeGh().on({ prefix: ['pr', 'list'] }, ok(out));
    const r = await runInProcess(['pr', 'list', '--json', 'number', '-R', 'octo/demo'], { gh: fake });
    assert.equal(r.exitCode, EXIT.OK, r.stdout);
    assert.deepEqual(r.json, {
      passthrough: {
        argv: ['gh', 'pr', 'list', '--json', 'number', '-R', 'github.com/octo/demo'],
        exitCode: 0,
        json: [{ number: 7 }],
        stdoutBytes: Buffer.byteLength(out),
      },
    });
  });

  test('other stdout is text; stderr is kept', async () => {
    const fake = new FakeGh().on({ prefix: ['pr', 'diff'] }, ok('diff --git a/x b/x\n', 'note: something\n'));
    const r = await runInProcess(['pr', 'diff', '7', '-R', 'octo/demo'], { gh: fake });
    assert.equal(r.exitCode, EXIT.OK, r.stdout);
    assert.equal(r.json.passthrough.text, 'diff --git a/x b/x\n');
    assert.equal(r.json.passthrough.stderr, 'note: something\n');
    assert.equal(r.json.passthrough.json, undefined);
  });

  test('text up to the inline cap stays inline and the document is not spilled', async () => {
    const cap = inlineCap(DEFAULT_MAX_BYTES);
    const body = 'a'.repeat(cap - 2); // + 2 quotes when serialized
    const fake = new FakeGh().on({ prefix: ['pr', 'diff'] }, ok(body));
    const r = await runInProcess(['pr', 'diff', '7', '-R', 'octo/demo'], { gh: fake });
    assert.equal(r.json.spilled, undefined);
    assert.equal(r.json.passthrough.text, body);
    assert.ok(Buffer.byteLength(r.stdout) <= DEFAULT_MAX_BYTES);
  });

  test('past the cap, stdout goes to stdoutPath (the envelope, not a runner spill)', async () => {
    const body = 'b'.repeat(13 * 1024);
    const fake = new FakeGh().on({ prefix: ['pr', 'diff'] }, ok(body));
    const r = await runInProcess(['pr', 'diff', '7', '-R', 'octo/demo'], { gh: fake });
    assert.equal(r.exitCode, EXIT.OK);
    assert.equal(r.json.spilled, undefined);
    const p = r.json.passthrough;
    assert.equal(p.text, undefined);
    assert.equal(p.stdoutBytes, body.length);
    assert.match(p.stdoutPath, /octo[/\\]demo[/\\]passthrough[/\\]pr-diff-[0-9a-f]{12}\.txt$/);
    assert.equal(readFileSync(p.stdoutPath, 'utf8'), body);
  });

  test('large JSON spills as .json; the cap counts escaped bytes, not characters', async () => {
    const big = JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ n: i })));
    const fake = new FakeGh()
      .on({ prefix: ['api', 'repos/o/r/pulls'] }, ok(big))
      .on({ prefix: ['pr', 'diff'] }, ok('"\n'.repeat(5000)));
    const a = await runInProcess(['api', 'repos/o/r/pulls'], { gh: fake });
    assert.match(a.json.passthrough.stdoutPath, /api-[0-9a-f]{12}\.json$/);
    assert.equal(a.json.passthrough.json, undefined);
    const b = await runInProcess(['pr', 'diff', '1', '-R', 'o/r'], { gh: fake });
    assert.ok(b.json.passthrough.stdoutPath, '10,000 bytes of quotes and newlines serialize to 20,000');
  });

  test('--max-bytes lowers the inline cap with it', async () => {
    const body = 'c'.repeat(5000);
    const fake = new FakeGh().on({ prefix: ['pr', 'diff'] }, ok(body));
    const r = await runInProcess(['pr', 'diff', '7', '-R', 'octo/demo', '--max-bytes', '8192'], { gh: fake });
    assert.equal(r.json.spilled, undefined);
    assert.ok(r.json.passthrough.stdoutPath);
    assert.deepEqual(fake.calls[0]?.argv, ['pr', 'diff', '7', '-R', 'github.com/octo/demo']);
  });

  test('stderr is capped at 2 KB (its tail)', async () => {
    const stderr = `${'x'.repeat(5000)}\nthe last line\n`;
    const fake = new FakeGh().on({ prefix: ['pr', 'list'] }, ok('[]', stderr));
    const r = await runInProcess(['pr', 'list', '-R', 'o/r'], { gh: fake });
    assert.ok(Buffer.byteLength(r.json.passthrough.stderr) <= STDERR_MAX);
    assert.ok(r.json.passthrough.stderr.endsWith('the last line\n'));
  });

  test('the gh child gets no pager, no prompts, no color and no update notifier', async () => {
    const fake = new FakeGh().on({ prefix: ['pr', 'list'] }, ok('[]'));
    await runInProcess(['pr', 'list', '-R', 'o/r'], { gh: fake, env: { GH_PAGER: 'less', PAGER: 'less' } });
    const env = fake.calls[0]?.env ?? {};
    assert.equal(env.GH_PROMPT_DISABLED, '1');
    assert.equal(env.NO_COLOR, '1');
    assert.equal(env.GH_NO_UPDATE_NOTIFIER, '1');
    // src/gh/env.ts sets GH_PAGER='' rather than 02 §10's 'cat'; gh treats both as no pager.
    assert.ok(env.GH_PAGER === '' || env.GH_PAGER === 'cat');
    assert.equal(env.PAGER, 'cat');
  });
});

describe('-R injection', () => {
  test('from the cwd checkout', async () => {
    const fake = new FakeGh().on({ prefix: ['issue', 'list'] }, ok('[]'));
    await runInProcess(['issue', 'list'], { gh: fake, git: gitCheckout('octo/demo') });
    assert.deepEqual(fake.calls[0]?.argv, ['issue', 'list', '-R', 'github.com/octo/demo']);
  });

  test('from GH_REPO', async () => {
    const fake = new FakeGh().on({ prefix: ['run', 'list'] }, ok('[]'));
    await runInProcess(['run', 'list', '-L', '5'], { gh: fake, env: { GH_REPO: 'octo/demo' } });
    assert.deepEqual(fake.calls[0]?.argv, ['run', 'list', '-L', '5', '-R', 'github.com/octo/demo']);
  });

  test('none when nothing resolves', async () => {
    const fake = new FakeGh().on({ prefix: ['label', 'list'] }, ok('[]'));
    const r = await runInProcess(['label', 'list'], { gh: fake });
    assert.equal(r.exitCode, EXIT.OK, r.stdout);
    assert.deepEqual(fake.calls[0]?.argv, ['label', 'list']);
  });

  test('search keeps its own -R filter and never gets the cwd repo', async () => {
    const fake = new FakeGh().on({ prefix: ['search', 'issues'] }, ok('[]'));
    await runInProcess(['search', 'issues', 'bug', '-R', 'cli/cli'], { gh: fake, git: gitCheckout('octo/demo') });
    assert.deepEqual(fake.calls[0]?.argv, ['search', 'issues', 'bug', '-R', 'cli/cli']);
  });

  test('repo view takes the repo as its positional', async () => {
    const fake = new FakeGh().on({ prefix: ['repo', 'view'] }, ok('{"name":"demo"}'));
    const r = await runInProcess(['repo', 'view', '--json', 'name'], { gh: fake, git: gitCheckout('octo/demo') });
    assert.deepEqual(fake.calls[0]?.argv, ['repo', 'view', 'github.com/octo/demo', '--json', 'name']);
    assert.deepEqual(r.json.passthrough.json, { name: 'demo' });
  });

  test('api fills {owner}/{repo}', async () => {
    const fake = new FakeGh().on({ prefix: ['api'] }, ok('[]'));
    await runInProcess(['api', 'repos/{owner}/{repo}/pulls'], { gh: fake, git: gitCheckout('octo/demo') });
    assert.deepEqual(fake.calls[0]?.argv, ['api', 'repos/octo/demo/pulls']);
  });
});

describe('run list --commit with a short SHA', () => {
  const FULL = '2edd19f221aa4bb5cc6dd7ee8ff9900112233445';
  const checkout = () => gitCheckout('octo/demo', { refs: { '2edd19f221': FULL } });

  test('is expanded from the local checkout, in every spelling, with COMMIT_EXPANDED', async () => {
    for (const [flag, want] of [
      [
        ['--commit', '2edd19f221'],
        ['--commit', FULL],
      ],
      [['--commit=2edd19f221'], [`--commit=${FULL}`]],
      [
        ['-c', '2edd19f221'],
        ['-c', FULL],
      ],
      [['-c2edd19f221'], [`-c${FULL}`]],
    ] as const) {
      const fake = new FakeGh().on({ prefix: ['run', 'list'] }, ok('[]'));
      const r = await runInProcess(['run', 'list', ...flag, '-L', '5'], { gh: fake, git: checkout() });
      assert.equal(r.exitCode, EXIT.OK, r.stdout);
      assert.deepEqual(fake.calls[0]?.argv, ['run', 'list', ...want, '-L', '5', '-R', 'github.com/octo/demo']);
      assert.deepEqual(
        r.json.warnings.map((w: { code: string }) => w.code),
        ['COMMIT_EXPANDED'],
      );
      assert.match(r.json.warnings[0].message, new RegExp(`2edd19f221 was expanded to ${FULL}`));
    }
  });

  test('a full SHA, or no --commit, passes through untouched and without a warning', async () => {
    const fake = new FakeGh().on({ prefix: ['run', 'list'] }, ok('[]'));
    const r = await runInProcess(['run', 'list', '--commit', FULL], { gh: fake, git: checkout() });
    assert.deepEqual(fake.calls[0]?.argv, ['run', 'list', '--commit', FULL, '-R', 'github.com/octo/demo']);
    assert.equal(r.json.warnings, undefined);
  });

  test('unresolvable is REF_NOT_FOUND (5) with no gh call, not a silent []', async () => {
    const rows: [argv: string[], hint: RegExp][] = [
      [['run', 'list', '--commit', 'abcdef1'], /not a commit in the local checkout; git fetch/],
      [
        ['run', 'list', '--commit', '2edd19f221', '-R', 'cli/cli'],
        /git rev-parse 2edd19f221 in a checkout of cli\/cli/,
      ],
    ];
    for (const [argv, hint] of rows) {
      const fake = new FakeGh();
      const r = await runInProcess(argv, { gh: fake, git: checkout() });
      assert.equal(r.exitCode, EXIT.NOT_FOUND, r.stdout);
      assert.equal(r.json.error.code, 'REF_NOT_FOUND');
      assert.match(r.json.error.hint, hint);
      assert.match(r.json.error.hint, /ghx api repos\/.+\/commits\//);
      assert.deepEqual(fake.calls, []);
    }
  });
});

describe('failures', () => {
  test('a non-zero gh exit is GH_FAILED (7) with the envelope in details', async () => {
    const stderr = 'GraphQL: Could not resolve to an issue or pull request with the number of 9. (repository.issue)\n';
    const fake = new FakeGh().on({ prefix: ['issue', 'view'] }, { exitCode: 1, stdout: '', stderr });
    const r = await runInProcess(['issue', 'view', '9', '-R', 'octo/demo'], { gh: fake });
    assert.equal(r.exitCode, EXIT.GH_FAILED, r.stdout);
    assert.equal(r.json.error.code, 'GH_FAILED');
    const p = r.json.error.details.passthrough;
    assert.deepEqual(p.argv, ['gh', 'issue', 'view', '9', '-R', 'github.com/octo/demo']);
    assert.equal(p.exitCode, 1);
    assert.equal(p.stderr, stderr);
    assert.equal(fake.calls.length, 1, 'not retried');
  });

  test('a transient failure is retried before it becomes GH_FAILED', async () => {
    const fake = new FakeGh().on({ prefix: ['pr', 'list'] }, [
      { exitCode: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway (https://api.github.com/graphql)\n' },
      ok('[]'),
    ]);
    const clock = new FakeClock();
    let done = false;
    const pending = runInProcess(['pr', 'list', '-R', 'o/r'], { gh: fake, clock }).finally(() => {
      done = true;
    });
    await clock.runUntil(() => done);
    const r = await pending;
    assert.equal(r.exitCode, EXIT.OK, r.stdout);
    assert.equal(fake.calls.length, 2);
  });

  test('pr diff with HTTP 406 is DIFF_TOO_LARGE (7) with a local git diff hint', async () => {
    const fake = new FakeGh().on({ prefix: ['pr', 'diff'] }, { exitCode: 1, stdout: '', stderr: DIFF_406 });
    const r = await runInProcess(['pr', 'diff', '3169', '-R', 'powerhouse-inc/powerhouse'], { gh: fake });
    assert.equal(r.exitCode, EXIT.GH_FAILED, r.stdout);
    assert.equal(r.json.error.code, 'DIFF_TOO_LARGE');
    assert.match(r.json.error.hint, /git fetch origin pull\/3169\/head && git diff/);
    assert.equal(r.json.error.details.status, 406);
    assert.deepEqual(r.json.error.details.suggestion, ['git', 'fetch', 'origin', 'pull/3169/head']);
    assert.equal(r.json.error.details.passthrough.stderr, DIFF_406);
  });

  test('a 406 from anything but pr diff stays GH_FAILED', async () => {
    const fake = new FakeGh().on(
      { prefix: ['api'] },
      { exitCode: 1, stdout: '', stderr: 'gh: Not Acceptable (HTTP 406)\n' },
    );
    const r = await runInProcess(['api', 'repos/o/r/pulls/1/files'], { gh: fake });
    assert.equal(r.json.error.code, 'GH_FAILED');
    assert.equal(r.exitCode, EXIT.GH_FAILED);
  });

  test('gh missing stays ENV_GH_MISSING (no exit code to wrap)', async () => {
    const r = await runInProcess(['pr', 'list', '-R', 'o/r'], {
      proc: async () => {
        const err = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
        return {
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          aborted: false,
          durationMs: 0,
          spawnError: err,
        };
      },
    });
    assert.equal(r.json.error.code, 'ENV_GH_MISSING');
    assert.equal(r.exitCode, EXIT.ENV);
  });
});
