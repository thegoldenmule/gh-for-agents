// gateVerdict (src/ci/wait/mergeable.ts; 03 M6.6): when the merge CI gate's read is final and when the
// wait keeps polling.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gateVerdict } from '../../../../src/ci/wait/mergeable.ts';

const H = 'a'.repeat(40);

function read(o: {
  state?: string;
  head?: string;
  mergeable?: string;
  checks?: Record<string, string>;
  blockers?: string[];
  waivers?: string[];
  failing?: number;
  truncated?: boolean;
}) {
  const checks = Object.entries(o.checks ?? {}).map(([code, status]) => ({ code, status, message: '' }));
  const blockers = o.blockers ?? [];
  return {
    snapshot: {
      state: o.state ?? 'OPEN',
      ref: 'o/r#7',
      head: { sha: o.head ?? H },
      merge: { mergeable: o.mergeable ?? 'MERGEABLE' },
    },
    ci: { truncated: o.truncated ?? false, failing: Array.from({ length: o.failing ?? 0 }, () => ({})) },
    evaluation: {
      ready: blockers.length === 0,
      plan: {
        checks,
        blockers: blockers.map((code) => ({ code })),
        waivers: (o.waivers ?? []).map((code) => ({ code })),
      },
    },
  } as unknown as Parameters<typeof gateVerdict>[0];
}

test('keeps polling while mergeable is UNKNOWN', () => {
  const r = read({ mergeable: 'UNKNOWN', checks: { MERGEABLE_UNKNOWN: 'fail' }, blockers: ['MERGEABLE_UNKNOWN'] });
  assert.equal(gateVerdict(r, H), null);
});

test('keeps polling when the snapshot is for another head or the PR is no longer open', () => {
  assert.equal(gateVerdict(read({ head: 'b'.repeat(40) }), H), null);
  assert.equal(gateVerdict(read({ state: 'MERGED' }), H), null);
});

test('keeps polling while the snapshot still sees pending CI; a truncated rollup is final (red)', () => {
  const pending = { checks: { CI_PENDING: 'fail' }, blockers: ['CI_PENDING'] };
  assert.equal(gateVerdict(read(pending), H), null);
  const r = gateVerdict(read({ ...pending, truncated: true }), H);
  assert.equal(r?.outcome, 'red');
  assert.deepEqual(r?.merge.blockers, ['CI_PENDING']);
});

test('ready: green without failures, red-shared when CI_RED is waived', () => {
  assert.equal(gateVerdict(read({ checks: { CI_RED: 'pass' } }), H)?.outcome, 'green');
  const shared = gateVerdict(read({ checks: { CI_RED: 'waived' }, waivers: ['CI_RED'], failing: 1 }), H);
  assert.equal(shared?.outcome, 'red-shared');
  assert.deepEqual(shared?.merge, { mergeable: 'MERGEABLE', ready: true, blockers: [], waivers: ['CI_RED'] });
});

test('not ready: red with the blocker codes', () => {
  const r = gateVerdict(read({ checks: { BEHIND_BASE: 'fail' }, blockers: ['BEHIND_BASE'] }), H);
  assert.equal(r?.outcome, 'red');
  assert.equal(r?.merge.ready, false);
  assert.deepEqual(r?.merge.blockers, ['BEHIND_BASE']);
  assert.deepEqual(r?.next, ['ghx pr status o/r#7']);
});
