import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foldEvents, type ResolveEvent, type TargetKind } from '../../../src/feedback/events.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const targets = new Map<string, TargetKind>([
  ['f_aaaaaa', 'finding'],
  ['c_pppppp', 'precondition'],
]);
let db = 1;
const ev = (at: string, t: ResolveEvent['targets'], o: { databaseId?: number; id?: string } = {}): ResolveEvent => ({
  id: o.id ?? `c_e${String(db).padStart(5, '0')}`,
  by: 'viewer-user',
  at,
  databaseId: o.databaseId ?? db++,
  url: `https://github.com/o/r/pull/1#issuecomment-${db}`,
  targets: t,
});

test('with no events a finding is open (absent from the map) and a precondition has no override', () => {
  const r = foldEvents([], targets);
  assert.equal(r.findings.size, 0);
  assert.equal(r.preconditions.size, 0);
});

test('the last valid event wins, ordered by createdAt then databaseId, not by input order', () => {
  const events = [
    ev('2026-10-20T12:00:00Z', [{ id: 'f_aaaaaa', status: 'open' }], { id: 'c_late00', databaseId: 5 }),
    ev('2026-10-20T11:00:00Z', [{ id: 'f_aaaaaa', status: 'wontfix', note: 'by design' }], { id: 'c_early0' }),
    ev('2026-10-20T12:00:00Z', [{ id: 'f_aaaaaa', status: 'deferred', note: 'later' }], {
      id: 'c_tie000',
      databaseId: 9,
    }),
  ];
  const r = foldEvents(events, targets);
  assert.deepEqual(
    [r.findings.get('f_aaaaaa')?.status, r.findings.get('f_aaaaaa')?.event?.id],
    ['deferred', 'c_tie000'],
  );
  assert.equal(r.findings.get('f_aaaaaa')?.event?.note, 'later');
});

test('invalid events are skipped with EVENT_INVALID, and the previous valid event still wins', () => {
  const events = [
    ev('2026-10-20T10:00:00Z', [{ id: 'f_aaaaaa', status: 'deferred', note: 'next sprint' }]),
    ev('2026-10-20T11:00:00Z', [{ id: 'f_aaaaaa', status: 'wontfix' }]),
    ev('2026-10-20T11:01:00Z', [{ id: 'f_aaaaaa', status: 'addressed' }]),
    ev('2026-10-20T11:02:00Z', [{ id: 'f_aaaaaa', status: 'met', note: 'x' }]),
    ev('2026-10-20T11:03:00Z', [{ id: 'c_pppppp', status: 'addressed', commit: A }]),
    ev('2026-10-20T11:04:00Z', [{ id: 'f_aaaaaa', status: 'fixed' }]),
  ];
  const r = foldEvents(events, targets);
  assert.equal(r.findings.get('f_aaaaaa')?.status, 'deferred');
  assert.equal(r.preconditions.size, 0);
  assert.deepEqual(
    r.warnings.map((w) => w.code),
    ['EVENT_INVALID', 'EVENT_INVALID', 'EVENT_INVALID', 'EVENT_INVALID'],
  );
  assert.match(r.warnings[0]?.message ?? '', /wontfix needs a note/);
});

test('an event for an unknown id warns EVENT_TARGET_UNKNOWN', () => {
  const r = foldEvents([ev('2026-10-20T10:00:00Z', [{ id: 'f_zzzzzz', status: 'open' }])], targets);
  assert.equal(r.warnings[0]?.code, 'EVENT_TARGET_UNKNOWN');
});

test('addressed: a verified commit sets verified:true; an unchecked one is reported as needed', () => {
  const events = [ev('2026-10-20T10:00:00Z', [{ id: 'f_aaaaaa', status: 'addressed', commit: A }])];
  const ok = foldEvents(events, targets, new Map([[A, true]]));
  assert.deepEqual(
    [ok.findings.get('f_aaaaaa')?.status, ok.findings.get('f_aaaaaa')?.event?.verified, ok.unverifiedCommits],
    ['addressed', true, []],
  );
  const unchecked = foldEvents(events, targets);
  assert.deepEqual(unchecked.unverifiedCommits, [A]);
  assert.equal(unchecked.findings.get('f_aaaaaa')?.event?.verified, null);
  assert.equal(unchecked.warnings[0]?.code, 'EVENT_COMMIT_UNVERIFIED');
});

test('an addressed commit that left the PR reverts to open with verified:false and EVENT_COMMIT_UNREACHABLE', () => {
  const events = [
    ev('2026-10-20T10:00:00Z', [{ id: 'f_aaaaaa', status: 'addressed', commit: B }]),
    ev('2026-10-20T11:00:00Z', [{ id: 'f_aaaaaa', status: 'addressed', commit: A }], { id: 'c_force0' }),
  ];
  const r = foldEvents(events, targets, new Map([[A, false]]));
  const f = r.findings.get('f_aaaaaa');
  assert.deepEqual([f?.status, f?.event?.id, f?.event?.verified, f?.event?.commit], ['open', 'c_force0', false, A]);
  assert.deepEqual(
    r.warnings.map((w) => w.code),
    ['EVENT_COMMIT_UNREACHABLE'],
  );
  assert.deepEqual(r.unverifiedCommits, [], 'only the winning event is verified');
});

test('a precondition override takes met, withdrawn or unmet, and the last one wins', () => {
  const events = [
    ev('2026-10-20T10:00:00Z', [{ id: 'c_pppppp', status: 'met', note: 'released' }]),
    ev('2026-10-20T11:00:00Z', [{ id: 'c_pppppp', status: 'unmet' }], { id: 'c_unmet0' }),
  ];
  const r = foldEvents(events, targets);
  assert.deepEqual(
    [r.preconditions.get('c_pppppp')?.status, r.preconditions.get('c_pppppp')?.event.id],
    ['unmet', 'c_unmet0'],
  );
});

test('one event can target several items', () => {
  const r = foldEvents(
    [
      ev('2026-10-20T10:00:00Z', [
        { id: 'f_aaaaaa', status: 'wontfix', note: 'by design' },
        { id: 'c_pppppp', status: 'withdrawn', note: 'not needed' },
      ]),
    ],
    targets,
  );
  assert.equal(r.findings.get('f_aaaaaa')?.status, 'wontfix');
  assert.equal(r.preconditions.get('c_pppppp')?.status, 'withdrawn');
});
