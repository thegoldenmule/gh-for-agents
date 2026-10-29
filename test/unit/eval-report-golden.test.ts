// Golden test: the fixture projects directory produces the checked-in report.json, report.md and summary
// (summary.txt, summary.json) byte for byte. UPDATE_GOLDEN=1 regenerates the projects, the era config, the
// reports and the summary; review the diff.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { evaluate } from '../../scripts/eval/pipeline.ts';
import { parseReport, serializeReport } from '../../scripts/eval/report/json.ts';
import { render } from '../../scripts/eval/report/markdown.ts';
import { renderSummary, serializeSummary } from '../../scripts/eval/report/summary.ts';
import { GOLDEN_ERA, goldenFiles } from '../fixtures/eval/golden/golden-corpus.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const GOLDEN = join(ROOT, 'test', 'fixtures', 'eval', 'golden');
const PROJECTS = join(GOLDEN, 'projects');
const ERA = join(GOLDEN, 'era.json');
const REPORT_JSON = join(GOLDEN, 'report.json');
const REPORT_MD = join(GOLDEN, 'report.md');
const SUMMARY_TXT = join(GOLDEN, 'summary.txt');
const SUMMARY_JSON = join(GOLDEN, 'summary.json');
const META = `${JSON.stringify({ meta: { source: 'synthetic', note: 'Golden ghx-eval corpus: synthetic transcripts, no real data.' } })}\n`;

/** Every file, listed so a change to the generator shows up here too. */
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
  const report = evaluate(PROJECTS, { era: GOLDEN_ERA });
  writeFileSync(REPORT_JSON, serializeReport(report));
  writeFileSync(REPORT_MD, render(report));
  writeFileSync(SUMMARY_TXT, renderSummary(report));
  writeFileSync(SUMMARY_JSON, serializeSummary(report));
}

if (process.env.UPDATE_GOLDEN === '1') writeGolden();

const cli = (args: string[]) =>
  spawnSync(process.execPath, [join(ROOT, 'scripts', 'eval', 'cli.ts'), ...args], { encoding: 'utf8' });

test('the golden projects on disk are what the generator builds', () => {
  const files = goldenFiles();
  assert.deepEqual(
    files.map((f) => f.path),
    FILES,
  );
  for (const f of files) assert.equal(readFileSync(join(PROJECTS, ...f.path.split('/')), 'utf8'), f.text, f.path);
  assert.deepEqual(JSON.parse(readFileSync(ERA, 'utf8')), GOLDEN_ERA);
});

test('golden: the projects produce the checked-in report.json and report.md byte for byte, every run', () => {
  const a = evaluate(PROJECTS, { era: GOLDEN_ERA });
  const b = evaluate(PROJECTS, { era: GOLDEN_ERA });
  assert.equal(serializeReport(a), readFileSync(REPORT_JSON, 'utf8'));
  assert.equal(render(a), readFileSync(REPORT_MD, 'utf8'));
  assert.equal(serializeReport(b), serializeReport(a));
});

test('golden: the command prints the same bytes, and --out writes them', () => {
  const md = cli(['--projects', PROJECTS, '--era', ERA]);
  assert.equal(md.status, 0, md.stderr);
  assert.equal(md.stdout, readFileSync(REPORT_MD, 'utf8'));
  const json = cli(['--projects', PROJECTS, '--era', ERA, '--json']);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(json.stdout, readFileSync(REPORT_JSON, 'utf8'));
  const out = mkdtempSync(join(tmpdir(), 'ghx-eval-out-'));
  try {
    const w = cli(['--projects', PROJECTS, '--era', ERA, '--out', out]);
    assert.equal(w.status, 0, w.stderr);
    assert.equal(w.stdout, '');
    assert.equal(readFileSync(join(out, 'report.json'), 'utf8'), readFileSync(REPORT_JSON, 'utf8'));
    assert.equal(readFileSync(join(out, 'report.md'), 'utf8'), readFileSync(REPORT_MD, 'utf8'));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('golden: the summary renders from report.json alone, to the checked-in bytes, every run', () => {
  const a = evaluate(PROJECTS, { era: GOLDEN_ERA });
  assert.equal(renderSummary(a), readFileSync(SUMMARY_TXT, 'utf8'));
  assert.equal(serializeSummary(a), readFileSync(SUMMARY_JSON, 'utf8'));
  const fromJson = parseReport(readFileSync(REPORT_JSON, 'utf8'));
  assert.equal(renderSummary(fromJson), readFileSync(SUMMARY_TXT, 'utf8'));
  assert.equal(renderSummary(evaluate(PROJECTS, { era: GOLDEN_ERA })), renderSummary(a));
});

test('golden: --summary prints the summary, --summary --json its data; --summary takes no --out', () => {
  const txt = cli(['--summary', '--projects', PROJECTS, '--era', ERA]);
  assert.equal(txt.status, 0, txt.stderr);
  assert.equal(txt.stdout, readFileSync(SUMMARY_TXT, 'utf8'));
  const json = cli(['--summary', '--json', '--projects', PROJECTS, '--era', ERA]);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(json.stdout, readFileSync(SUMMARY_JSON, 'utf8'));
  const out = cli(['--summary', '--projects', PROJECTS, '--out', join(tmpdir(), 'never-written')]);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /--summary prints to stdout/);
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: pnpm eval \[--summary\]/);
  assert.ok(help.stdout.indexOf('--summary  ') < help.stdout.indexOf('--projects DIR  '), '--summary is listed first');
});

test('golden: report.json says what was read and excluded, and nothing machine-specific', () => {
  const text = readFileSync(REPORT_JSON, 'utf8');
  const r = JSON.parse(text);
  assert.equal(r.input.files, 13);
  assert.deepEqual(r.era_config, GOLDEN_ERA);
  assert.equal(r.stats.seed, 42);
  assert.equal(r.stats.B, 1000);
  assert.ok(r.versions.metric);
  assert.ok(r.constants.REF_CTX);
  assert.equal(r.excluded.synthetic_records, 1);
  assert.equal(r.excluded.parse_errors.lines, 1);
  assert.equal(r.excluded.parse_errors.partial_last_line.files, 1);
  assert.equal(r.excluded.dev_projects.sessions, 1);
  assert.ok(r.excluded.unmatched_files >= 1);
  assert.doesNotMatch(text, /\/Users\/|\/home\/|\/tmp\/|\/private\//);
});
