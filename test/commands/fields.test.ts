// --fields / --brief through the runner (02 §1.1): checked before the command runs, applied to the
// success document only, before the byte bound; the stream summary is projected in final mode only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { z } from 'zod';
import { defineCommand } from '../../src/core/command.ts';
import { GhxError } from '../../src/core/errors.ts';
import { DryRunHalt } from '../../src/gh/index.ts';
import { runInProcess } from '../helpers/harness.ts';
import { isQ1, q1Reply } from '../unit/pr/snapshot-fixture.ts';
import { install, REF, run, SLUG } from './pr-status-world.ts';

let runs = 0;

const Doc = z.object({
  state: z.string(),
  ci: z.object({ state: z.string(), counts: z.object({ pass: z.number() }) }),
  pad: z.string(),
});

const docSpec = defineCommand({
  name: ['t', 'doc'],
  summary: 'Test only: a fixed document.',
  kind: 'read',
  needs: { repo: 'none' },
  input: z.object({ padBytes: z.number().int().default(0), fail: z.boolean().default(false) }),
  output: Doc,
  brief: ['state', 'ci.state'],
  async run(input, ctx) {
    runs++;
    if (input.fail) throw new GhxError('GH_FAILED', 'boom');
    ctx.warn({ code: 'T_WARN', message: 'kept under --fields' });
    return { state: 'OPEN', ci: { state: 'green', counts: { pass: 3 } }, pad: 'p'.repeat(input.padBytes) };
  },
});

const writeSpec = defineCommand({
  name: ['t', 'write'],
  summary: 'Test only: a write that halts under --dry-run.',
  kind: 'write',
  needs: { repo: 'none' },
  input: z.object({}),
  output: z.object({ merged: z.boolean(), number: z.number() }),
  async run(_input, ctx) {
    runs++;
    if (ctx.dryRun) throw new DryRunHalt(['pr', 'merge', '1'], undefined);
    return { merged: true, number: 1 };
  },
});

const commands = [docSpec, writeSpec];

test('--fields keeps the selected leaves, the nesting and warnings; --brief uses the preset', async () => {
  const r = await runInProcess(['t', 'doc', '--fields', 'ci.counts', '--fields', 'state'], { commands });
  assert.equal(r.exitCode, 0, r.stdout);
  assert.deepEqual(r.json, {
    state: 'OPEN',
    ci: { counts: { pass: 3 } },
    warnings: [{ code: 'T_WARN', message: 'kept under --fields' }],
  });
  const b = await runInProcess(['t', 'doc', '--brief'], { commands });
  assert.deepEqual(b.json, { state: 'OPEN', ci: { state: 'green' }, warnings: b.json.warnings });
  const u = await runInProcess(['t', 'doc', '--brief', '--fields', 'ci.counts.pass'], { commands });
  assert.deepEqual(u.json.ci, { state: 'green', counts: { pass: 3 } }, '--brief with --fields is the union');
});

test('an unknown path is VALIDATION before the command runs, naming the top-level fields', async () => {
  const before = runs;
  const r = await runInProcess(['t', 'doc', '--fields', 'stat'], { commands });
  assert.equal(r.exitCode, 2);
  assert.equal(r.json.error.code, 'VALIDATION');
  assert.match(r.json.error.hint, /did you mean 'state'.*Top-level fields: state, ci, pad, warnings/);
  const w = await runInProcess(['t', 'write', '--fields', 'mergd'], { commands });
  assert.equal(w.json.error.code, 'VALIDATION');
  assert.equal(runs, before, 'neither command ran');
  assert.deepEqual(w.calls, []);
});

test('error documents are never projected; the dry-run envelope only by its own paths', async () => {
  const e = await runInProcess(['t', 'doc', '--fail', '--fields', 'state'], { commands });
  assert.deepEqual(Object.keys(e.json), ['error']);
  assert.equal(e.json.error.code, 'GH_FAILED');
  // Asking for the error is fine: it is the whole envelope on a failure and absent on a success.
  const asked = await runInProcess(['t', 'doc', '--fail', '--fields', 'state,error.code'], { commands });
  assert.equal(asked.exitCode, 7, asked.stdout);
  assert.deepEqual(Object.keys(asked.json.error), ['code', 'message', 'hint', 'details']);
  const ok = await runInProcess(['t', 'doc', '--fields', 'state,error'], { commands });
  assert.deepEqual(ok.json, { state: 'OPEN', warnings: ok.json.warnings });
  const d = await runInProcess(['t', 'write', '--dry-run', '--fields', 'merged'], { commands });
  assert.equal(d.exitCode, 0, d.stdout);
  assert.equal(d.json.dryRun, true);
  assert.deepEqual(d.json.wouldRun, [{ argv: ['pr', 'merge', '1'] }]);
  const w = await runInProcess(['t', 'write', '--fields', 'merged'], { commands });
  assert.deepEqual(w.json, { merged: true });
  // preview.* and wouldRun name the envelope: accepted under --dry-run, and they project it.
  const own = await runInProcess(['t', 'write', '--dry-run', '--fields', 'wouldRun.argv,preview.title'], { commands });
  assert.equal(own.exitCode, 0, own.stdout);
  assert.deepEqual(own.json, { dryRun: true, wouldRun: [{ argv: ['pr', 'merge', '1'] }], preview: null });
  const real = await runInProcess(['t', 'write', '--fields', 'preview.title'], { commands });
  assert.equal(real.json.error.code, 'VALIDATION', 'preview is a dry-run path only');
});

test('--brief on a command without a preset prints the whole output with BRIEF_NO_PRESET', async () => {
  const r = await runInProcess(['t', 'write', '--brief'], { commands });
  assert.equal(r.exitCode, 0, r.stdout);
  assert.deepEqual(r.json.merged, true);
  assert.deepEqual(r.json.number, 1);
  assert.deepEqual(
    r.json.warnings.map((w: { code: string }) => w.code),
    ['BRIEF_NO_PRESET'],
  );
  assert.match(r.json.warnings[0].message, /pick fields with --fields/i);
  const d = await runInProcess(['t', 'write', '--brief', '--dry-run'], { commands });
  assert.equal(d.json.dryRun, true);
  assert.equal(d.json.warnings[0].code, 'BRIEF_NO_PRESET', 'the dry-run envelope carries it too');
  const f = await runInProcess(['t', 'write', '--brief', '--fields', 'number'], { commands });
  assert.deepEqual(f.json, { number: 1, warnings: f.json.warnings });
});

test('the projection runs before the byte bound: a trimmed document fits, a large one spills projected', async () => {
  const fits = await runInProcess(['t', 'doc', '--pad-bytes', '20000', '--fields', 'state'], { commands });
  assert.deepEqual(fits.json, { state: 'OPEN', warnings: fits.json.warnings });
  const spilled = await runInProcess(['t', 'doc', '--pad-bytes', '20000', '--fields', 'pad'], { commands });
  assert.equal(spilled.json.spilled, true);
  const full = JSON.parse(readFileSync(spilled.json.path, 'utf8'));
  assert.deepEqual(Object.keys(full), ['pad', 'warnings']);
});

test('a final-mode stream projects its summary on stdout; the events file keeps the full summary', async () => {
  const r = await runInProcess(['test', 'tick', '--count', '1', '--interval-ms', '0', '--fields', 'ticks,eventsPath']);
  assert.equal(r.exitCode, 0, r.stdout);
  assert.deepEqual(Object.keys(r.json), ['ticks', 'eventsPath']);
  const last = readFileSync(r.json.eventsPath, 'utf8').trim().split('\n').at(-1) ?? '';
  assert.equal(JSON.parse(last).outcome, 'ok', 'the events file is never projected');
});

test('--fields with an NDJSON stream (--stream) is VALIDATION', async () => {
  const r = await runInProcess(['test', 'tick', '--count', '1', '--interval-ms', '0', '--stream', '--fields', 'ticks']);
  assert.equal(r.exitCode, 2);
  assert.equal(r.json.error.code, 'VALIDATION');
  assert.match(r.json.error.message, /do not apply to ghx test tick --stream/);
  const bad = await runInProcess(['test', 'tick', '--fields', 'tiks']);
  assert.match(bad.json.error.hint, /did you mean 'ticks'/);
});

test('--help and --schema show the brief preset; the global --brief line names the commands with one', async () => {
  const h = await runInProcess(['t', 'doc', '--help'], { commands });
  assert.deepEqual(h.json.brief, ['state', 'ci.state']);
  const none = await runInProcess(['t', 'write', '--help'], { commands });
  assert.equal(none.json.brief, null);
  const s = await runInProcess(['t', 'doc', '--schema'], { commands });
  assert.deepEqual(s.json.brief, ['state', 'ci.state']);
  const g = await runInProcess(['--help'], { commands });
  const flags = g.json.globalFlags as string[];
  assert.ok(flags.some((f) => f.startsWith('--fields <string>')));
  assert.ok(flags.some((f) => f.startsWith('--brief') && f.includes('t doc') && !f.includes('t write')));
});

test('pr status A B --brief: each entry keeps ref and the preset; a failed entry stays whole', async () => {
  const fake = install();
  fake.on((argv) => isQ1(argv) && argv.includes('number=3302'), q1Reply(null));
  const r = await run(['pr', 'status', REF, `${SLUG}#3302`, '--brief'], fake);
  const [ok, failed] = r.json.results;
  assert.equal(ok.ref, REF);
  assert.equal(typeof ok.merge.ready, 'boolean');
  assert.equal(typeof ok.ci.counts.pass, 'number');
  assert.equal(ok.title, undefined, 'outside the preset');
  assert.equal(ok.feedback.reviews, undefined);
  assert.deepEqual(Object.keys(failed), ['selector', 'ref', 'error']);
  assert.equal(failed.error.code, 'PR_NOT_FOUND');
});
