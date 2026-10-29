import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_ERA_CONFIG } from '../../scripts/eval/model/session.ts';
import { cacheKey, loadCorpus } from '../../scripts/eval/pipeline.ts';

const M0 = join(import.meta.dirname, '..', 'fixtures', 'eval', 'corpus');

function copyM0(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ghx-eval-pipeline-'));
  cpSync(M0, dir, { recursive: true });
  return dir;
}

test('loadCorpus reads a manifest and counts parse errors and partial last lines', () => {
  const c = loadCorpus(join(M0, 'manifest.json'), { metricVersion: 't', cache: false });
  assert.equal(c.cache, null);
  assert.equal(c.parse.files, 6);
  assert.equal(c.parse.error_lines, 1);
  assert.equal(c.parse.error_files, 1);
  assert.equal(c.parse.trailing_files, 1);
  assert.ok(c.parse.trailing_bytes > 0);
  assert.equal(c.tables.sessions.length, 2);
});

test('loadCorpus fails when a file no longer matches its manifest entry', () => {
  const dir = copyM0();
  try {
    const f = join(dir, 'projects', '-tmp-proj-beta', 'sess-0002.jsonl');
    const text = readFileSync(f, 'utf8');
    writeFileSync(
      f,
      text.replace(/[a-z]/, (ch) => (ch === 'a' ? 'b' : 'a')),
    );
    assert.throws(
      () => loadCorpus(join(dir, 'manifest.json'), { metricVersion: 't', cache: false }),
      /sha256 .* does not match/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadCorpus reads only the bytes the manifest froze: an appended file still loads the same', () => {
  const dir = copyM0();
  try {
    const before = loadCorpus(join(dir, 'manifest.json'), { metricVersion: 't', cache: false });
    const f = join(dir, 'projects', '-tmp-proj-beta', 'sess-0002.jsonl');
    writeFileSync(f, `${readFileSync(f, 'utf8')}{"type":"user","appended":true}\n`);
    const after = loadCorpus(join(dir, 'manifest.json'), { metricVersion: 't', cache: false });
    assert.deepEqual(after.tables, before.tables);
    assert.deepEqual(after.parse, before.parse);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the tables cache: a warm run returns exactly what the cold run built', () => {
  const dir = copyM0();
  try {
    const manifest = join(dir, 'manifest.json');
    const cold = loadCorpus(manifest, { metricVersion: 't' });
    assert.ok(cold.cache && !cold.cache.hit);
    assert.ok(cold.cache.dir.startsWith(join(dir, 'manifest.tables')));
    assert.ok(existsSync(join(cold.cache.dir, 'tool_calls.jsonl')));
    const warm = loadCorpus(manifest, { metricVersion: 't' });
    assert.ok(warm.cache?.hit);
    assert.deepEqual(warm.tables, cold.tables);
    assert.deepEqual(warm.parse, cold.parse);
    // A different METRIC_VERSION is a different key: a cold build again.
    const other = loadCorpus(manifest, { metricVersion: 'u' });
    assert.ok(other.cache && !other.cache.hit);
    assert.notEqual(other.cache.dir, cold.cache.dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cacheKey covers the manifest, METRIC_VERSION and the era config', () => {
  const h = 'a'.repeat(64);
  const k = cacheKey(h, '1', DEFAULT_ERA_CONFIG);
  assert.equal(k, cacheKey(h, '1', { ...DEFAULT_ERA_CONFIG }));
  assert.ok(k.startsWith('aaaaaaaaaaaa-'));
  assert.notEqual(k, cacheKey('b'.repeat(64), '1', DEFAULT_ERA_CONFIG));
  assert.notEqual(k, cacheKey(h, '2', DEFAULT_ERA_CONFIG));
  assert.notEqual(k, cacheKey(h, '1', { ...DEFAULT_ERA_CONFIG, adoptions: {} }));
});
