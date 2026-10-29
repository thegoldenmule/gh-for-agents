// ghx-eval: reading a projects directory in place (scripts/eval/model/read.ts, scripts/eval/pipeline.ts) and
// the command line, over the golden fixture projects and temp copies of them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { comparePaths, isSessionFile, parseJsonl, walkProjects } from '../../scripts/eval/model/read.ts';
import { defaultProjectsDir, loadProjects } from '../../scripts/eval/pipeline.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const GOLDEN = join(ROOT, 'test', 'fixtures', 'eval', 'golden');
const PROJECTS = join(GOLDEN, 'projects');
const WIDGETS = join('-tmp-golden-widgets', 'c01d0021-0000-4000-8000-000000000000.jsonl');

const temps: string[] = [];
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ghx-eval-'));
  temps.push(d);
  return d;
};
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function projectsCopy(): string {
  const dir = join(temp(), 'projects');
  cpSync(PROJECTS, dir, { recursive: true });
  return dir;
}

// --- JSONL ---

test('parseJsonl: byte offsets across multibyte text, last-newline stop, trailing bytes', () => {
  const text = '{"a":"é✓"}\n{"b":2}\n{"c":';
  const { entries, stats } = parseJsonl(text);
  const first = Buffer.byteLength('{"a":"é✓"}\n');
  assert.deepEqual(
    entries.map((e) => [e.ok, e.offset, e.next, e.index]),
    [
      [true, 0, first, 0],
      [true, first, first + 8, 1],
    ],
  );
  assert.deepEqual(entries[0]!.record, { a: 'é✓' });
  assert.equal(stats.end, first + 8);
  assert.equal(stats.trailing, Buffer.byteLength('{"c":'));
  assert.equal(parseJsonl('{"x":1}').entries.length, 0, 'no newline, no line');
  assert.deepEqual(parseJsonl(Buffer.from(text)), { entries, stats }, 'a Buffer parses like its text');
});

test('parseJsonl: a malformed line is returned as an error and counted; blank lines skipped; CR stripped', () => {
  const { entries, stats } = parseJsonl('{"a":1}\r\nnot json\n\n   \n{"b":2}\n');
  assert.deepEqual(
    entries.map((e) => [e.ok, e.line]),
    [
      [true, '{"a":1}'],
      [false, 'not json'],
      [true, '{"b":2}'],
    ],
  );
  const err = entries[1]!;
  assert.ok(!err.ok && err.error.length > 0 && err.record === undefined);
  assert.deepEqual([stats.lines, stats.records, stats.errors, stats.blank], [5, 2, 1, 2]);
});

// --- files ---

test('paths sort by UTF-8 bytes, not UTF-16 code units or locale', () => {
  const paths = ['b', '\u{1F600}', 'B', '｡', 'a', 'é'];
  assert.deepEqual([...paths].sort(comparePaths), ['B', 'a', 'b', 'é', '｡', '\u{1F600}']);
});

test('isSessionFile: transcripts, meta and skill-fork files only', () => {
  for (const n of ['s.jsonl', 'agent-x.meta.json', 'agent-x.forked-skill.json', 'agent-x.forked-skill.marker.json']) {
    assert.ok(isSessionFile(n), n);
  }
  for (const n of ['toolu-0001.txt', '_meta.json', 'sessions-index.json', 'x.json']) assert.ok(!isSessionFile(n), n);
});

test('walkProjects: session files in path order, everything else counted apart', () => {
  const { files, unmatched } = walkProjects(PROJECTS);
  const paths = files.map((f) => f.path);
  assert.deepEqual(paths, [...paths].sort(comparePaths));
  assert.equal(files.length, 13);
  assert.ok(paths.every((p) => isSessionFile(p.split('/').at(-1) as string)));
  assert.ok(unmatched.some((f) => f.path.endsWith('tool-results/toolu_persisted.txt')));
  assert.throws(() => walkProjects(join(temp(), 'missing')), /ENOENT/);
});

test('defaultProjectsDir: CLAUDE_CONFIG_DIR, else ~/.claude', () => {
  assert.equal(defaultProjectsDir({ CLAUDE_CONFIG_DIR: '/x/cfg' }), join('/x/cfg', 'projects'));
  assert.ok(defaultProjectsDir({}).endsWith(join('.claude', 'projects')));
});

// --- loadProjects ---

test('loadProjects counts files, bytes, parse errors, partial last lines and unread files', () => {
  const { tables, parse } = loadProjects(PROJECTS);
  assert.equal(parse.files, 13);
  assert.equal(parse.error_lines, 1);
  assert.equal(parse.error_files, 1);
  assert.equal(parse.trailing_files, 1);
  assert.ok(parse.trailing_bytes > 0);
  assert.equal(parse.unmatched_files, walkProjects(PROJECTS).unmatched.length);
  assert.equal(parse.outside_sessions, 0);
  assert.ok(parse.bytes > 0);
  assert.equal(tables.sessions.length, 9);
});

test('loadProjects reads a live file to its last newline: a half-written line changes nothing until it ends', () => {
  const dir = projectsCopy();
  const before = loadProjects(dir);
  appendFileSync(join(dir, WIDGETS), '{"type":"user","message":{"role":"user","content":"hal');
  const partial = loadProjects(dir);
  assert.deepEqual(partial.tables, before.tables);
  assert.equal(partial.parse.bytes, before.parse.bytes);
  assert.equal(partial.parse.trailing_files, before.parse.trailing_files + 1);
  appendFileSync(join(dir, WIDGETS), 'f"}}\n');
  const done = loadProjects(dir);
  assert.ok(done.parse.bytes > before.parse.bytes);
  assert.equal(done.parse.trailing_files, before.parse.trailing_files);
});

// --- cli ---

const cli = (args: string[]) =>
  spawnSync(process.execPath, [join(ROOT, 'scripts', 'eval', 'cli.ts'), ...args], { encoding: 'utf8' });

test('cli: --help, unknown flags and a missing projects directory', () => {
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--projects DIR[\s\S]*--out DIR[\s\S]*--json/);
  const unknown = cli(['--nope']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown option '--nope'[\s\S]*Usage/);
  const missing = cli(['--projects', join(temp(), 'missing')]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /is not a directory/);
});
