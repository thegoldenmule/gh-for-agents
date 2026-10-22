// Generic per-spec invariants (01 §3.8) and registry completeness. Every command added under
// src/commands/ is covered automatically.
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { deriveInterface, RESERVED_NAMES } from '../src/cli/args.ts';
import { fsRegistry, isCommandSegment, MAX_NAME_DEPTH, scanCommandFiles } from '../src/cli/registry.ts';
import { commandSchema } from '../src/cli/schema.ts';
import { type AnyCommandSpec, defineCommand } from '../src/core/command.ts';
import { isMutating } from '../src/gh/guard.ts';
import { FakeGh } from './helpers/fake-gh.ts';
import { FakeProc } from './helpers/fake-proc.ts';
import { GH_FIXTURE_ROOT } from './helpers/fixture-match.ts';
import { type HarnessResult, runInProcess, SRC_COMMANDS, TEST_COMMANDS } from './helpers/harness.ts';

const RESERVED_EVENT_TYPES = new Set(['summary', 'error', 'heartbeat', 'warning']);

/**
 * Write commands that change only local files, never GitHub, so their --dry-run is their own document
 * rather than the {dryRun: true} halt. They must make no gh call at all in the smoke run. Their own
 * tests cover the dry run (init: test/commands/init.test.ts).
 */
const LOCAL_WRITES = new Set(['init']);

function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? allFiles(join(dir, d.name)) : [join(dir, d.name)],
  );
}

for (const [label, root] of [
  ['src/commands', SRC_COMMANDS],
  ['test/helpers/commands', TEST_COMMANDS],
] as const) {
  test(`${label}: every non-helper file is a command, and the registry lists exactly those`, async () => {
    const files = allFiles(root)
      .map((f) => relative(root, f))
      .filter((f) => !f.split('/').some((seg) => seg.startsWith('_') || seg.startsWith('.')));
    for (const f of files) {
      assert.ok(f.endsWith('.ts'), `${label}/${f}: only .ts command files (helpers start with _)`);
      const segs = f.slice(0, -3).split('/');
      assert.ok(segs.every(isCommandSegment), `${label}/${f}: segments must match [a-z][a-z0-9-]*`);
      assert.ok(segs.length <= MAX_NAME_DEPTH, `${label}/${f}: at most ${MAX_NAME_DEPTH} name segments`);
    }
    const scanned = scanCommandFiles(root).map((c) => c.name.join(' '));
    const listed = (await fsRegistry([root]).list()).map((s) => s.name.join(' '));
    assert.deepEqual(listed, scanned);
    assert.equal(listed.length, files.length);
    const stems = new Set(scanned.map((n) => n.split(' ')[0]));
    for (const d of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      assert.ok(
        !scanned.includes(d.name),
        `${label}: '${d.name}.ts' and '${d.name}/' would make '${d.name}' a prefix of other commands`,
      );
      void stems;
    }
  });
}

const specs: { spec: AnyCommandSpec; smoke: boolean }[] = [
  ...(await fsRegistry([SRC_COMMANDS]).list()).map((spec) => ({ spec, smoke: true })),
  ...(await fsRegistry([TEST_COMMANDS]).list()).map((spec) => ({ spec, smoke: false })),
];

test('command names are unique', () => {
  const names = specs.map((s) => s.spec.name.join(' '));
  assert.equal(new Set(names).size, names.length);
});

for (const { spec, smoke } of specs) {
  const name = spec.name.join(' ');
  test(`${name}: summary, schemas, flags and positionals`, () => {
    assert.ok(spec.summary.length > 0 && spec.summary.length <= 100, 'summary must be 1..100 chars');
    assert.ok(spec.kind === 'read' || spec.kind === 'write');
    // z.toJSONSchema throws on transforms at the boundary.
    const s = commandSchema(spec);
    assert.ok(s.input);
    for (const schema of spec.mode === 'single' ? [spec.output] : [spec.event, spec.summarySchema]) {
      z.toJSONSchema(schema, { io: 'output' });
    }
    z.toJSONSchema(spec.input, { io: 'input' });
    const d = deriveInterface(spec);
    for (const f of d.flags) assert.ok(!RESERVED_NAMES.has(f.flag.slice(2)), `${f.flag} collides with a global flag`);
    const fields = Object.keys(spec.input.shape);
    for (const p of spec.positionals ?? []) assert.ok(fields.includes(p), `positional ${p} is not an input field`);
    for (const [i, p] of d.positionals.entries()) {
      assert.ok(!p.variadic || i === d.positionals.length - 1, `variadic ${p.field} must be last`);
    }
    if (spec.mode === 'stream') {
      const js = z.toJSONSchema(spec.event, { io: 'output' }) as { anyOf?: unknown[]; oneOf?: unknown[] };
      const variants = (js.anyOf ?? js.oneOf ?? [js]) as { properties?: { type?: { const?: string } } }[];
      for (const v of variants) {
        const t = v.properties?.type?.const;
        assert.ok(t !== undefined, 'every event variant has a literal type');
        assert.ok(!RESERVED_EVENT_TYPES.has(t), `event type '${t}' is reserved`);
      }
    }
  });

  if (!smoke) continue;
  test(`${name}: examples[0] against a hostile gh never exits 1${spec.kind === 'read' ? ' or mutates' : ' and --dry-run halts before mutating'}`, async () => {
    assertSmoke(spec, await smokeRun(spec));
  });
}

/**
 * Run a spec's examples[0] against a hostile gh. A command may ship test/fixtures/gh/smoke/<name-with-dashes>/
 * for its smoke run; otherwise every gh (and git) call fails with a 404, which a command must survive
 * without exiting 1. Writes run with --dry-run.
 */
async function smokeRun(spec: AnyCommandSpec, extra: AnyCommandSpec[] = []): Promise<HarnessResult> {
  const example = spec.examples?.[0];
  assert.ok(example, 'every command has at least one example');
  const argv = example.argv.split(/\s+/).slice(1);
  if (example.input !== undefined && !argv.includes('--input')) argv.push('--input', '-');
  if (spec.kind === 'write') argv.push('--dry-run');
  const smokeDir = join(GH_FIXTURE_ROOT, 'smoke', spec.name.join('-'));
  const hostile = new FakeProc().on(() => true, { exitCode: 1, stderr: 'gh: Not Found (HTTP 404)' });
  return runInProcess(argv, {
    ...(existsSync(smokeDir)
      ? { gh: FakeGh.fromScenario(smokeDir), proc: hostile.runner() }
      : { proc: hostile.runner() }),
    ...(example.input !== undefined ? { stdin: JSON.stringify(example.input) } : {}),
    ...(extra.length > 0 ? { commands: extra } : {}),
  });
}

/** Never exit 1, never spawn a mutating gh call; a write's --dry-run must reach the halt (dryRun: true). */
function assertSmoke(spec: AnyCommandSpec, r: HarnessResult): void {
  assert.notEqual(r.exitCode, 1, r.stdout);
  const ghCalls = r.calls.filter((c) => c.cmd === 'gh' || c.cmd.endsWith('/gh'));
  assert.deepEqual(
    ghCalls.filter((c) => isMutating(c.args)).map((c) => c.args.join(' ')),
    [],
  );
  if (spec.kind === 'write' && LOCAL_WRITES.has(spec.name.join(' '))) {
    assert.deepEqual(ghCalls, [], 'a local-only write makes no gh call');
  } else if (spec.kind === 'write') {
    assert.equal(
      r.json?.dryRun,
      true,
      `--dry-run must halt at the first mutating call with {dryRun: true}; ship test/fixtures/gh/smoke/${spec.name.join('-')}/ if the example needs real reads first. Got: ${r.stdout}`,
    );
    assert.equal(r.exitCode, 0);
    assert.ok(Array.isArray(r.json.wouldRun) && r.json.wouldRun.length > 0, 'wouldRun lists the halted call');
  }
}

function fakeWrite(name: string, mutate: boolean): AnyCommandSpec {
  return defineCommand({
    name: ['test', name],
    summary: 'Test only: a write command for the smoke harness.',
    kind: 'write',
    needs: { repo: 'none', config: 'none' },
    input: z.strictObject({}),
    output: z.object({ done: z.boolean() }),
    examples: [{ argv: `ghx test ${name}` }],
    async run(_input, ctx) {
      if (mutate) await ctx.gh.exec({ args: ['pr', 'merge', '1'], mutates: true });
      return { done: true };
    },
  }) as AnyCommandSpec;
}

test('smoke harness: a write whose --dry-run halts passes, with dryRun: true and the halted argv', async () => {
  const spec = fakeWrite('smoke-write-halts', true);
  const r = await smokeRun(spec, [spec]);
  assertSmoke(spec, r);
  assert.deepEqual(r.json.wouldRun[0].argv, ['gh', 'pr', 'merge', '1']);
});

test('smoke harness: a write that never reaches the halt under --dry-run fails the smoke assertion', async () => {
  const spec = fakeWrite('smoke-write-no-halt', false);
  const r = await smokeRun(spec, [spec]);
  assert.equal(r.exitCode, 0);
  assert.throws(() => assertSmoke(spec, r), /--dry-run must halt/);
});
