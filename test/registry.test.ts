// Generic per-spec invariants (01 §3.8) and registry completeness. Every command added under
// src/commands/ is covered automatically.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { deriveInterface, RESERVED_NAMES } from '../src/cli/args.ts';
import { fsRegistry, isCommandSegment, MAX_NAME_DEPTH, scanCommandFiles } from '../src/cli/registry.ts';
import { commandSchema } from '../src/cli/schema.ts';
import type { AnyCommandSpec } from '../src/core/command.ts';
import { isMutating } from '../src/gh/guard.ts';
import { FakeProc } from './helpers/fake-proc.ts';
import { runInProcess, SRC_COMMANDS, TEST_COMMANDS } from './helpers/harness.ts';

const RESERVED_EVENT_TYPES = new Set(['summary', 'error', 'heartbeat', 'warning']);

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
    const example = spec.examples?.[0];
    assert.ok(example, 'every command has at least one example');
    const argv = example.argv.split(/\s+/).slice(1);
    if (example.input !== undefined && !argv.includes('--input')) argv.push('--input', '-');
    if (spec.kind === 'write') argv.push('--dry-run');
    const hostile = new FakeProc().on(() => true, { exitCode: 1, stderr: 'gh: Not Found (HTTP 404)' });
    const r = await runInProcess(argv, {
      proc: hostile.runner(),
      ...(example.input !== undefined ? { stdin: JSON.stringify(example.input) } : {}),
    });
    assert.notEqual(r.exitCode, 1, r.stdout);
    const ghCalls = r.calls.filter((c) => c.cmd === 'gh' || c.cmd.endsWith('/gh'));
    assert.deepEqual(
      ghCalls.filter((c) => isMutating(c.args)).map((c) => c.args.join(' ')),
      [],
    );
  });
}
