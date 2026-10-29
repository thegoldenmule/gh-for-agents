// Determinism 7: the golden corpus produces the checked-in report.json and report.md byte for byte.
// UPDATE_GOLDEN=1 regenerates the corpus, its manifest, the era config and both reports; review the diff.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { readManifest, writeManifest } from '../../scripts/eval/corpus/manifest.ts';
import { snapshot } from '../../scripts/eval/corpus/snapshot.ts';
import { observe } from '../../scripts/eval/pipeline.ts';
import { serializeReport } from '../../scripts/eval/report/json.ts';
import { render } from '../../scripts/eval/report/markdown.ts';
import { GOLDEN_ERA, goldenFiles } from '../fixtures/eval/golden/golden-corpus.ts';

const GOLDEN = join(import.meta.dirname, '..', 'fixtures', 'eval', 'golden');
const PROJECTS = join(GOLDEN, 'projects');
const MANIFEST = join(GOLDEN, 'manifest.json');
const ERA = join(GOLDEN, 'era.json');
const REPORT_JSON = join(GOLDEN, 'report.json');
const REPORT_MD = join(GOLDEN, 'report.md');
/** A far-future snapshot instant: nothing is "recent", and the report's only timestamp is this one. */
const NOW = new Date('2100-01-01T00:00:00.000Z');
const META = `${JSON.stringify({ meta: { source: 'synthetic', note: 'Golden ghx-eval corpus: synthetic transcripts, no real data.' } })}\n`;

/** Every corpus file, listed so a change to the generator shows up here too. */
const FILES = [
  '-tmp-golden-acme/c01d0001-0000-4000-8000-000000000000.jsonl',
  '-tmp-golden-acme/c01d0001-0000-4000-8000-000000000000/tool-results/toolu_persisted.txt',
  '-tmp-golden-acme/c01d0002-0000-4000-8000-000000000000.jsonl',
  '-tmp-golden-acme/c01d0002-0000-4000-8000-000000000000/subagents/agent-a0000000000000021.jsonl',
  '-tmp-golden-acme/c01d0002-0000-4000-8000-000000000000/subagents/agent-a0000000000000021.meta.json',
  '-tmp-golden-acme/c01d0003-0000-4000-8000-000000000000.jsonl',
  '-tmp-golden-acme/c01d0004-0000-4000-8000-000000000000.jsonl',
  '-tmp-golden-acme/c01d0011-0000-4000-8000-000000000000.jsonl',
  '-tmp-golden-acme/c01d0012-0000-4000-8000-000000000000.jsonl',
  '-tmp-golden-acme/c01d0012-0000-4000-8000-000000000000/subagents/agent-a0000000000000042.jsonl',
  '-tmp-golden-acme/c01d0012-0000-4000-8000-000000000000/subagents/agent-a0000000000000042.meta.json',
  '-tmp-golden-acme/c01d0013-0000-4000-8000-000000000000.jsonl',
  '-tmp-golden-gh-for-agents/c01d0031-0000-4000-8000-000000000000.jsonl',
  '-tmp-golden-widgets/c01d0021-0000-4000-8000-000000000000.jsonl',
];

const update = process.env.UPDATE_GOLDEN === '1';

function writeGolden(): void {
  rmSync(PROJECTS, { recursive: true, force: true });
  const dirs = new Set<string>();
  for (const f of goldenFiles()) {
    const p = join(PROJECTS, ...f.path.split('/'));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.text);
    dirs.add(dirname(p));
  }
  for (const d of dirs) writeFileSync(join(d, '_meta.json'), META);
  writeFileSync(join(GOLDEN, '_meta.json'), META);
  writeFileSync(ERA, `${JSON.stringify(GOLDEN_ERA, null, 2)}\n`);
  writeManifest(MANIFEST, snapshot({ root: PROJECTS, now: NOW }));
  const { report } = observe(MANIFEST, { era: GOLDEN_ERA, cache: false });
  writeFileSync(REPORT_JSON, serializeReport(report));
  writeFileSync(REPORT_MD, render(report));
}

if (update) writeGolden();

test('the golden corpus on disk is what the generator builds', () => {
  const files = goldenFiles();
  assert.deepEqual(
    files.map((f) => f.path),
    FILES,
  );
  for (const f of files) assert.equal(readFileSync(join(PROJECTS, ...f.path.split('/')), 'utf8'), f.text, f.path);
  assert.deepEqual(JSON.parse(readFileSync(ERA, 'utf8')), GOLDEN_ERA);
});

test('the golden manifest matches a fresh snapshot (mtime aside) and excludes the persisted result', () => {
  const { manifest } = readManifest(MANIFEST);
  const fresh = snapshot({ root: PROJECTS, now: NOW });
  assert.equal(manifest.hash, fresh.hash);
  assert.deepEqual(
    manifest.files.map((f) => [f.path, f.size, f.sha256]),
    fresh.files.map((f) => [f.path, f.size, f.sha256]),
  );
  assert.equal(manifest.createdAt, NOW.toISOString());
  assert.ok(!manifest.files.some((f) => f.path.endsWith('toolu_persisted.txt')));
  assert.ok(manifest.excluded.unmatched.files >= 1);
});

test('golden: the corpus produces the checked-in report.json and report.md byte for byte', () => {
  const { report } = observe(MANIFEST, { era: GOLDEN_ERA, cache: false });
  assert.equal(serializeReport(report), readFileSync(REPORT_JSON, 'utf8'));
  assert.equal(render(report), readFileSync(REPORT_MD, 'utf8'));
});

test('golden: two runs are byte-identical, and a warm tables cache changes nothing', () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'ghx-eval-golden-'));
  try {
    const a = observe(MANIFEST, { era: GOLDEN_ERA, cache: false });
    const cold = observe(MANIFEST, { era: GOLDEN_ERA, cacheRoot });
    const warm = observe(MANIFEST, { era: GOLDEN_ERA, cacheRoot });
    assert.equal(cold.corpus.cache?.hit, false);
    assert.equal(warm.corpus.cache?.hit, true);
    const text = serializeReport(a.report);
    assert.equal(serializeReport(cold.report), text);
    assert.equal(serializeReport(warm.report), text);
    assert.equal(render(warm.report), render(a.report));
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('golden: the observe and report commands write the same bytes', async () => {
  const { run: observeCmd } = await import('../../scripts/eval/commands/observe.ts');
  const { run: reportCmd } = await import('../../scripts/eval/commands/report.ts');
  const out = mkdtempSync(join(tmpdir(), 'ghx-eval-observe-'));
  const write = process.stdout.write;
  const err = process.stderr.write;
  let printed = '';
  process.stdout.write = ((s: string) => {
    printed += s;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    assert.equal(await observeCmd(['--manifest', MANIFEST, '--era', ERA, '--out', out, '--no-cache']), 0);
    assert.equal(readFileSync(join(out, 'report.json'), 'utf8'), readFileSync(REPORT_JSON, 'utf8'));
    assert.equal(readFileSync(join(out, 'report.md'), 'utf8'), readFileSync(REPORT_MD, 'utf8'));
    assert.equal(JSON.parse(printed).manifest, readManifest(MANIFEST).manifest.hash);
    rmSync(join(out, 'report.md'));
    assert.equal(await reportCmd(['--in', join(out, 'report.json')]), 0);
    assert.equal(readFileSync(join(out, 'report.md'), 'utf8'), readFileSync(REPORT_MD, 'utf8'));
    printed = '';
    assert.equal(await reportCmd(['--in', join(out, 'report.json'), '--baseline', REPORT_JSON, '--out', '-']), 0);
    assert.match(printed, /no definition changes/);
  } finally {
    process.stdout.write = write;
    process.stderr.write = err;
    rmSync(out, { recursive: true, force: true });
  }
  assert.ok(existsSync(REPORT_MD));
});

test('golden: report.json records how to reproduce it, and nothing machine-specific', () => {
  const text = readFileSync(REPORT_JSON, 'utf8');
  const r = JSON.parse(text);
  assert.equal(r.manifest.hash, readManifest(MANIFEST).manifest.hash);
  assert.equal(r.manifest.createdAt, NOW.toISOString());
  assert.deepEqual(r.era_config, GOLDEN_ERA);
  assert.equal(r.stats.seed, 42);
  assert.equal(r.stats.B, 1000);
  assert.ok(r.versions.metric);
  assert.ok(r.constants.REF_CTX);
  assert.equal(r.excluded.synthetic_records, 1);
  assert.equal(r.excluded.parse_errors.lines, 1);
  assert.equal(r.excluded.parse_errors.partial_last_line.files, 1);
  assert.equal(r.excluded.dev_projects.sessions, 1);
  assert.doesNotMatch(text, /\/Users\/|\/home\//);
});
