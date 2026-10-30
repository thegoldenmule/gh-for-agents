// --fields and --brief on a passthrough read (02 §1.1, §10): ghx flags, never forwarded to gh. --fields
// projects the envelope (paths under passthrough.json are gh's output, so unchecked); --brief has no preset.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT } from '../contract/exit-table.ts';
import { FakeGh } from '../helpers/fake-gh.ts';
import { runInProcess } from '../helpers/harness.ts';

const runs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    headSha: `${String(i).padStart(2, '0')}${'a'.repeat(38)}`,
    status: 'completed',
    displayTitle: `commit ${i} ${'x'.repeat(200)}`,
  }));

function fake(n = 4): FakeGh {
  return new FakeGh().on((a) => a[0] === 'run' && a[1] === 'list', {
    exitCode: 0,
    stdout: JSON.stringify(runs(n)),
    stderr: '',
  });
}

const ARGV = ['run', 'list', '--branch', 'main', '--limit', '4', '--json', 'headSha,status', '-R', 'o/r'];

test('--fields projects the envelope and is not forwarded to gh (the reported GH_FAILED "unknown flag")', async () => {
  const gh = fake();
  const r = await runInProcess([...ARGV, '--fields', 'passthrough.json[].headSha'], { gh });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(r.json, { passthrough: { json: runs(4).map((x) => ({ headSha: x.headSha })) } });
  assert.equal(gh.calls.length, 1);
  const argv = gh.calls[0]?.argv ?? [];
  assert.ok(!argv.some((a) => a.startsWith('--fields') || a.includes('passthrough.json')), argv.join(' '));
  assert.deepEqual(argv.slice(0, 8), ARGV.slice(0, 8));
});

test('--fields=…, repeated, and envelope keys together', async () => {
  const r = await runInProcess([...ARGV, '--fields=passthrough.exitCode', '--fields', 'passthrough.json[].status'], {
    gh: fake(),
  });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(r.json.passthrough.exitCode, 0);
  assert.deepEqual(r.json.passthrough.json[0], { status: 'completed' });
  assert.equal(r.json.passthrough.argv, undefined);
});

test('output past the inline cap stays JSON under --fields, so the projection still applies', async () => {
  const r = await runInProcess([...ARGV, '--fields', 'passthrough.json[].headSha'], { gh: fake(200) });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.passthrough.json.length, 200);
  assert.equal(r.json.passthrough.stdoutPath, undefined);
  assert.deepEqual(Object.keys(r.json.passthrough.json[0]), ['headSha']);
});

test('a path outside the envelope is VALIDATION before gh runs, and the hint explains passthrough fields', async () => {
  const gh = fake();
  const r = await runInProcess([...ARGV, '--fields', 'headSha'], { gh });
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  assert.equal(r.json.error.code, 'VALIDATION');
  assert.match(r.json.error.hint, /Top-level fields: passthrough, warnings\. Passthrough has no --schema/);
  assert.match(r.json.error.hint, /--fields passthrough\.json\.headSha.*--json <fields> and --jq/);
  assert.deepEqual(gh.calls, []);
});

test('--brief on a passthrough (no preset) prints the envelope whole with BRIEF_NO_PRESET; gh never sees it', async () => {
  const gh = fake();
  const r = await runInProcess([...ARGV, '--brief'], { gh });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.passthrough.json.length, 4);
  assert.equal(r.json.warnings[0].code, 'BRIEF_NO_PRESET');
  assert.match(r.json.warnings[0].message, /Pick fields with --fields\. Passthrough has no --schema/);
  assert.ok(!(gh.calls[0]?.argv ?? []).includes('--brief'));
});

test('ghx api takes --fields too', async () => {
  const gh = new FakeGh().on((a) => a[0] === 'api', {
    exitCode: 0,
    stdout: '[{"number":1,"title":"a"},{"number":2,"title":"b"}]',
    stderr: '',
  });
  const r = await runInProcess(['api', 'repos/o/r/pulls', '--fields', 'passthrough.json[].number'], { gh });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(r.json.passthrough.json, [{ number: 1 }, { number: 2 }]);
  assert.ok(!(gh.calls[0]?.argv ?? []).includes('--fields'));
});
