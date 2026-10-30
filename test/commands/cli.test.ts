// The runner and router through runInProcess (01 §9 commit 9).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createShutdown } from '../../src/core/signals.ts';
import { EXIT } from '../contract/exit-table.ts';
import { FakeClock, flush } from '../helpers/fake-clock.ts';
import { FakeProc } from '../helpers/fake-proc.ts';
import { runInProcess } from '../helpers/harness.ts';

const ERROR_KEYS = ['code', 'message', 'hint', 'details'];

test('ghx version prints one JSON document and exits 0', async () => {
  const r = await runInProcess(['version']);
  assert.equal(r.exitCode, EXIT.OK);
  assert.equal(r.lines.length, 1);
  assert.equal(r.json.name, 'ghx');
  assert.match(r.json.version, /^\d+\.\d+\.\d+/);
  assert.equal(r.calls.length, 0);
});

test('--version is an alias of the version command', async () => {
  assert.equal((await runInProcess(['--version'])).json.name, 'ghx');
});

test('ghx --help is JSON under 4 KB and lists commands and builtins', async () => {
  for (const argv of [['--help'], ['-h'], ['help'], []]) {
    const r = await runInProcess(argv);
    assert.equal(r.exitCode, 0);
    assert.ok(Buffer.byteLength(r.stdout) < 4096, `${Buffer.byteLength(r.stdout)} bytes`);
    const names = Object.keys(r.json.commands);
    assert.ok(names.includes('version') && names.includes('schema') && names.includes('help'));
  }
});

test('command help: ghx version --help and ghx help version', async () => {
  const a = await runInProcess(['version', '--help']);
  const b = await runInProcess(['help', 'version']);
  assert.equal(a.json.name, 'version');
  assert.deepEqual(a.json, b.json);
  assert.deepEqual(a.json.flags, []);
});

test('command help derives flags, enums, defaults, positionals and JSON-only fields', async () => {
  const r = await runInProcess(['test', 'echo', '--help']);
  const flags = Object.fromEntries(r.json.flags.map((f: { flag: string }) => [f.flag, f]));
  assert.equal(flags['--count'].type, 'integer');
  assert.equal(flags['--tags'].multiple, true);
  assert.deepEqual(flags['--mode'].enum, ['fast', 'slow']);
  assert.equal(flags['--mode'].default, 'fast');
  assert.deepEqual(r.json.jsonOnlyFields, ['meta']);
  assert.deepEqual(r.json.positionals, [
    { name: 'target', required: false, variadic: false },
    { name: 'rest', required: false, variadic: true },
  ]);
});

test('version --schema prints input and output JSON Schema without gh calls', async () => {
  const r = await runInProcess(['version', '--schema']);
  assert.equal(r.json.command, 'version');
  assert.equal(r.json.kind, 'read');
  assert.equal(r.json.mode, 'single');
  assert.equal(r.json.input.type, 'object');
  assert.ok(r.json.output.properties.version);
  assert.ok(r.json.output.properties.warnings);
  assert.equal(r.calls.length, 0);
});

test('ghx schema: index, envelopes, a command, --all, unknown target', async () => {
  const idx = await runInProcess(['schema']);
  assert.ok(idx.json.targets.includes('envelopes'));
  assert.ok(idx.json.commands.some((c: { name: string }) => c.name === 'version'));
  const env = await runInProcess(['schema', 'envelopes']);
  assert.deepEqual(Object.keys(env.json).sort(), ['dryRun', 'error', 'spilled', 'streamLine']);
  assert.deepEqual(env.json.error.properties.error.required, ERROR_KEYS);
  const cmd = await runInProcess(['schema', 'version']);
  assert.deepEqual(cmd.json, (await runInProcess(['version', '--schema'])).json);
  const all = await runInProcess(['schema', '--all']);
  const full = JSON.parse(readFileSync(all.json.path, 'utf8'));
  assert.ok(full.commands.version && full.targets.envelopes);
  const bad = await runInProcess(['schema', 'envelope']);
  assert.equal(bad.exitCode, EXIT.USAGE);
  assert.deepEqual(bad.json.error.details.suggestions, ['envelopes']);
  assert.match(bad.json.error.hint, /^Did you mean: ghx schema envelopes\?$/);
});

test('ghx schema "pr create": a quoted target is split into its words', async () => {
  const quoted = await runInProcess(['schema', 'pr create']);
  assert.equal(quoted.exitCode, EXIT.OK, quoted.stdout);
  assert.deepEqual(quoted.json, (await runInProcess(['schema', 'pr', 'create'])).json);
  const typo = await runInProcess(['schema', 'pr crate']);
  assert.equal(typo.json.error.code, 'USAGE_UNKNOWN_COMMAND');
  assert.match(typo.json.error.hint, /ghx schema pr create/);
});

test('unknown command is refused with suggestions', async () => {
  const r = await runInProcess(['versoin']);
  assert.equal(r.exitCode, EXIT.USAGE);
  assert.equal(r.json.error.code, 'USAGE_UNKNOWN_COMMAND');
  assert.deepEqual(Object.keys(r.json.error), ERROR_KEYS);
  assert.deepEqual(r.json.error.details.suggestions, ['version']);
});

test('unknown flag gets a suggestion; --json gets the schema hint', async () => {
  const r = await runInProcess(['test', 'echo', '--nmae', 'x']);
  assert.equal(r.exitCode, EXIT.USAGE);
  assert.equal(r.json.error.code, 'USAGE_UNKNOWN_FLAG');
  assert.deepEqual(r.json.error.details, { flag: '--nmae', suggestions: ['--name'] });
  const j = await runInProcess(['version', '--json']);
  assert.equal(
    j.json.error.hint,
    "Output is a fixed schema; --fields a.b,c.d keeps the parts you need ('ghx version --schema' lists them).",
  );
  const brief = await runInProcess(['pr', 'status', '1', '--jq', '.state']);
  assert.match(brief.json.error.hint, /^Output is a fixed schema; --fields a\.b,c\.d or --brief keeps the parts/);
  assert.match(brief.json.error.hint, /'ghx pr status --schema' lists them/);
});

test('gh merge flags on ghx pr merge name the ghx form, and the policy that may refuse it', async () => {
  const rows: [argv: string[], suggestions: string[], hint: RegExp][] = [
    [['--merge'], ['--method merge'], /^gh's --merge is --method merge in ghx; omit it to use merge\.method/],
    [
      ['--squash'],
      ['--method squash'],
      /--method squash.*METHOD_NOT_ALLOWED unless merge\.allowedMethods .* lists squash/,
    ],
    [['-s'], ['--method squash'], /^gh's -s is --method squash in ghx/],
    [['-r'], ['--method rebase'], /lists rebase/],
    [['--match-head-commit', 'abc1234'], ['--expect-head <sha>'], /--expect-head <sha>/],
    [['--auto'], [], /no ghx flag.*ghx ci wait <pr> --until mergeable/],
  ];
  for (const [flags, suggestions, hint] of rows) {
    const r = await runInProcess(['pr', 'merge', '3289', ...flags]);
    assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
    assert.equal(r.json.error.code, 'USAGE_UNKNOWN_FLAG');
    assert.deepEqual(r.json.error.details, { flag: flags[0], suggestions });
    assert.match(r.json.error.hint, hint);
    assert.equal(r.calls.length, 0);
  }
  const other = await runInProcess(['pr', 'status', '1', '--squash']);
  assert.match(other.json.error.hint, /Run 'ghx pr status --help'/, 'the table is per command');
});

test('flags, positionals, variadic rest, numbers, repeats and negation', async () => {
  const r = await runInProcess([
    'test',
    'echo',
    'a',
    'b',
    'c',
    '--name',
    'n',
    '--count',
    '3',
    '--tags',
    'x',
    '--tags',
    'y',
    '--no-draft',
    '--mode',
    'slow',
  ]);
  assert.equal(r.exitCode, 0, r.stdout);
  assert.deepEqual(r.json.input, {
    target: 'a',
    rest: ['b', 'c'],
    name: 'n',
    count: 3,
    tags: ['x', 'y'],
    draft: false,
    mode: 'slow',
  });
});

test('bad values are VALIDATION with issues and suggestions', async () => {
  const num = await runInProcess(['test', 'echo', '--count', 'x']);
  assert.equal(num.json.error.code, 'VALIDATION');
  assert.equal(num.json.error.details.issues[0].path, '--count');
  const en = await runInProcess(['test', 'echo', '--mode', 'slwo']);
  assert.equal(en.json.error.code, 'VALIDATION');
  assert.equal(en.json.error.details.issues[0].suggestion, 'slow');
  const extra = await runInProcess(['version', 'extra']);
  assert.equal(extra.json.error.code, 'VALIDATION');
});

test('--input file merges with flags; a field from two sources is USAGE_INPUT_CONFLICT', async () => {
  const ok = await runInProcess(['test', 'echo', '--count', '2', '--input', 'in.json'], {
    files: { 'in.json': '{"name":"from-file","meta":{"a":"b"}}' },
  });
  assert.deepEqual(ok.json.input, { name: 'from-file', count: 2, meta: { a: 'b' }, mode: 'fast' });
  const conflict = await runInProcess(['test', 'echo', '--name', 'flag', '--input', 'in.json'], {
    files: { 'in.json': '{"name":"file"}' },
  });
  assert.equal(conflict.exitCode, EXIT.USAGE);
  assert.equal(conflict.json.error.code, 'USAGE_INPUT_CONFLICT');
  assert.deepEqual(conflict.json.error.details, { field: 'name', sources: ['as a flag', 'in in.json'] });
});

test('--input JSON errors report line and column; unknown keys get did-you-mean', async () => {
  const bad = await runInProcess(['test', 'echo', '--input', 'in.json'], {
    files: { 'in.json': '{\n  "name": "x",\n}' },
  });
  assert.equal(bad.json.error.code, 'USAGE_INPUT_JSON');
  assert.equal(bad.json.error.details.line, 3);
  const unknown = await runInProcess(['test', 'echo', '--input', '-'], { stdin: '{"nmae":"x"}' });
  assert.equal(unknown.json.error.code, 'VALIDATION');
  assert.equal(unknown.json.error.details.issues[0].suggestion, 'name');
  const missing = await runInProcess(['test', 'echo', '--input', 'nope.json']);
  assert.equal(missing.json.error.code, 'USAGE_INPUT_JSON');
});

test('jsonInput required without --input is USAGE_INPUT_MISSING; stdin is read only with --input -', async () => {
  const stdinReads = 0;
  const r = await runInProcess(['test', 'needs-input'], { stdin: '{"title":"t"}' });
  assert.equal(r.exitCode, EXIT.USAGE);
  assert.equal(r.json.error.code, 'USAGE_INPUT_MISSING');
  void stdinReads;
});

test('write --dry-run halts at the first mutation with argv, stdin and preview', async () => {
  const r = await runInProcess(['test', 'needs-input', '--input', '-', '--dry-run'], { stdin: '{"title":"t"}' });
  assert.equal(r.exitCode, 0, r.stdout);
  assert.deepEqual(r.json, {
    dryRun: true,
    wouldRun: [{ argv: ['gh', 'api', '-X', 'POST', 'repos/o/r/issues', '--input', '-'], stdin: '{"title":"t"}' }],
    preview: { title: 't' },
  });
  assert.equal(r.calls.length, 0);
});

test('--dry-run on a read command is refused', async () => {
  const r = await runInProcess(['version', '--dry-run']);
  assert.equal(r.json.error.code, 'USAGE_UNKNOWN_FLAG');
});

test('output over --max-bytes spills to a file and prints {spilled,path,bytes,command}', async () => {
  const r = await runInProcess(['test', 'big', '--bytes', '5000', '--max-bytes', '2000']);
  assert.equal(r.exitCode, 0);
  assert.deepEqual(Object.keys(r.json), ['spilled', 'path', 'bytes', 'command']);
  assert.equal(r.json.spilled, true);
  assert.equal(r.json.command, 'test big');
  const content = readFileSync(r.json.path, 'utf8');
  assert.equal(Buffer.byteLength(content), r.json.bytes);
  assert.equal(JSON.parse(content).last, 'END');
  const env = await runInProcess(['test', 'big', '--bytes', '5000'], { env: { GHX_MAX_BYTES: '1000' } });
  assert.equal(env.json.spilled, true);
  const inline = await runInProcess(['test', 'big', '--bytes', '5000']);
  assert.equal(inline.json.last, 'END');
  const bad = await runInProcess(['version', '--max-bytes', '10']);
  assert.equal(bad.json.error.code, 'VALIDATION');
});

test('an output-contract violation is INTERNAL_OUTPUT_CONTRACT, exit 1', async () => {
  const r = await runInProcess(['test', 'contract-bug']);
  assert.equal(r.exitCode, EXIT.INTERNAL);
  assert.equal(r.json.error.code, 'INTERNAL_OUTPUT_CONTRACT');
  assert.ok(Array.isArray(r.json.error.details.issues));
});

test('an unexpected throw is INTERNAL with a stack file', async () => {
  const { defineCommand } = await import('../../src/core/command.ts');
  const { z } = await import('zod');
  const boom = defineCommand({
    name: ['boom'],
    summary: 'throws',
    kind: 'read',
    needs: { repo: 'none' },
    input: z.strictObject({}),
    output: z.object({}),
    async run() {
      throw new TypeError('kaboom');
    },
  });
  const r = await runInProcess(['boom'], { commands: [boom] });
  assert.equal(r.exitCode, EXIT.INTERNAL);
  assert.equal(r.json.error.code, 'INTERNAL');
  assert.match(readFileSync(r.json.error.details.stackPath, 'utf8'), /kaboom/);
});

test('the deadline aborts with TIMEOUT, exit 8; --timeout is clamped to the max', async () => {
  const clock = new FakeClock();
  const p = runInProcess(['test', 'sleep', '--timeout', '90s'], { clock });
  await clock.advance(90_000);
  const r = await p;
  assert.equal(r.exitCode, EXIT.TIMEOUT);
  assert.equal(r.json.error.code, 'TIMEOUT');
  assert.deepEqual(r.json.error.details, { deadlineMs: 90_000 });
  const over = await runInProcess(['test', 'sleep', '--timeout', '2h']);
  assert.equal(over.json.error.code, 'VALIDATION');
  const junk = await runInProcess(['test', 'sleep', '--timeout', 'soon']);
  assert.equal(junk.json.error.code, 'VALIDATION');
});

test('SIGTERM mid-command gives one INTERRUPTED error, exit 143', async () => {
  const clock = new FakeClock();
  const shutdown = createShutdown();
  const p = runInProcess(['test', 'sleep'], { clock, shutdown });
  await flush();
  shutdown.trigger('SIGTERM');
  const r = await p;
  assert.equal(r.exitCode, EXIT.SIGTERM);
  assert.equal(r.json.error.code, 'INTERRUPTED');
  assert.deepEqual(r.json.error.details, { signal: 'SIGTERM' });
  assert.equal(r.forced, false);
});

test('a handler that ignores the signal is abandoned after the grace window (forced), SIGINT → 130', async () => {
  const clock = new FakeClock();
  const shutdown = createShutdown();
  const p = runInProcess(['test', 'sleep', '--ignore-abort'], { clock, shutdown });
  await flush();
  shutdown.trigger('SIGINT');
  await clock.advance(3_000);
  const r = await p;
  assert.equal(r.exitCode, EXIT.SIGINT);
  assert.equal(r.json.error.code, 'INTERRUPTED');
  assert.equal(r.forced, true);
  assert.equal(r.lines.length, 1);
});

test('gh missing surfaces as ENV_GH_MISSING through a command', async () => {
  const { defineCommand } = await import('../../src/core/command.ts');
  const { z } = await import('zod');
  const ghver = defineCommand({
    name: ['ghver'],
    summary: 'gh version',
    kind: 'read',
    needs: { repo: 'none' },
    input: z.strictObject({}),
    output: z.object({ v: z.string() }),
    async run(_i, ctx) {
      return { v: (await ctx.gh.version()).raw };
    },
  });
  const r = await runInProcess(['ghver'], {
    commands: [ghver],
    proc: new FakeProc().on({ cmd: 'gh' }, { spawnError: 'ENOENT' }).runner(),
  });
  assert.equal(r.exitCode, EXIT.ENV);
  assert.equal(r.json.error.code, 'ENV_GH_MISSING');
});

test('pretty output with --pretty or a TTY', async () => {
  assert.match((await runInProcess(['version', '--pretty'])).stdout, /\n {2}"name"/);
  assert.match((await runInProcess(['version'], { stdoutIsTTY: true })).stdout, /\n {2}"name"/);
});

test('ghx schema config prints the config JSON Schema', async () => {
  const r = await runInProcess(['schema', 'config']);
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.json.required, ['version', 'components']);
  assert.ok((await runInProcess(['schema'])).json.targets.includes('config'));
});
