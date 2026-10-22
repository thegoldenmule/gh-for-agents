import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as common from '../../../src/schemas/common.ts';
import {
  Author,
  Body,
  CommentId,
  FeedbackId,
  FindingId,
  Gen,
  Id,
  Iso,
  OneLine,
  PrBlockId,
  PrRef,
  RepoPath,
  ReviewId,
  Sha,
  ShaInput,
  SyntheticId,
  Warning,
} from '../../../src/schemas/common.ts';
import { assertExportable } from './_exportable.ts';

const ok = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) =>
  assert.ok(s.safeParse(v).success, `expected pass: ${JSON.stringify(v)}`);
const bad = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) =>
  assert.ok(!s.safeParse(v).success, `expected fail: ${JSON.stringify(v)}`);

test('every exported schema exports to JSON Schema (no transforms)', () => {
  const n = assertExportable(common, { OneLine: () => OneLine(200), Body: () => Body(500, 3) });
  assert.ok(n >= 15);
});

test('PrRef (03 §5.1)', () => {
  for (const v of ['#1', 'o/r#12', 'o.x/r-y#3', 'powerhouse-inc/powerhouse#3301']) ok(PrRef, v);
  for (const v of ['#', 'o/r#', '#0', '3198', 'pr-3198', 'o/r#01', 'o#1', 'o/r/x#1', '#1 ']) bad(PrRef, v);
});

test('ShaInput: 7..40 lowercase hex; uppercase fails with a lowercase hint', () => {
  ok(ShaInput, 'abcdef0');
  ok(ShaInput, 'a'.repeat(40));
  bad(ShaInput, 'abcdef');
  bad(ShaInput, 'a'.repeat(41));
  const r = ShaInput.safeParse('ABCDEF0');
  assert.ok(!r.success);
  assert.match(r.error.issues[0]?.message ?? '', /lowercase/);
});

test('Sha: exactly 40 lowercase hex', () => {
  ok(Sha, '9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d');
  bad(Sha, '9f2c4e1');
  bad(Sha, '9F2C4E1A7B3D5F60812C9E4B7A1D3F5E6C8B0A2D');
});

test('ids: prefix plus 6 Crockford chars (02 §1.4)', () => {
  ok(Id, 'p_k3m9qa');
  for (const v of ['p_k3m9qi', 'p_k3m9ql', 'p_k3m9qo', 'p_k3m9qu', 'x_abcdef', 'p_abcde', 'p_abcdefg', 'P_k3m9qa']) {
    bad(Id, v);
  }
  ok(PrBlockId, 'p_k3m9qa');
  bad(PrBlockId, 'r_7tq2wd');
  ok(ReviewId, 'r_7tq2wd');
  ok(FindingId, 'f_h4x8pz');
  ok(CommentId, 'c_w5j1ve');
  bad(CommentId, 'f_h4x8pz');
});

test('synthetic and feedback ids', () => {
  for (const v of ['ic:2412345678', 'rc:1', 'rv:99']) ok(SyntheticId, v);
  for (const v of ['ic:', 'xx:1', 'ic:abc']) bad(SyntheticId, v);
  for (const v of ['ic:2412345678', 'f_h4x8pz']) ok(FeedbackId, v);
  for (const v of ['ic:x', 'f_h4x8pi']) bad(FeedbackId, v);
});

test('OneLine(200): 200 chars pass; 201 chars and an embedded \\r or \\n fail', () => {
  const s = OneLine(200);
  ok(s, 'x'.repeat(200));
  bad(s, 'x'.repeat(201));
  bad(s, 'a\rb');
  bad(s, 'a\nb');
  bad(s, '   ');
  assert.equal(s.parse('  a b  '), 'a b');
});

test('RepoPath: repo-relative, no ..', () => {
  ok(RepoPath, 'packages/reactor/src/a.ts');
  ok(RepoPath, 'a..b/c');
  for (const v of ['', '/abs', 'a/../b', '..', 'x'.repeat(401)]) bad(RepoPath, v);
});

test('Body: chars, lines and no ghx marker', () => {
  const b = Body(1500, 15);
  ok(b, 'x'.repeat(1500));
  ok(b, Array(15).fill('l').join('\n'));
  bad(b, 'x'.repeat(1501));
  bad(b, Array(16).fill('l').join('\n'));
  bad(b, 'hi <!-- ghx:v1 {} -->');
  bad(b, ' ');
});

test('Iso accepts Z and offsets, rejects dates without time', () => {
  ok(Iso, '2026-10-21T16:55:29Z');
  ok(Iso, '2026-10-21T16:55:29.021Z');
  ok(Iso, '2026-10-21T18:55:29+02:00');
  bad(Iso, '2026-10-21');
  bad(Iso, 'yesterday');
});

test('Gen, Author and Warning', () => {
  ok(Gen, 'ghx/0.1.0');
  ok(Gen, 'ghx/1.2.3-rc.1');
  bad(Gen, 'ghx/1.2');
  ok(Author, { login: 'thegoldenmule', isViewer: true, isBot: false, association: 'OWNER' });
  bad(Author, { login: 'x', isViewer: false, isBot: false, association: 'STRANGER' });
  ok(Warning, { code: 'X', message: 'y' });
});
