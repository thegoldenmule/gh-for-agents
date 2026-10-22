// R15, the passthrough half (03 §5.2; research §3.1, §9.10): `gh pr diff` fails past 300 files with
// HTTP 406. `ghx pr diff` gets gh's verbatim stderr (the `passthrough` scenario) and returns
// DIFF_TOO_LARGE (exit 7) with a local git diff hint instead of a bare GH_FAILED.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT } from '../contract/exit-table.ts';
import { FakeGh } from '../helpers/fake-gh.ts';
import { runInProcess } from '../helpers/harness.ts';

test('R15 (passthrough): pr diff past 300 files → DIFF_TOO_LARGE (7) with a local git diff hint', async () => {
  const fake = FakeGh.fromScenario('passthrough');
  const r = await runInProcess(['pr', 'diff', '3169', '-R', 'powerhouse-inc/powerhouse'], { gh: fake });
  assert.equal(r.exitCode, EXIT.GH_FAILED, r.stdout);
  const e = r.json.error;
  assert.equal(e.code, 'DIFF_TOO_LARGE');
  assert.match(e.hint, /git diff/);
  assert.equal(e.details.status, 406);
  assert.match(e.details.passthrough.stderr, /exceeded the maximum number of files \(300\)/);
  assert.equal(fake.calls.length, 1, 'a 406 is not retried');
  fake.expectNoMutations();
});
