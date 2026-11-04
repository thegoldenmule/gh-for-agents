// CONFIG_DRIFT joins a command's own warnings, never replaces them (review of PR #1, finding 1): the
// context warnings (ctx.warn) and the warnings a command returns are both in the output.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FakeClock } from '../helpers/fake-clock.ts';
import { FakeGh } from '../helpers/fake-gh.ts';
import { gitCheckout } from '../helpers/fake-git.ts';
import { scratchDir } from '../helpers/harness.ts';
import { isMergeable, mergeableReply } from '../unit/pr/snapshot-fixture.ts';
import { CONFIG, install, NOW, REF, run, SLUG, workedPr } from './pr-status-world.ts';

const HEAD = 'fb84c4ee691c913bddf916389e62f8e18c4713a3';
const FORK = '9475673000000000000000000000000000000bb0';

/** The cwd is a stale checkout of the PR's repo whose ghx.json main has changed since it forked. */
function staleCheckout() {
  const dir = mkdtempSync(join(scratchDir(), 'drift-'));
  mkdirSync(join(dir, '.github'));
  const file = join(dir, '.github', 'ghx.json');
  writeFileSync(file, JSON.stringify(CONFIG));
  return gitCheckout(SLUG, {
    toplevel: dir,
    refs: { HEAD },
    files: { [file]: 'b'.repeat(40) },
    objects: {
      'HEAD:.github/ghx.json': 'b'.repeat(40),
      'origin/main': 'e'.repeat(40),
      'origin/main:.github/ghx.json': 'c'.repeat(40),
      [`${FORK}:.github/ghx.json`]: 'b'.repeat(40),
    },
    mergeBases: { 'HEAD...origin/main': FORK },
    remoteHeads: { origin: 'origin/main' },
    counts: { 'HEAD...origin/main': { ahead: 0, behind: 39 } },
  });
}

test('pr status: CONFIG_DRIFT and MERGEABLE_UNKNOWN are both reported', async () => {
  const clock = new FakeClock(NOW);
  const fake = install(new FakeGh({ clock }), { pr: workedPr({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }) });
  fake.on(isMergeable, mergeableReply('UNKNOWN'));
  let done = false;
  const p = run(['pr', 'status', REF, '--no-compare-main'], fake, { clock, git: staleCheckout() }).finally(() => {
    done = true;
  });
  await clock.runUntil(() => done, { stepMs: 500, maxMs: 60_000 });
  const r = await p;
  const codes = (r.json.warnings as { code: string }[]).map((w) => w.code);
  assert.ok(codes.includes('CONFIG_DRIFT'), JSON.stringify(codes));
  assert.ok(codes.includes('MERGEABLE_UNKNOWN'), JSON.stringify(codes));
  assert.equal(codes.indexOf('CONFIG_DRIFT'), 0, 'context warnings first, then the command’s');
  assert.equal(new Set(codes).size, codes.length, 'each warning once');
  assert.equal(
    r.json.merge.blockers.find((b: { code: string }) => b.code === 'MERGEABLE_UNKNOWN')?.code,
    'MERGEABLE_UNKNOWN',
  );
});
