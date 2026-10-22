// ghx pr merge: verification after the PUT (02 §8.1 step 8; 03 M8.2). GET pulls/N is polled until it reads
// merged at the pinned head, at most 10 s on the injected clock; a merge that never reads back is
// READBACK_MISMATCH (exit 7), never a success.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT } from '../contract/exit-table.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { FakeGh } from '../helpers/fake-gh.ts';
import {
  HEAD,
  installMerge,
  isPullGet,
  MOVED_HEAD,
  NOW,
  okJson,
  openPull,
  pullJson,
  REF,
  runMerge,
} from './pr-merge-world.ts';

const gets = (fake: ReturnType<typeof installMerge>) => fake.calls.filter((c) => isPullGet(c.argv));

test('a 200 PUT is verified with one GET when the PR already reads merged', async () => {
  const fake = installMerge();
  const r = await runMerge(['pr', 'merge', REF], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual([r.json.merged, r.json.alreadyMerged, r.json.recoveredFromTransient], [true, false, false]);
  assert.equal(r.json.headSha, HEAD);
  assert.equal(gets(fake).length, 1);
});

test('the verify poll waits for GitHub to report merged (1 s steps)', async () => {
  const clock = new FakeClock(NOW);
  const fake = installMerge(new FakeGh({ clock }));
  fake.on(isPullGet, [okJson(openPull('clean')), okJson(openPull('clean')), okJson(pullJson())]);
  const r = await runMerge(['pr', 'merge', REF], fake, clock);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  const at = gets(fake).map((c) => c.at);
  assert.equal(at.length, 3);
  assert.deepEqual(
    at.slice(1).map((t, i) => t - (at[i] as number)),
    [1000, 1000],
  );
});

test('a PR that never reads back merged is READBACK_MISMATCH after at most 10 s', async () => {
  const clock = new FakeClock(NOW);
  const fake = installMerge(new FakeGh({ clock }));
  fake.on(isPullGet, okJson(openPull('clean')));
  const r = await runMerge(['pr', 'merge', REF], fake, clock);
  assert.equal(r.exitCode, EXIT.GH_FAILED, r.stdout);
  assert.equal(r.json.error.code, 'READBACK_MISMATCH');
  assert.equal(r.json.error.details.field, 'merged');
  const at = gets(fake).map((c) => c.at);
  assert.ok((at.at(-1) as number) - (at[0] as number) <= 10_000, `polled for ${at}`);
  assert.ok(at.length >= 10);
});

test('merged at another head reads back as READBACK_MISMATCH, not success', async () => {
  const fake = installMerge();
  fake.on(isPullGet, okJson(pullJson({ head: { ref: 'fix/reactor-bind-document-id', sha: MOVED_HEAD } })));
  const r = await runMerge(['pr', 'merge', REF], fake);
  assert.equal(r.exitCode, EXIT.GH_FAILED, r.stdout);
  assert.equal(r.json.error.code, 'READBACK_MISMATCH');
  assert.equal(r.json.error.details.field, 'head');
});
